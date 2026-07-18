import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const config = {
  targetDate: process.env.TARGET_DATE || '2026/09/18',
  packageUrl: process.env.PACKAGE_URL || 'https://www.ogasawarakaiun.co.jp/rsys/s5002packagelist.php',
  shipUrl: process.env.SHIP_URL || 'https://www.ogasawarakaiun.co.jp/rsys/s0102ticketlist.php',
  discordWebhook: process.env.DISCORD_WEBHOOK_URL || '',
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  testNotification: String(process.env.TEST_NOTIFICATION).toLowerCase() === 'true',
};

const STATE_FILE = 'state.json';
const DEBUG_DIR = 'debug';
const AVAILABLE_RE = /(?:^|\s)(?:○|◯|△)(?:\s|$)|空席あり|空きあり|予約可|受付中/u;
const UNAVAILABLE_RE = /(?:^|\s)(?:×|✕|―|-)(?:\s|$)|満席|空席なし|受付終了|受付停止/u;

await fs.mkdir(DEBUG_DIR, { recursive: true });

async function readState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
  } catch {
    return {
      package: { available: false, details: [] },
      ship: { available: false, details: [] },
      lastChecked: null,
    };
  }
}

function normalize(text = '') {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n/g, '\n')
    .trim();
}

function dateVariants(targetDate) {
  const [year, month, day] = targetDate.split('/');
  const m = String(Number(month));
  const d = String(Number(day));
  return [
    targetDate,
    `${year}-${month}-${day}`,
    `${month}/${day}`,
    `${m}/${d}`,
    `${m}/${d}発`,
  ];
}

async function selectTargetDate(page, targetDate) {
  const variants = dateVariants(targetDate);
  const selects = page.locator('select');

  for (let i = 0; i < await selects.count(); i++) {
    const select = selects.nth(i);
    const options = await select.locator('option').allTextContents().catch(() => []);
    const index = options.findIndex((text) => variants.some((v) => normalize(text).includes(v)));
    if (index < 0) continue;

    const option = select.locator('option').nth(index);
    const value = await option.getAttribute('value');
    if (value !== null) {
      await select.selectOption(value);
    } else {
      await select.selectOption({ index });
    }
    await select.dispatchEvent('change').catch(() => {});
    await page.waitForTimeout(500);

    const selectedText = normalize(await select.locator('option:checked').innerText().catch(() => ''));
    return { ok: variants.some((v) => selectedText.includes(v)), selectedText };
  }

  return { ok: false, selectedText: '' };
}

async function clickUpdate(page) {
  const candidates = [
    'input[type="image"][alt*="更新"]',
    'input[type="image"][title*="更新"]',
    'input[type="image"][src*="update" i]',
    'input[type="submit"][value*="更新"]',
    'button:has-text("更新")',
    'a:has-text("更新")',
    'img[alt*="更新"]',
    'img[title*="更新"]',
  ];

  for (const selector of candidates) {
    const locator = page.locator(selector).first();
    if (!(await locator.count())) continue;
    if (!(await locator.isVisible().catch(() => false))) continue;

    const beforeUrl = page.url();
    const beforeBody = normalize(await page.locator('body').innerText().catch(() => ''));

    if (selector.startsWith('img')) {
      const parent = locator.locator('xpath=ancestor::a[1] | ancestor::button[1] | ancestor::form[1]');
      if (await parent.count()) {
        await parent.first().click().catch(() => locator.click());
      } else {
        await locator.click();
      }
    } else {
      await locator.click();
    }

    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1800);

    const afterBody = normalize(await page.locator('body').innerText().catch(() => ''));
    return {
      ok: page.url() !== beforeUrl || afterBody !== beforeBody,
      selector,
    };
  }

  // 更新画像の判定に失敗した場合は、日付selectを含むフォームを直接送信する。
  const dateSelect = page.locator('select').filter({ has: page.locator('option') }).first();
  if (await dateSelect.count()) {
    const form = dateSelect.locator('xpath=ancestor::form[1]');
    if (await form.count()) {
      await form.evaluate((element) => element.requestSubmit ? element.requestSubmit() : element.submit());
      await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(1800);
      return { ok: true, selector: 'form.requestSubmit()' };
    }
  }

  return { ok: false, selector: null };
}

async function extractAvailabilityDom(page, targetDate, mode) {
  return page.evaluate(({ targetDate, mode }) => {
    const normalize = (value = '') => String(value)
      .replace(/\u00a0/g, ' ')
      .replace(/[\s　]+/g, ' ')
      .trim();
    const compact = (value = '') => normalize(value).replace(/[\s　]+/g, '');
    const halfWidth = (value = '') => value
      .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/２/g, '2');

    const [, mm, dd] = targetDate.split('/');
    const dateTokens = [targetDate, `${Number(mm)}/${Number(dd)}`, `${Number(mm)}/${Number(dd)}発`]
      .map(compact);

    function cellInfo(cell) {
      const imageAttrs = [...cell.querySelectorAll('img, input[type="image"]')]
        .flatMap((el) => [
          el.getAttribute('alt'),
          el.getAttribute('title'),
          el.getAttribute('src'),
          el.getAttribute('aria-label'),
        ])
        .filter(Boolean)
        .join(' ');
      const text = normalize(`${cell.innerText || ''} ${cell.textContent || ''} ${imageAttrs}`);
      const html = cell.innerHTML || '';
      return { text, html };
    }

    function directRows(table) {
      return [...table.rows].filter((row) => row.closest('table') === table);
    }

    function cells(row) {
      return [...row.cells].map(cellInfo);
    }

    function containsDate(value) {
      const c = compact(value);
      return dateTokens.some((token) => c.includes(token));
    }

    function symbol(info) {
      const raw = `${info.text} ${info.html}`;
      if (/[○◯]/u.test(raw)) return '○';
      if (/△/u.test(raw)) return '△';
      if (/[×✕✖]/u.test(raw)) return '×';
      if (/空席あり|空きあり|予約可|受付中/u.test(raw)) return '○';
      if (/満席|空席なし|受付終了|受付停止/u.test(raw)) return '×';

      const lower = raw.toLowerCase();
      // 画像ファイル名で記号を表している場合にも対応する。
      if (/(?:maru|circle|available|vacant|ok|yes)[^a-z0-9]?/i.test(lower)) return '○';
      if (/(?:sankaku|triangle|few|limited)/i.test(lower)) return '△';
      if (/(?:batsu|cross|unavailable|full|ng|no)[^a-z0-9]?/i.test(lower)) return '×';
      return normalize(info.text);
    }

    const tables = [...document.querySelectorAll('table')];

    if (mode === 'ship') {
      for (const table of tables) {
        const rows = directRows(table);
        let header = null;
        let idxWashitsu = -1;
        let idxShindai = -1;

        for (const row of rows) {
          const cs = cells(row);
          const normalizedCells = cs.map((c) => halfWidth(compact(c.text)));
          const w = normalizedCells.findIndex((t) => t.includes('2等和室'));
          const b = normalizedCells.findIndex((t) => t.includes('2等寝台'));
          if (w >= 0 && b >= 0) {
            header = row;
            idxWashitsu = w;
            idxShindai = b;
            break;
          }
        }
        if (!header) continue;

        const headerIndex = rows.indexOf(header);
        for (const row of rows.slice(headerIndex + 1)) {
          const cs = cells(row);
          const rowText = cs.map((c) => c.text).join(' ');
          if (!containsDate(rowText) || !/東京|Tokyo/u.test(rowText)) continue;

          const observed = [
            { room: '2等和室', status: symbol(cs[idxWashitsu] || { text: '', html: '' }) },
            { room: '2等寝台', status: symbol(cs[idxShindai] || { text: '', html: '' }) },
          ];
          const availableItems = observed.filter((x) => x.status === '○' || x.status === '△');
          return {
            available: availableItems.length > 0,
            details: availableItems.map((x) => `${x.room}：${x.status}`),
            foundTargetRow: true,
            observed,
            debug: { tableCount: tables.length, rowText },
          };
        }
      }
      return {
        available: false,
        details: [],
        foundTargetRow: false,
        observed: [],
        debug: {
          tableCount: tables.length,
          matchingTexts: [...document.querySelectorAll('tr')]
            .map((r) => normalize(r.innerText || r.textContent || ''))
            .filter((t) => /9\/18|２等和室|2等和室/u.test(t))
            .slice(0, 20),
        },
      };
    }

    const details = [];
    const observed = [];
    let foundTargetColumn = false;

    for (const table of tables) {
      const rows = directRows(table);
      let headerIndex = -1;
      let targetColumn = -1;

      for (let i = 0; i < rows.length; i += 1) {
        const cs = cells(rows[i]);
        const rowText = cs.map((c) => c.text).join(' ');
        if (!/宿名|Accommodation/u.test(rowText) || !/部屋タイプ|Room type/u.test(rowText)) continue;
        const dateIndex = cs.findIndex((c) => containsDate(c.text));
        if (dateIndex >= 0) {
          headerIndex = i;
          targetColumn = dateIndex;
          foundTargetColumn = true;
          break;
        }
      }
      if (headerIndex < 0) continue;

      for (const row of rows.slice(headerIndex + 1)) {
        const cs = cells(row);
        if (cs.length <= targetColumn) continue;
        const rowText = cs.map((c) => c.text).join(' ');
        if (/宿名|Accommodation/u.test(rowText) && /部屋タイプ|Room type/u.test(rowText)) break;

        const status = symbol(cs[targetColumn]);
        if (!['○', '△', '×'].includes(status)) continue;
        const accommodation = normalize(cs[0]?.text || '');
        const roomType = normalize(cs[1]?.text || '');
        observed.push({ accommodation, roomType, status });
        if (status === '○' || status === '△') {
          details.push(`${accommodation}${roomType ? ` / ${roomType}` : ''}：${status}`);
        }
      }
    }

    return {
      available: details.length > 0,
      details,
      foundTargetColumn,
      observed,
      debug: {
        tableCount: tables.length,
        matchingTexts: [...document.querySelectorAll('tr')]
          .map((r) => normalize(r.innerText || r.textContent || ''))
          .filter((t) => /9\/18発|宿名|部屋タイプ/u.test(t))
          .slice(0, 30),
      },
    };
  }, { targetDate, mode });
}

async function sendDiscord(message) {
  if (!config.discordWebhook) return false;
  const response = await fetch(config.discordWebhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'おがまる空き通知', content: message }),
  });
  if (!response.ok) throw new Error(`Discord通知失敗: ${response.status} ${await response.text()}`);
  return true;
}

async function sendTelegram(message) {
  if (!config.telegramToken || !config.telegramChatId) return false;
  const response = await fetch(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: config.telegramChatId,
      text: message,
      disable_web_page_preview: true,
    }),
  });
  if (!response.ok) throw new Error(`Telegram通知失敗: ${response.status} ${await response.text()}`);
  return true;
}

async function notify(message) {
  const results = await Promise.all([sendDiscord(message), sendTelegram(message)]);
  if (!results.some(Boolean)) throw new Error('通知先が未設定です。GitHub Secretsを設定してください。');
}

const previous = await readState();
const packageResult = await inspect('package', config.packageUrl, parsePackage);
const shipResult = await inspect('ship', config.shipUrl, parseShip);
const now = new Date().toISOString();

console.log(JSON.stringify({ parserVersion: 'dom-v3-20260718', packageResult, shipResult }, null, 2));

if (config.testNotification) {
  await notify(
    `✅ おがまる空き監視のテスト通知です。\n` +
    `対象日：${config.targetDate}\n` +
    `船ページ：${shipResult.error ? `確認失敗（${shipResult.error}）` : '確認成功'}\n` +
    `パックページ：${packageResult.error ? `確認失敗（${packageResult.error}）` : '確認成功'}`,
  );
}

const messages = [];
if (!packageResult.error && packageResult.available && !previous.package?.available) {
  messages.push(
    `🚨【おがまるパックに空き表示】\n` +
    `対象：${config.targetDate} 東京発\n` +
    `${packageResult.details.join('\n')}\n\n` +
    `確認：${config.packageUrl}\n` +
    `電話：03-6381-5499（平日10:00～16:00）`,
  );
}
if (!shipResult.error && shipResult.available && !previous.ship?.available) {
  messages.push(
    `🚢【おがさわら丸 2等客室に空き表示】\n` +
    `対象：${config.targetDate} 東京発→父島\n` +
    `${shipResult.details.join('\n')}\n\n` +
    `予約：${config.shipUrl}\n` +
    `※2等客室の表示にはレディースルーム分が含まれる場合があります。`,
  );
}
for (const message of messages) await notify(message);

const nextState = {
  package: packageResult.error
    ? previous.package
    : { available: packageResult.available, details: packageResult.details },
  ship: shipResult.error
    ? previous.ship
    : { available: shipResult.available, details: shipResult.details },
  lastChecked: now,
  lastErrors: { package: packageResult.error, ship: shipResult.error },
};
await fs.writeFile(STATE_FILE, `${JSON.stringify(nextState, null, 2)}\n`, 'utf8');

if (packageResult.error || shipResult.error) {
  console.warn('一部の確認に失敗しました。debugアーティファクトを確認してください。');
  process.exitCode = 1;
}

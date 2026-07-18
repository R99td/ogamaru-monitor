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

async function collectTables(page) {
  return page.locator('table').evaluateAll((tables) => tables.map((table) => {
    const rows = [...table.querySelectorAll('tr')].map((row) => {
      const expanded = [];
      const cells = [...row.querySelectorAll(':scope > th, :scope > td')];

      for (const cell of cells) {
        const imageText = [...cell.querySelectorAll('img')]
          .map((img) => img.getAttribute('alt') || img.getAttribute('title') || '')
          .filter(Boolean)
          .join(' ');
        const text = `${cell.innerText || cell.textContent || ''} ${imageText}`
          .replace(/\s+/g, ' ')
          .trim();
        const colspan = Math.max(1, Number.parseInt(cell.getAttribute('colspan') || '1', 10) || 1);
        expanded.push(text);
        for (let i = 1; i < colspan; i += 1) expanded.push('');
      }
      return expanded;
    }).filter((row) => row.some(Boolean));
    return rows;
  }).filter((rows) => rows.length));
}

function compact(text = '') {
  return normalize(text).replace(/[\s　]+/g, '');
}

function includesAny(text, variants) {
  const value = compact(text);
  return variants.some((variant) => value.includes(compact(variant)));
}

function isAvailableStatus(text) {
  const value = compact(text);
  return /○|◯|△|空席あり|空きあり|予約可|受付中/u.test(value);
}

function isUnavailableStatus(text) {
  const value = compact(text);
  return /×|✕|✖|―|満席|空席なし|受付終了|受付停止/u.test(value);
}

function isTargetDateCell(text, targetDate) {
  const [, month, day] = targetDate.split('/');
  const m = String(Number(month));
  const d = String(Number(day));
  const value = compact(text);
  return [targetDate, `${month}/${day}`, `${m}/${d}`, `${m}/${d}発`]
    .some((variant) => value.includes(compact(variant)));
}

function parseShip(tables, targetDate) {
  const roomDefinitions = [
    { name: '2等和室', variants: ['2等和室', '２等和室'] },
    { name: '2等寝台', variants: ['2等寝台', '２等寝台'] },
  ];

  for (const rows of tables) {
    for (let headerIndex = 0; headerIndex < rows.length; headerIndex += 1) {
      const header = rows[headerIndex];
      const roomColumns = roomDefinitions.map(({ name, variants }) => ({
        name,
        index: header.findIndex((cell) => includesAny(cell, variants)),
      }));
      if (roomColumns.some(({ index }) => index < 0)) continue;

      const targetRow = rows.slice(headerIndex + 1).find((row) => {
        const rowText = row.join(' ');
        return row.some((cell) => isTargetDateCell(cell, targetDate)) && /東京|Tokyo/u.test(rowText);
      });
      if (!targetRow) continue;

      const observed = roomColumns.map(({ name, index }) => ({
        room: name,
        status: normalize(targetRow[index] || ''),
      }));
      const available = observed.filter(({ status }) => isAvailableStatus(status));

      return {
        available: available.length > 0,
        details: available.map(({ room, status }) => `${room}：${status || '○'}`),
        foundTargetRow: true,
        observed,
      };
    }
  }

  return { available: false, details: [], foundTargetRow: false, observed: [] };
}

function parsePackage(tables, targetDate) {
  const details = [];
  const observed = [];
  let foundTargetColumn = false;

  for (const rows of tables) {
    for (let headerIndex = 0; headerIndex < rows.length; headerIndex += 1) {
      const header = rows[headerIndex];
      const headerText = header.join(' ');
      if (!/宿名|Accommodation/u.test(headerText) || !/部屋タイプ|Room type/u.test(headerText)) continue;

      const targetColumn = header.findIndex((cell) => isTargetDateCell(cell, targetDate));
      if (targetColumn < 0) continue;
      foundTargetColumn = true;

      for (const row of rows.slice(headerIndex + 1)) {
        if (row.length <= targetColumn) continue;
        // 次の地域テーブルの見出しに到達したら、このテーブル内の処理を終了する。
        const rowText = row.join(' ');
        if (/宿名|Accommodation/u.test(rowText) && /部屋タイプ|Room type/u.test(rowText)) break;

        const status = normalize(row[targetColumn] || '');
        if (!isAvailableStatus(status) && !isUnavailableStatus(status)) continue;

        const accommodation = normalize(row[0] || '');
        const roomType = normalize(row[1] || '');
        observed.push({ accommodation, roomType, status });
        if (isAvailableStatus(status)) {
          details.push(`${accommodation}${roomType ? ` / ${roomType}` : ''}：${status || '○'}`);
        }
      }
    }
  }

  return {
    available: details.length > 0,
    details: [...new Set(details)].slice(0, 50),
    foundTargetColumn,
    observed,
  };
}

async function inspect(kind, url, parser) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: 'ja-JP',
    viewport: { width: 1500, height: 1000 },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130 Safari/537.36 OgamaruAvailabilityMonitor/2.0',
  });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1200);

    const selected = await selectTargetDate(page, config.targetDate);
    const updated = selected.ok ? await clickUpdate(page) : { ok: false, selector: null };
    await page.waitForTimeout(1500);

    const tables = await collectTables(page);
    const bodyText = normalize(await page.locator('body').innerText());
    const result = parser(tables, config.targetDate);

    await page.screenshot({ path: path.join(DEBUG_DIR, `${kind}.png`), fullPage: true });
    await fs.writeFile(path.join(DEBUG_DIR, `${kind}.txt`), bodyText, 'utf8');
    await fs.writeFile(
      path.join(DEBUG_DIR, `${kind}.json`),
      JSON.stringify({ selected, updated, result, pageUrl: page.url() }, null, 2),
      'utf8',
    );

    const validResult = kind === 'ship' ? result.foundTargetRow : result.foundTargetColumn;
    const error = !selected.ok
      ? `対象日を選択できませんでした。選択値: ${selected.selectedText || '(なし)'}`
      : !updated.ok
        ? '「更新」を実行できませんでした。'
        : !validResult
          ? '更新後の表から対象日を特定できませんでした。'
          : null;

    return {
      ...result,
      selectedDate: selected.ok,
      selectedDateText: selected.selectedText,
      clickedUpdate: updated.ok,
      updateSelector: updated.selector,
      pageUrl: page.url(),
      error,
    };
  } catch (error) {
    await page.screenshot({ path: path.join(DEBUG_DIR, `${kind}-error.png`), fullPage: true }).catch(() => {});
    return { available: false, details: [], error: String(error) };
  } finally {
    await browser.close();
  }
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

console.log(JSON.stringify({ packageResult, shipResult }, null, 2));

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

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

    function cellInfo(cell) {
      const media = [...cell.querySelectorAll('img, input[type="image"]')].map((el) => ({
        alt: el.getAttribute('alt') || '',
        title: el.getAttribute('title') || '',
        src: el.getAttribute('src') || '',
        aria: el.getAttribute('aria-label') || '',
      }));
      const attrs = media.flatMap((x) => [x.alt, x.title, x.src, x.aria]).filter(Boolean).join(' ');
      return {
        text: normalize(`${cell.innerText || ''} ${cell.textContent || ''} ${attrs}`),
        html: cell.innerHTML || '',
        media,
      };
    }

    function symbol(info) {
      const raw = `${info?.text || ''} ${info?.html || ''}`;
      if (/[○◯]/u.test(raw)) return '○';
      if (/△/u.test(raw)) return '△';
      if (/[×✕✖]/u.test(raw)) return '×';
      if (/空席あり|空きあり|予約可|受付中/u.test(raw)) return '○';
      if (/満席|空席なし|受付終了|受付停止/u.test(raw)) return '×';

      const lower = raw.toLowerCase();
      if (/(?:maru|circle|available|vacant|aki|ok)(?:[^a-z0-9]|$)/i.test(lower)) return '○';
      if (/(?:sankaku|triangle|few|limited)(?:[^a-z0-9]|$)/i.test(lower)) return '△';
      if (/(?:batsu|cross|unavailable|full|nashi|ng)(?:[^a-z0-9]|$)/i.test(lower)) return '×';
      return '';
    }

    const allRows = [...document.querySelectorAll('tr')].map((row, rowIndex) => ({
      rowIndex,
      cells: [...row.cells].map(cellInfo),
    }));

    if (mode === 'ship') {
      // 日付選択・更新済みの画面では、空席表のデータ行は
      // 「乗船日 + 6客室」の7セル構成。6客室すべてが○/△/×の行を抽出する。
      const candidates = allRows.filter(({ cells }) => {
        if (cells.length < 7) return false;
        const statuses = cells.slice(1, 7).map(symbol);
        return statuses.filter(Boolean).length >= 6;
      });

      // 選択した東京発便は表の先頭データ行。念のため9/18を含む行を優先する。
      const target = candidates.find(({ cells }) => /9\s*\/\s*18/.test(cells.map((c) => c.text).join(' '))) || candidates[0];
      if (!target) {
        return {
          available: false,
          details: [],
          foundTargetRow: false,
          observed: [],
          debug: {
            rowCount: allRows.length,
            rowsWithSevenCells: allRows.filter((r) => r.cells.length >= 7).slice(0, 15).map((r) => ({
              rowIndex: r.rowIndex,
              cellCount: r.cells.length,
              texts: r.cells.map((c) => c.text).slice(0, 7),
              symbols: r.cells.map(symbol).slice(0, 7),
            })),
          },
        };
      }

      const observed = [
        { room: '2等和室', status: symbol(target.cells[1]) },
        { room: '2等寝台', status: symbol(target.cells[2]) },
      ];
      const availableItems = observed.filter((x) => x.status === '○' || x.status === '△');
      return {
        available: availableItems.length > 0,
        details: availableItems.map((x) => `${x.room}：${x.status}`),
        foundTargetRow: observed.every((x) => ['○', '△', '×'].includes(x.status)),
        observed,
        debug: {
          rowIndex: target.rowIndex,
          candidateCount: candidates.length,
          targetTexts: target.cells.map((c) => c.text),
          targetSymbols: target.cells.map(symbol),
        },
      };
    }

    // パック画面は対象日を選択して更新すると、各宿泊施設行の3列目以降に
    // 対象日の○/×が1つだけ表示される。ヘッダー文字に依存せず構造で抽出する。
    const observed = [];
    let sequence = 0;
    for (const { rowIndex, cells } of allRows) {
      if (cells.length < 3) continue;
      const statusIndex = cells.findIndex((c, index) => index >= 2 && ['○', '△', '×'].includes(symbol(c)));
      if (statusIndex < 0) continue;

      sequence += 1;
      const accommodation = normalize(cells[0]?.text || '') || `宿泊施設 ${sequence}`;
      const roomType = normalize(cells[1]?.text || '') || `部屋タイプ ${sequence}`;
      observed.push({
        accommodation,
        roomType,
        status: symbol(cells[statusIndex]),
        rowIndex,
        statusColumn: statusIndex,
      });
    }

    const details = observed
      .filter((x) => x.status === '○' || x.status === '△')
      .map((x) => `${x.accommodation} / ${x.roomType}：${x.status}`);

    return {
      available: details.length > 0,
      details,
      foundTargetColumn: observed.length > 0,
      observed: observed.map(({ rowIndex, statusColumn, ...rest }) => rest),
      debug: {
        rowCount: allRows.length,
        detectedRows: observed.length,
        sample: observed.slice(0, 10),
      },
    };
  }, { targetDate, mode });
}


async function parseAcrossFrames(page, mode) {
  const frameResults = [];

  for (const frame of page.frames()) {
    try {
      const result = await extractAvailabilityDom(frame, config.targetDate, mode);
      frameResults.push({
        frameUrl: frame.url(),
        frameName: frame.name(),
        result,
      });
    } catch (error) {
      frameResults.push({
        frameUrl: frame.url(),
        frameName: frame.name(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const success = frameResults.find(({ result }) =>
    mode === 'package' ? result?.foundTargetColumn : result?.foundTargetRow,
  );

  if (success) {
    return {
      ...success.result,
      debug: {
        ...(success.result.debug || {}),
        matchedFrameUrl: success.frameUrl,
        matchedFrameName: success.frameName,
        frameCount: frameResults.length,
      },
    };
  }

  const best = frameResults
    .filter(({ result }) => result)
    .sort((a, b) => {
      const score = (entry) => {
        const debug = entry.result?.debug || {};
        return Number(debug.detectedRows || 0)
          + Number(debug.candidateCount || 0)
          + Number(debug.rowCount || 0) / 1000;
      };
      return score(b) - score(a);
    })[0];

  const fallback = best?.result || {
    available: false,
    details: [],
    observed: [],
    ...(mode === 'package' ? { foundTargetColumn: false } : { foundTargetRow: false }),
  };

  return {
    ...fallback,
    debug: {
      ...(fallback.debug || {}),
      frameCount: frameResults.length,
      frames: frameResults.map(({ frameUrl, frameName, result, error }) => ({
        frameUrl,
        frameName,
        error: error || null,
        rowCount: result?.debug?.rowCount ?? null,
        detectedRows: result?.debug?.detectedRows ?? null,
        candidateCount: result?.debug?.candidateCount ?? null,
        found: mode === 'package'
          ? Boolean(result?.foundTargetColumn)
          : Boolean(result?.foundTargetRow),
      })),
    },
  };
}

async function parsePackage(page) {
  return parseAcrossFrames(page, 'package');
}

async function parseShip(page) {
  return parseAcrossFrames(page, 'ship');
}

async function inspect(name, url, parser) {
  const resultBase = {
    available: false,
    details: [],
    observed: [],
    selectedDate: false,
    selectedDateText: '',
    clickedUpdate: false,
    updateSelector: null,
    pageUrl: url,
    error: null,
  };

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo',
      viewport: { width: 1440, height: 1200 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1000);

    const selected = await selectTargetDate(page, config.targetDate);
    resultBase.selectedDate = selected.ok;
    resultBase.selectedDateText = selected.selectedText;
    if (!selected.ok) {
      throw new Error(`対象日 ${config.targetDate} を選択できませんでした。`);
    }

    const updated = await clickUpdate(page);
    resultBase.clickedUpdate = updated.ok;
    resultBase.updateSelector = updated.selector;
    if (!updated.ok) {
      throw new Error('更新ボタンを押せませんでした。');
    }

    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1200);
    resultBase.pageUrl = page.url();

    await page.screenshot({
      path: path.join(DEBUG_DIR, `${name}.png`),
      fullPage: true,
    });
    await fs.writeFile(
      path.join(DEBUG_DIR, `${name}.html`),
      await page.content(),
      'utf8',
    );
    await fs.writeFile(
      path.join(DEBUG_DIR, `${name}.txt`),
      await page.locator('body').innerText().catch(() => ''),
      'utf8',
    );

    const parsed = await parser(page);
    const merged = { ...resultBase, ...parsed, pageUrl: page.url(), error: null };

    if (name === 'package' && !merged.foundTargetColumn) {
      merged.error = '更新後の表から対象日の列を特定できませんでした。';
    }
    if (name === 'ship' && !merged.foundTargetRow) {
      merged.error = '更新後の表から対象日の行を特定できませんでした。';
    }

    return merged;
  } catch (error) {
    return {
      ...resultBase,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await browser?.close().catch(() => {});
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

console.log(JSON.stringify({ parserVersion: 'frames-v5-20260718', packageResult, shipResult }, null, 2));

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

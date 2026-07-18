import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const config = {
  targetDate: process.env.TARGET_DATE || '2026/09/18',
  packageUrl: process.env.PACKAGE_URL,
  shipUrl: process.env.SHIP_URL,
  discordWebhook: process.env.DISCORD_WEBHOOK_URL || '',
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  testNotification: String(process.env.TEST_NOTIFICATION).toLowerCase() === 'true',
};

const STATE_FILE = 'state.json';
const DEBUG_DIR = 'debug';
const AVAILABLE_RE = /(^|\s)(○|△)(\s|$)|空席あり|空きあり|予約可|受付中/;
const UNAVAILABLE_RE = /(^|\s)(×|―|-)(\s|$)|満席|空席なし|受付終了|受付停止/;

await fs.mkdir(DEBUG_DIR, { recursive: true });

async function readState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
  } catch {
    return { package: { available: false, details: [] }, ship: { available: false, details: [] }, lastChecked: null };
  }
}

function normalize(text = '') {
  return text.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n').trim();
}

async function selectTargetDate(page, targetDate) {
  const targetVariants = [targetDate, targetDate.replaceAll('/', '-'), targetDate.replace(/^\d{4}\//, '')];
  const selects = page.locator('select');
  for (let i = 0; i < await selects.count(); i++) {
    const select = selects.nth(i);
    const options = await select.locator('option').allTextContents().catch(() => []);
    const index = options.findIndex(t => targetVariants.some(v => normalize(t).includes(v)));
    if (index >= 0) {
      const option = select.locator('option').nth(index);
      const value = await option.getAttribute('value');
      if (value !== null) await select.selectOption(value);
      else await select.selectOption({ index });
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(1500);
      return true;
    }
  }
  return false;
}

async function clickLikelySearchButton(page) {
  const candidates = [
    'input[type="submit"]', 'button[type="submit"]',
    'input[value*="検索"]', 'button:has-text("検索")',
    'input[value*="空席"]', 'button:has-text("空席")',
    'input[value*="表示"]', 'button:has-text("表示")'
  ];
  for (const selector of candidates) {
    const item = page.locator(selector).first();
    if (await item.count() && await item.isVisible().catch(() => false)) {
      await Promise.all([
        page.waitForLoadState('networkidle').catch(() => {}),
        item.click().catch(() => {})
      ]);
      await page.waitForTimeout(1500);
      return true;
    }
  }
  return false;
}

async function collectTableRows(page) {
  return page.locator('tr').evaluateAll(rows => rows.map(row => {
    const cells = [...row.querySelectorAll('th,td')].map(c => (c.innerText || '').replace(/\s+/g, ' ').trim());
    return cells.filter(Boolean);
  }).filter(cells => cells.length));
}

function findTargetColumnIndexes(rows, targetDate) {
  const md = targetDate.replace(/^\d{4}\//, '').replace(/^0/, '').replace('/0', '/');
  const variants = [targetDate, targetDate.slice(5), md, md + '発'];
  const indexes = new Set();
  for (const row of rows) {
    row.forEach((cell, i) => {
      if (variants.some(v => cell.includes(v))) indexes.add(i);
    });
  }
  return [...indexes];
}

function parsePackage(rows, targetDate) {
  const indexes = findTargetColumnIndexes(rows, targetDate);
  const details = [];
  for (const row of rows) {
    const statuses = indexes.length
      ? indexes.map(i => row[i]).filter(Boolean)
      : row.filter(c => AVAILABLE_RE.test(c) || UNAVAILABLE_RE.test(c));
    const available = statuses.find(s => AVAILABLE_RE.test(s));
    if (available) {
      const labels = row.filter(c => !AVAILABLE_RE.test(c) && !UNAVAILABLE_RE.test(c));
      details.push(`${labels.slice(0, 3).join(' / ')}：${available}`);
    }
  }
  return { available: details.length > 0, details: [...new Set(details)].slice(0, 20), foundTargetColumn: indexes.length > 0 };
}

function parseShip(rows) {
  const targets = ['2等和室', '２等和室', '2等寝台', '２等寝台'];
  const details = [];
  for (const row of rows) {
    const joined = row.join(' / ');
    if (!targets.some(t => joined.includes(t))) continue;
    const status = row.find(c => AVAILABLE_RE.test(c));
    if (status) details.push(`${joined}：${status}`);
  }
  return { available: details.length > 0, details: [...new Set(details)].slice(0, 10) };
}

async function inspect(kind, url, parser) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: 'ja-JP',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130 Safari/537.36 OgamaruAvailabilityMonitor/1.0'
  });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1500);
    const selected = await selectTargetDate(page, config.targetDate);
    if (selected) await clickLikelySearchButton(page);
    const rows = await collectTableRows(page);
    const bodyText = normalize(await page.locator('body').innerText());
    await page.screenshot({ path: path.join(DEBUG_DIR, `${kind}.png`), fullPage: true });
    await fs.writeFile(path.join(DEBUG_DIR, `${kind}.txt`), bodyText, 'utf8');
    const result = parser(rows, config.targetDate);
    return { ...result, selectedDate: selected, pageUrl: page.url(), error: null };
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
    body: JSON.stringify({ username: 'おがまる空き通知', content: message })
  });
  if (!response.ok) throw new Error(`Discord通知失敗: ${response.status} ${await response.text()}`);
  return true;
}

async function sendTelegram(message) {
  if (!config.telegramToken || !config.telegramChatId) return false;
  const response = await fetch(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: config.telegramChatId, text: message, disable_web_page_preview: true })
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
  await notify(`✅ おがまる空き監視のテスト通知です。\n対象日：${config.targetDate}\nGitHub Actionsから正常に送信されました。`);
}

const messages = [];
if (!packageResult.error && packageResult.available && !previous.package?.available) {
  messages.push(`🚨【おがまるパックに空き表示】\n対象：${config.targetDate} 東京発\n${packageResult.details.join('\n')}\n\n確認：${config.packageUrl}\n電話：03-6381-5499（平日10:00～16:00）`);
}
if (!shipResult.error && shipResult.available && !previous.ship?.available) {
  messages.push(`🚢【おがさわら丸 2等客室に空き表示】\n対象：${config.targetDate} 東京発→父島\n${shipResult.details.join('\n')}\n\n予約：${config.shipUrl}\n※2等客室の表示にはレディースルーム分が含まれる場合があります。`);
}
for (const message of messages) await notify(message);

const nextState = {
  package: packageResult.error ? previous.package : { available: packageResult.available, details: packageResult.details },
  ship: shipResult.error ? previous.ship : { available: shipResult.available, details: shipResult.details },
  lastChecked: now,
  lastErrors: { package: packageResult.error, ship: shipResult.error }
};
await fs.writeFile(STATE_FILE, JSON.stringify(nextState, null, 2) + '\n', 'utf8');

if (packageResult.error || shipResult.error) {
  console.warn('一部の確認に失敗しました。debugアーティファクトを確認してください。');
}

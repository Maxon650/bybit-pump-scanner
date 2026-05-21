const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const STATE_PATH = path.join(ROOT, 'state.json');
const LOG_PATH = path.join(ROOT, 'scan.log');

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
if (process.env.TELEGRAM_BOT_TOKEN) config.telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
if (process.env.TELEGRAM_CHAT_ID) config.telegramChatId = Number(process.env.TELEGRAM_CHAT_ID);

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_PATH, line + '\n');
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          const preview = data.slice(0, 300).replace(/\s+/g, ' ');
          reject(new Error(`Bad JSON from ${url} (HTTP ${res.statusCode}): ${preview}`));
        }
      });
    }).on('error', reject);
  });
}

function httpPostJson(url, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Bad JSON: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
  const res = await httpPostJson(url, {
    chat_id: config.telegramChatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  });
  if (!res.ok) {
    throw new Error(`Telegram error: ${JSON.stringify(res)}`);
  }
}

function loadState() {
  if (!fs.existsSync(STATE_PATH)) return { alerted: {} };
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { alerted: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function formatPump(t) {
  const pct = (parseFloat(t.price24hPcnt) * 100).toFixed(1);
  const price = parseFloat(t.lastPrice);
  const high = parseFloat(t.highPrice24h);
  const low = parseFloat(t.lowPrice24h);
  const turnover = (parseFloat(t.turnover24h) / 1_000_000).toFixed(1);
  const drawdownFromHigh = ((1 - price / high) * 100).toFixed(1);

  return `<b>🚀 ${t.symbol}</b>  +${pct}%
Цена: <b>$${price}</b>
24ч: $${low} → $${high}
От максимума: -${drawdownFromHigh}%
Объём 24ч: $${turnover}M
<a href="https://www.bybit.com/trade/usdt/${t.symbol}">Открыть в Bybit</a>`;
}

async function main() {
  log('Scan started');

  const data = await httpGet('https://api.bybit.com/v5/market/tickers?category=linear');
  if (data.retCode !== 0) {
    log(`Bybit error: ${data.retMsg}`);
    return;
  }

  const threshold = config.pumpThresholdPercent / 100;
  const minTurnover = config.minTurnover24hUsd;

  const pumps = data.result.list.filter((t) => {
    const pct = parseFloat(t.price24hPcnt);
    const turnover = parseFloat(t.turnover24h);
    return pct > threshold && turnover > minTurnover;
  });

  log(`Tickers scanned: ${data.result.list.length}, qualifying pumps: ${pumps.length}`);

  const state = loadState();
  const cooldownMs = config.alertCooldownHours * 60 * 60 * 1000;
  const now = Date.now();

  const fresh = pumps.filter((t) => {
    const last = state.alerted[t.symbol];
    return !last || (now - last) > cooldownMs;
  });

  if (fresh.length === 0) {
    log('No new pumps to alert');
    saveStateCleanup(state, now);
    return;
  }

  fresh.sort((a, b) => parseFloat(b.price24hPcnt) - parseFloat(a.price24hPcnt));

  for (const t of fresh) {
    try {
      await sendTelegram(formatPump(t));
      state.alerted[t.symbol] = now;
      log(`Alerted: ${t.symbol} +${(parseFloat(t.price24hPcnt) * 100).toFixed(1)}%`);
    } catch (e) {
      log(`Failed to alert ${t.symbol}: ${e.message}`);
    }
  }

  saveStateCleanup(state, now);
}

function saveStateCleanup(state, now) {
  const cutoff = now - 7 * 24 * 60 * 60 * 1000;
  for (const sym of Object.keys(state.alerted)) {
    if (state.alerted[sym] < cutoff) delete state.alerted[sym];
  }
  saveState(state);
}

main().catch((e) => {
  log(`FATAL: ${e.message}`);
  process.exit(1);
});

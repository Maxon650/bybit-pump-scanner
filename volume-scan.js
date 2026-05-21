const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const STATE_PATH = path.join(ROOT, 'volume-state.json');
const LOG_PATH = path.join(ROOT, 'volume-scan.log');

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
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Bad JSON from ${url}: ${e.message}`));
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
      res.on('data', (c) => (data += c));
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
  if (!res.ok) throw new Error(`Telegram error: ${JSON.stringify(res)}`);
}

function loadState() {
  if (!fs.existsSync(STATE_PATH)) return { alerted: {} };
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch { return { alerted: {} }; }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getKlines(symbol) {
  const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=60&limit=25`;
  const data = await httpGet(url);
  if (data.retCode !== 0) throw new Error(`Klines error for ${symbol}: ${data.retMsg}`);
  // result.list: [start, open, high, low, close, volume, turnover], newest first
  return data.result.list;
}

function formatSpike(t, ratio, lastHourTurnover, avgTurnover) {
  const pct = (parseFloat(t.price24hPcnt) * 100).toFixed(1);
  const sign = parseFloat(t.price24hPcnt) >= 0 ? '+' : '';
  const price = parseFloat(t.lastPrice);
  const last = (lastHourTurnover / 1_000_000).toFixed(2);
  const avg = (avgTurnover / 1_000_000).toFixed(2);
  const turn24 = (parseFloat(t.turnover24h) / 1_000_000).toFixed(1);

  return `<b>📈 ${t.symbol}</b>  Объём ×${ratio.toFixed(1)}
Цена: <b>$${price}</b>  (${sign}${pct}% за 24ч)
Последний час: <b>$${last}M</b>  (среднее: $${avg}M)
Объём 24ч: $${turn24}M
<a href="https://www.bybit.com/trade/usdt/${t.symbol}">Открыть в Bybit</a>`;
}

async function main() {
  log('Volume scan started');

  const tickersData = await httpGet('https://api.bybit.com/v5/market/tickers?category=linear');
  if (tickersData.retCode !== 0) {
    log(`Tickers error: ${tickersData.retMsg}`);
    return;
  }

  const minDaily = config.volumeSpikeMinDailyTurnoverUsd;
  const candidates = tickersData.result.list
    .filter((t) => parseFloat(t.turnover24h) > minDaily);

  log(`Tickers: ${tickersData.result.list.length}, candidates (turnover24h > $${minDaily/1e6}M): ${candidates.length}`);

  const state = loadState();
  const cooldownMs = config.volumeSpikeCooldownHours * 60 * 60 * 1000;
  const now = Date.now();
  const alerts = [];

  for (let i = 0; i < candidates.length; i++) {
    const t = candidates[i];
    try {
      const klines = await getKlines(t.symbol);
      if (klines.length < 25) continue;

      // Use klines[1] = last fully-completed hour. klines[0] is current incomplete hour.
      const lastHourTurnover = parseFloat(klines[1][6]);
      const prevTurnovers = klines.slice(2, 25).map((k) => parseFloat(k[6]));
      if (prevTurnovers.length === 0) continue;
      const avg = prevTurnovers.reduce((s, v) => s + v, 0) / prevTurnovers.length;
      if (avg <= 0) continue;

      const ratio = lastHourTurnover / avg;

      if (ratio >= config.volumeSpikeMultiplier &&
          lastHourTurnover >= config.volumeSpikeMinHourTurnoverUsd) {
        const last = state.alerted[t.symbol];
        if (!last || (now - last) > cooldownMs) {
          alerts.push({ t, ratio, lastHourTurnover, avg });
        }
      }
    } catch (e) {
      log(`Skip ${t.symbol}: ${e.message}`);
    }
    await sleep(50); // ~20 req/s rate limit safety
  }

  log(`Scanned ${candidates.length} candidates, spike alerts: ${alerts.length}`);

  alerts.sort((a, b) => b.ratio - a.ratio);

  for (const a of alerts) {
    try {
      await sendTelegram(formatSpike(a.t, a.ratio, a.lastHourTurnover, a.avg));
      state.alerted[a.t.symbol] = now;
      log(`Alerted: ${a.t.symbol} x${a.ratio.toFixed(1)} ($${(a.lastHourTurnover/1e6).toFixed(2)}M vs avg $${(a.avg/1e6).toFixed(2)}M)`);
    } catch (e) {
      log(`Failed alert ${a.t.symbol}: ${e.message}`);
    }
  }

  // Cleanup state older than 7 days
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

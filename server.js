// US Market Alerts Dashboard - backend server
// Free data via Yahoo Finance. Signals are technical heuristics, NOT guaranteed profit.

const express = require("express");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawn } = require("child_process");
const WebSocket = require("ws");
const Anthropic = require("@anthropic-ai/sdk");
const YahooFinance = require("yahoo-finance2").default;
const { RSI, EMA, ATR, MACD, ADX } = require("technicalindicators");

// Tiny .env loader (no dependency) — keeps secrets out of the committed code.
try {
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  }
} catch (_) {}

// v3 requires instantiation
const yahooFinance = new YahooFinance();

// Finnhub real-time WebSocket (US stocks). Set FINNHUB_KEY in .env (not committed).
const FINNHUB_KEY = process.env.FINNHUB_KEY || "";
if (!FINNHUB_KEY) {
  console.warn("⚠️  FINNHUB_KEY not set — live ticks disabled. Add it to a .env file.");
}

// Quiet down yahoo-finance2 startup notices if the helper exists
try {
  yahooFinance.suppressNotices(["yahooSurvey", "ripHistorical"]);
} catch (_) {}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

// ---- What we watch -------------------------------------------------------
// Top charts use liquid ETFs that proxy the big indices. Unlike the raw indices
// (^GSPC etc., not on Finnhub free), these ETFs tick LIVE on Finnhub → per-second charts.
const CHARTS = [
  { symbol: "SPY", name: "S&P 500 · SPY" },
  { symbol: "QQQ", name: "NASDAQ · QQQ" },
  { symbol: "DIA", name: "Dow Jones · DIA" },
  { symbol: "IWM", name: "Russell 2000 · IWM" },
];

// Liquid US names scanned for alerts (all optionable / active in F&O).
// Bigger universe => more chance of finding 5 genuinely strong setups.
const WATCHLIST = [
  "AAPL", "MSFT", "NVDA", "TSLA", "AMZN", "GOOGL", "META", "AMD",
  "NFLX", "AVGO", "JPM", "BAC", "WFC", "GS", "V", "MA",
  "COIN", "MU", "PLTR", "SMCI", "UBER", "DIS", "BA", "CAT",
  "XOM", "CVX", "WMT", "COST", "HD", "NKE", "PYPL", "CRM",
  "ORCL", "ADBE", "INTC", "QCOM", "MRVL", "ARM", "CRWD", "PANW",
  "ABNB", "LLY", "UNH", "F",
];

// Everything we subscribe to on Finnhub / fetch quotes for (deduped)
const SUBSCRIBE = [...new Set([...CHARTS.map((c) => c.symbol), ...WATCHLIST])];

// ---- Helpers -------------------------------------------------------------
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

// Fetch intraday candles; fall back to daily if intraday is empty
async function fetchCandles(symbol, interval = "15m", days = 7) {
  try {
    const res = await yahooFinance.chart(symbol, {
      period1: daysAgo(days),
      interval,
    });
    const q = (res.quotes || []).filter(
      (c) => c.close != null && c.high != null && c.low != null
    );
    if (q.length >= 30) return { candles: q, timeframe: interval };
  } catch (_) {}
  // fallback: daily
  const res = await yahooFinance.chart(symbol, {
    period1: daysAgo(120),
    interval: "1d",
  });
  const q = (res.quotes || []).filter(
    (c) => c.close != null && c.high != null && c.low != null
  );
  return { candles: q, timeframe: "1d" };
}

// Build a buy-signal analysis for one symbol
function analyze(symbol, candles, timeframe) {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const vols = candles.map((c) => c.volume || 0);
  const n = closes.length;
  if (n < 30) return null;

  const price = closes[n - 1];

  // ---- Indicators ----
  const last = (a) => a[a.length - 1];
  const ema9arr = EMA.calculate({ period: 9, values: closes });
  const ema21arr = EMA.calculate({ period: 21, values: closes });
  const ema50arr = EMA.calculate({ period: 50, values: closes });
  const rsiArr = RSI.calculate({ period: 14, values: closes });
  const atrArr = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
  const macdArr = MACD.calculate({
    values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
    SimpleMAOscillator: false, SimpleMASignalLine: false,
  });
  const adxArr = ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });

  const ema9 = last(ema9arr), ema21 = last(ema21arr), ema50 = last(ema50arr) || ema21;
  const rsi = last(rsiArr);
  const atr = last(atrArr) || price * 0.01;
  const macd = last(macdArr) || { MACD: 0, signal: 0, histogram: 0 };
  const macdPrev = macdArr[macdArr.length - 2] || macd;
  const adx = last(adxArr) || { adx: 0, pdi: 0, mdi: 0 };

  // recent window
  const recent = candles.slice(-20);
  const recentHigh = Math.max(...recent.map((c) => c.high));
  const recentLow = Math.min(...recent.map((c) => c.low));
  // Volume SURGE: average of the last 3 completed bars vs the ~8 bars before them.
  // Drops the forming bar and avoids intraday time-of-day bias → ~1.0 is normal,
  // >1 means buying is picking up right now.
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
  const completedVols = vols.slice(0, -1).filter((v) => v > 0); // ignore forming bar
  const recentAvgVol = avg(completedVols.slice(-3));
  const baseAvgVol = avg(completedVols.slice(-11, -3));
  const avgVol = baseAvgVol;
  const relVol = baseAvgVol ? recentAvgVol / baseAvgVol : 0;
  const atrPct = (atr / price) * 100;               // typical move size, in %

  // ---- Entry-quality signals (anti-chase + fresh momentum on completed bars) ----
  const ema9_prev = ema9arr[ema9arr.length - 2] ?? ema9;
  const lastBar = candles[n - 2] || candles[n - 1];  // last COMPLETED bar (n-1 is forming)
  const closeStrength = (lastBar.close - lastBar.low) / Math.max(lastBar.high - lastBar.low, 1e-9);
  const prevClose = lastBar.close, prevHigh = lastBar.high;
  const cc = closes.slice(0, -1); const L = cc.length - 1; // completed-bar closes
  const extPct = ((price - ema9) / ema9) * 100;      // distance above the fast EMA, %
  const m1 = L >= 1 && cc[L] > cc[L - 1];             // last completed close rising
  const m2 = price > ema9 && ema9 > ema9_prev;        // price above a RISING fast EMA
  const m3 = closeStrength >= 0.5;                    // last bar closed in upper half
  const freshOK = (m1 + m2 + m3) >= 2;               // 2-of-3 — confirmed, not chasing

  // ---- Weighted 0-100 Opportunity Score ----
  const breakdown = {};
  const reasons = [];
  let score = 0;

  // 1) TREND (max 30)
  let trend = 0;
  if (ema9 > ema21) trend += 10;
  if (price > ema50 && ema21 > ema50) trend += 6; // require the EMA stack
  if (macd.MACD > macd.signal) trend += 8;
  if (adx.adx >= 20 && adx.pdi > adx.mdi) trend += 6;
  trend = Math.min(trend, 30);
  breakdown.trend = trend; score += trend;
  if (trend >= 22) reasons.push(`Strong uptrend (ADX ${adx.adx.toFixed(0)})`);
  else if (ema9 > ema21) reasons.push("Uptrend forming");

  // 2) MOMENTUM (max 20)
  let mom = 0;
  if (rsi >= 52 && rsi <= 65) mom += 12;      // healthy zone, room to run
  else if (rsi > 65 && rsi <= 70) mom += 6;   // getting hot
  else if (rsi >= 42 && rsi < 52) mom += 6;
  // rsi > 70 -> 0 (overbought)
  if (macd.histogram > (macdPrev.histogram ?? 0)) mom += 8;  // momentum rising
  mom = Math.min(mom, 20);
  breakdown.momentum = mom; score += mom;
  if (mom >= 14) reasons.push(`Momentum rising (RSI ${rsi.toFixed(0)})`);
  else if (rsi > 72) reasons.push(`Overbought caution (RSI ${rsi.toFixed(0)})`);

  // 3) VOLUME (max 20)
  let vol = 0;
  if (relVol >= 2) vol = 20;
  else if (relVol >= 1.5) vol = 15;
  else if (relVol >= 1.2) vol = 10;
  else if (relVol >= 1.0) vol = 5;
  breakdown.volume = vol; score += vol;
  if (vol >= 10) reasons.push(`Volume ${relVol.toFixed(1)}x average`);

  // 4) BREAKOUT (max 15) — reward a CONTROLLED breakout, not an extended chase
  let brk = 0;
  if (price >= recentHigh * 0.995 && price <= recentHigh * 1.002) brk = 15; // poised at the high
  else if (price >= recentHigh * 0.985 && price < recentHigh * 0.995) brk = 10; // coiling below
  else if (price > recentHigh * 1.005) brk = 4; // already extended (anti-chase gate handles worst)
  if (price >= recentHigh && relVol < 1.2) brk = Math.min(brk, 6); // breakout needs participation
  breakdown.breakout = brk; score += brk;
  if (brk >= 10) reasons.push("Breaking out");

  // 5) VOLATILITY QUALITY (max 15) — enough movement to be worth it, not crazy
  let vq = 0;
  if (atrPct >= 0.4 && atrPct <= 4) vq = 15;        // sweet spot
  else if (atrPct > 0.25 && atrPct < 0.4) vq = 7;
  else if (atrPct > 4 && atrPct <= 7) vq = 7;       // very volatile = extra risk
  breakdown.volatility = vq; score += vq;

  if (freshOK) { score += 5; reasons.push("Fresh upward momentum"); } // confirmed entry

  score = Math.round(score);

  // ---- Noise / liquidity / anti-chase filter ----
  // Move enough + actually trades + NOT over-extended + confirmed micro-momentum.
  const MIN_ATR_PCT = 0.3;          // skip dead movers (tiny range = noise)
  const tooQuiet = atrPct < MIN_ATR_PCT;
  const liquid = completedVols.length >= 5; // it has real trading history
  // over-extended = too far above EMA9 (ATR-scaled), overbought, or chasing the high
  const extended = extPct > 1.5 * atrPct || rsi > 70 || price > recentHigh * 1.005;
  const passFilter = !tooQuiet && liquid && !extended && freshOK;

  // ---- Entry / Target / Stop ----
  const entry = price;
  const stop = +(entry - 1.5 * atr).toFixed(2);
  const target = +(entry + 2.5 * atr).toFixed(2);
  const riskReward = ((target - entry) / (entry - stop)).toFixed(2);

  return {
    symbol,
    timeframe,
    price: +price.toFixed(2),
    rsi: +rsi.toFixed(1),
    adx: +adx.adx.toFixed(0),
    relVol: +relVol.toFixed(2),
    atrPct: +atrPct.toFixed(2),
    score,            // 0-100
    breakdown,
    reasons,
    passFilter,
    extended,
    freshOK,
    extPct: +extPct.toFixed(2),
    atr: +atr.toFixed(4),         // raw ATR for structure-aware stops
    prevClose: +prevClose.toFixed(2),
    prevHigh: +prevHigh.toFixed(2),
    ema9: +ema9.toFixed(2),
    entry: +entry.toFixed(2),
    target,
    stop,
    riskReward,
    targetPct: +(((target - entry) / entry) * 100).toFixed(2),
    stopPct: +(((stop - entry) / entry) * 100).toFixed(2),
    recentHigh: +recentHigh.toFixed(2),
    recentLow: +recentLow.toFixed(2),
  };
}

// ---- API: charts for the top indices ----
app.get("/api/charts", async (req, res) => {
  const out = [];
  for (const idx of CHARTS) {
    try {
      const { candles, timeframe } = await fetchCandles(idx.symbol, "5m", 5);
      const series = candles.slice(-120).map((c) => ({
        time: Math.floor(new Date(c.date).getTime() / 1000),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }));
      const last = candles[candles.length - 1];
      const first = candles[candles.length - Math.min(candles.length, 26)];
      const changePct =
        first && first.close
          ? (((last.close - first.close) / first.close) * 100).toFixed(2)
          : "0.00";
      out.push({
        symbol: idx.symbol,
        name: idx.name,
        timeframe,
        price: +last.close.toFixed(2),
        changePct,
        series,
      });
    } catch (e) {
      out.push({ symbol: idx.symbol, name: idx.name, error: String(e.message || e) });
    }
  }
  res.json({ updated: new Date().toISOString(), indices: out });
});

// ---- F&O / Options analysis for one symbol ----
// Returns: options-flow sentiment (put/call ratio), a suggested CALL to buy
// (near-ATM, a swing expiry), its breakeven/IV, and unusual call activity.
async function analyzeOptions(symbol, refPrice) {
  const base = await yahooFinance.options(symbol);
  const price = (base.quote && base.quote.regularMarketPrice) || refPrice;
  const expiries = (base.expirationDates || []).map((d) => new Date(d));
  const nearest = base.options && base.options[0];
  if (!nearest) return null;

  // 1) Options-flow sentiment from the nearest (most active) expiry
  const calls0 = nearest.calls || [];
  const puts0 = nearest.puts || [];
  const callVol = calls0.reduce((s, c) => s + (c.volume || 0), 0);
  const putVol = puts0.reduce((s, p) => s + (p.volume || 0), 0);
  const pcr = callVol ? +(putVol / callVol).toFixed(2) : null;
  let flow = "Neutral";
  if (pcr != null) {
    if (pcr < 0.7) flow = "Bullish";
    else if (pcr < 0.9) flow = "Mildly bullish";
    else if (pcr <= 1.1) flow = "Neutral";
    else flow = "Bearish";
  }

  // 2) Pick a swing expiry: first one >= 5 days out (fallback: nearest)
  const FIVE_DAYS = 5 * 24 * 3600 * 1000;
  const nowMs = base.quote && base.quote.regularMarketTime
    ? new Date(base.quote.regularMarketTime).getTime()
    : expiries[0]?.getTime() || 0;
  let target = expiries.find((d) => d.getTime() - nowMs >= FIVE_DAYS) || expiries[0];
  let chain = nearest;
  if (target && new Date(nearest.expirationDate).getTime() !== target.getTime()) {
    try {
      const r = await yahooFinance.options(symbol, { date: target });
      if (r.options && r.options[0]) chain = r.options[0];
    } catch (_) {}
  }
  const calls = chain.calls || [];
  const puts = chain.puts || [];
  const expiryStr = new Date(chain.expirationDate).toISOString().slice(0, 10);

  // 3) Signed flow direction (used by both the confluence gate and the F&O engine)
  const flowDir = pcr == null ? "neutral" : pcr < 0.8 ? "bullish" : pcr <= 1.15 ? "neutral" : "bearish";
  const clamp = (lo, hi, v) => Math.max(lo, Math.min(hi, v));
  const flowScore = pcr == null ? 0 : +clamp(-1, 1, (1 - pcr) / 0.5).toFixed(2);

  const atmCall = calls.slice().sort((a, b) => Math.abs(a.strike - price) - Math.abs(b.strike - price))[0];
  const atmIV = atmCall && atmCall.impliedVolatility ? Math.round(atmCall.impliedVolatility * 100) : null;
  const callOI = calls.reduce((s, c) => s + (c.openInterest || 0), 0);
  const putOI = puts.reduce((s, p) => s + (p.openInterest || 0), 0);

  // 4) Pick a liquid near-ATM contract for either side (CALL = slightly OTM up, PUT = down)
  function pickContract(side) {
    const list = side === "CALL" ? calls : puts;
    if (!list.length) return null;
    const liq = list.filter((c) => (c.volume || 0) + (c.openInterest || 0) >= 50);
    const pool = liq.length ? liq : list;
    let c;
    if (side === "CALL") {
      c = pool.filter((x) => x.strike >= price).sort((a, b) => a.strike - b.strike)[0];
    } else {
      c = pool.filter((x) => x.strike <= price).sort((a, b) => b.strike - a.strike)[0];
    }
    if (!c) c = pool.slice().sort((a, b) => Math.abs(a.strike - price) - Math.abs(b.strike - price))[0];
    if (!c) return null;
    const premium = c.lastPrice || ((c.bid || 0) + (c.ask || 0)) / 2 || 0;
    const breakeven = side === "CALL" ? c.strike + premium : c.strike - premium;
    return {
      type: side, expiry: expiryStr, strike: c.strike,
      premium: +premium.toFixed(2), bid: c.bid ?? null, ask: c.ask ?? null,
      iv: c.impliedVolatility ? Math.round(c.impliedVolatility * 100) : null,
      volume: c.volume || 0, openInterest: c.openInterest || 0,
      breakeven: +breakeven.toFixed(2),
      breakevenPct: +(((breakeven - price) / price) * 100).toFixed(2),
    };
  }

  // 5) Unusual activity (fresh money: volume > OI), for calls and puts
  const unusualOf = (list, label) =>
    (list || [])
      .filter((c) => (c.volume || 0) > Math.max(c.openInterest || 0, 200))
      .sort((a, b) => (b.volume || 0) - (a.volume || 0))
      .slice(0, 3)
      .map((c) => ({ strike: c.strike, side: label, volume: c.volume || 0, openInterest: c.openInterest || 0, premium: c.lastPrice ?? null }));
  const unusualCalls = unusualOf(calls0, "C");
  const unusualPuts = unusualOf(puts0, "P");

  return {
    underlyingPrice: +(+price).toFixed(2),
    pcr, flow, flowDir, flowScore, bearishFlow: flowDir === "bearish",
    atmIV, callOI, putOI,
    makeCall: () => pickContract("CALL"),
    makePut: () => pickContract("PUT"),
    unusualCalls, unusualPuts,
  };
}

// Cache options per symbol ~90s so the alert confluence gate and the F&O engine
// share one fetch instead of hammering Yahoo.
const _optCache = {};
async function getOptions(symbol, price) {
  const c = _optCache[symbol];
  if (c && Date.now() - c.ts < 90000) return c.data;
  const data = await analyzeOptions(symbol, price).catch(() => null);
  _optCache[symbol] = { data, ts: Date.now() };
  return data;
}

// ---- News + sentiment (Phase B) ----
const BULL = new Set([
  "surge", "surges", "soar", "soars", "jump", "jumps", "rally", "rallies", "beat",
  "beats", "upgrade", "upgraded", "upgrades", "record", "gain", "gains", "rise",
  "rises", "buy", "outperform", "strong", "boost", "boosts", "tops", "raise",
  "raised", "raises", "bullish", "breakout", "wins", "win", "approve", "approved",
  "growth", "profit", "profits", "high", "highs", "rebound", "optimistic", "rallied",
]);
const BEAR = new Set([
  "fall", "falls", "drop", "drops", "plunge", "plunges", "miss", "misses",
  "downgrade", "downgraded", "downgrades", "cut", "cuts", "lawsuit", "probe",
  "warning", "warn", "warns", "slump", "slumps", "sell", "crash", "weak", "loss",
  "losses", "decline", "declines", "bearish", "sinks", "sink", "tumble", "tumbles",
  "fraud", "recall", "halt", "bankruptcy", "layoff", "layoffs", "fears", "concern",
  "concerns", "slowdown", "disappoints", "disappointing", "lower", "slips", "slip",
]);

// ---- Claude sentiment via the Claude Code CLI (uses your Max subscription) ----
// No API key needed; spawns `claude -p --model haiku` headless. Falls back to
// keyword sentiment if the CLI is missing, not logged in, or times out.
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const CLAUDE_PATH = `${process.env.PATH}${path.delimiter}${path.join(
  os.homedir(), "AppData", "Roaming", "npm"
)}`;
// Claude (best-trade + smart news) runs via the Claude Code CLI using your Max
// login — that only exists on your PC. On a cloud server / VPS set ENABLE_CLAUDE=0
// so it skips Claude cleanly and uses keyword sentiment instead.
const ENABLE_CLAUDE = process.env.ENABLE_CLAUDE !== "0";

// --- Paid Anthropic API path (for cloud/VPS, where the Max CLI login is absent) ---
// Key goes in .env as ANTHROPIC_API_KEY (never committed). Cheap models by default.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const SENTIMENT_MODEL = process.env.CLAUDE_SENTIMENT_MODEL || "claude-haiku-4-5";
const BEST_MODEL = process.env.CLAUDE_BEST_MODEL || "claude-haiku-4-5";
let anthropic = null;
if (ANTHROPIC_API_KEY) {
  try { anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY }); }
  catch (_) { anthropic = null; }
}

async function apiJSON(prompt, model, maxTokens) {
  if (!anthropic) return null;
  try {
    const msg = await anthropic.messages.create({
      model: model || "claude-haiku-4-5",
      max_tokens: maxTokens || 500,
      messages: [{ role: "user", content: prompt }],
    });
    const text = (msg.content || [])
      .filter((b) => b.type === "text").map((b) => b.text).join("");
    const m = text.replace(/```json|```/g, "").match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch (_) { return null; }
}

// Only spend tokens while the US market is actually live (saves API/Max usage).
const CLAUDE_MARKET_HOURS_ONLY = process.env.CLAUDE_MARKET_HOURS_ONLY !== "0";

// US regular session: Mon–Fri 9:30–16:00 ET. DST handled via IANA tz; holidays not.
function isUsMarketOpen() {
  try {
    const p = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", weekday: "short",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(new Date());
    const g = (t) => (p.find((x) => x.type === t) || {}).value;
    const wd = g("weekday");
    if (wd === "Sat" || wd === "Sun") return false;
    let hh = parseInt(g("hour"), 10); if (hh === 24) hh = 0;
    const mins = hh * 60 + parseInt(g("minute"), 10);
    return mins >= 570 && mins < 960; // 9:30 → 16:00 ET
  } catch (_) { return true; }
}

// Router: prefer the FREE Max CLI on your PC; use the PAID API on a server/VPS.
async function claudeJSON(prompt, opts = {}) {
  if (CLAUDE_MARKET_HOURS_ONLY && !isUsMarketOpen()) return null; // market closed → no Claude
  const forceCli = process.env.ENABLE_CLAUDE === "1";
  if (anthropic && !forceCli) return apiJSON(prompt, opts.apiModel, opts.maxTokens);
  if (ENABLE_CLAUDE) return cliJSON(prompt, opts.cliModel, opts.timeoutMs);
  return null;
}

// CLI path: send a prompt to `claude -p`, parse one JSON object from the output.
function cliJSON(prompt, model, timeoutMs) {
  return new Promise((resolve) => {
    if (!ENABLE_CLAUDE) return resolve(null);
    const args = ["-p"];
    if (model) args.push("--model", model);
    let out = "";
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    let child;
    try {
      child = spawn(CLAUDE_BIN, args, {
        shell: true,
        windowsHide: true,
        env: { ...process.env, PATH: CLAUDE_PATH },
      });
    } catch (_) { return done(null); }

    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} done(null); }, timeoutMs || 30000);
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.on("error", () => { clearTimeout(timer); done(null); });
    child.on("close", () => {
      clearTimeout(timer);
      const m = out.replace(/```json|```/g, "").match(/\{[\s\S]*\}/);
      if (!m) return done(null);
      try { return done(JSON.parse(m[0])); } catch (_) { done(null); }
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// Per-stock news sentiment (fast model)
async function claudeSentiment(symbol, headlines) {
  if (!headlines || !headlines.length) return null;
  const prompt =
    `You are a stock-news sentiment classifier. Based ONLY on these recent ` +
    `${symbol} headlines, output ONE line of JSON and nothing else: ` +
    `{"sentiment":"Bullish|Bearish|Neutral","reason":"<max 12 words, plain text>"}.\n` +
    `Headlines:\n${headlines.map((h) => "- " + h).join("\n")}`;
  const o = await claudeJSON(prompt, { apiModel: SENTIMENT_MODEL, cliModel: "haiku", maxTokens: 150, timeoutMs: 30000 });
  return o && o.sentiment ? { sentiment: o.sentiment, reason: o.reason || "" } : null;
}

// Synthesis: Claude weighs ALL candidates and picks the single best trade.
async function claudeBestTrade(candidates) {
  if (!candidates || !candidates.length) return null;
  const lines = candidates.map((a) => {
    const o = a.options, n = a.news;
    let s = `${a.symbol}: score ${a.score}/100, RSI ${a.rsi}, ADX ${a.adx}, vol ${a.relVol}x, move ${a.atrPct}%. ` +
      `Entry ${a.entry}, target ${a.target} (+${a.targetPct}%), stop ${a.stop} (${a.stopPct}%), R:R 1:${a.riskReward}. ` +
      `Signals: ${a.reasons.join("; ")}.`;
    if (o) s += ` Options flow: ${o.flow} (PCR ${o.pcr})` +
      (o.suggestion ? `, suggested ${o.suggestion.expiry} $${o.suggestion.strike} CALL @$${o.suggestion.premium} IV ${o.suggestion.iv}%.` : ".");
    if (n) s += ` News: ${n.sentiment}${n.reason ? ` (${n.reason})` : ""}.`;
    return s;
  }).join("\n");

  const prompt =
    `You are an expert US-equity swing trader. Below are today's strongest technical setups, ` +
    `each with its options flow and the latest news sentiment:\n\n${lines}\n\n` +
    `Weigh technical strength, options flow, news, and risk:reward, then pick the SINGLE best trade ` +
    `to take right now. Output ONLY one JSON object and nothing else:\n` +
    `{"pick":"<SYMBOL>","confidence":"High|Medium|Low","thesis":"<2-3 short sentences on why this is the best trade>",` +
    `"action":"<concrete: buy the stock at entry, or buy which specific option>","risk":"<the single biggest risk, one sentence>"}`;

  const o = await claudeJSON(prompt, { apiModel: BEST_MODEL, cliModel: null, maxTokens: 600, timeoutMs: 45000 });
  return o && o.pick ? o : null;
}

async function analyzeNews(symbol) {
  const day = 24 * 3600 * 1000;
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 4 * day).toISOString().slice(0, 10);
  const url = `https://finnhub.io/api/v1/company-news?symbol=${symbol}&from=${from}&to=${to}&token=${FINNHUB_KEY}`;
  const r = await fetch(url);
  const arr = await r.json();
  if (!Array.isArray(arr) || !arr.length) return null;
  arr.sort((a, b) => b.datetime - a.datetime); // latest first
  const latest = arr[0];

  // keyword sentiment over the most recent ~15 headlines
  let score = 0;
  arr.slice(0, 15).forEach((n) => {
    const words = (n.headline || "").toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/);
    words.forEach((w) => {
      if (BULL.has(w)) score++;
      if (BEAR.has(w)) score--;
    });
  });
  let sentiment = "Neutral";
  if (score >= 2) sentiment = "Bullish";
  else if (score <= -2) sentiment = "Bearish";

  // Upgrade with Claude (via Claude Code CLI / Max subscription). If it works,
  // use its smarter verdict + a short reason; otherwise keep the keyword result.
  let engine = "keyword";
  let reason = "";
  const topHeadlines = arr.slice(0, 6).map((n) => n.headline).filter(Boolean);
  const claude = await claudeSentiment(symbol, topHeadlines);
  if (claude) {
    sentiment = claude.sentiment;
    reason = claude.reason;
    engine = "claude";
  }

  return {
    sentiment,
    engine,
    reason,
    score,
    headline: latest.headline,
    source: latest.source || "",
    url: latest.url || "",
    when: new Date(latest.datetime * 1000).toISOString(),
    count: arr.length,
  };
}

// ---- Alert manager: positions that live until target/stop is hit ----------
// Issue up to 5 alerts. Each behaves like an open position: it STAYS until the
// live price hits its target (win) or stop (loss). Then it's closed, recorded,
// and the best fresh setup takes its place. No time-based churn.
const MIN_SCORE = 55;                 // out of 100
const MAX_ALERTS = 5;
const MONITOR_MS = 15 * 1000;         // check open positions every 15s
const BACKFILL_MS = 2 * 60 * 1000;    // when slots stay empty, re-scan at most this often
let activeAlerts = [];
let closedAlerts = [];                // recently resolved (newest first), capped
let stats = { wins: 0, losses: 0, scratches: 0 };
let alertsUpdatedAt = null;
let alertsScanned = 0;
let bestTrade = null;
let managing = false;
let alertSeq = 0;
let lastBackfillAt = 0;

// Current price: prefer a fresh Finnhub tick, else the Yahoo cache.
function currentPrice(symbol) {
  const t = liveTicks[symbol];
  if (t && Date.now() - t.ts < 120000) return t.price;
  const c = yahooCache[symbol];
  return c && c.price != null ? c.price : null;
}

// Build a fresh alert/position from an analysis. Better entry timing (don't chase,
// shift toward a small pullback), structure-aware stop, dynamic target.
// Returns null to SKIP this cycle if the live fill looks bad (backfill retries).
async function issueAlert(a) {
  const atr = a.atr || (a.entry - a.stop) / 1.5;
  const px = currentPrice(a.symbol) || a.price;
  // fill-validity: skip if price popped since the scan, slipped below the last
  // completed bar, or below the recent swing low (would open straight into weakness)
  if (px > a.price + 0.4 * atr || px < a.prevClose || px < a.recentLow) return null;

  // pullback-shifted entry: cap any chase at +0.25 ATR, then sit 0.25 ATR below —
  // makes the live "now" start at/above entry far more often (same R:R).
  const entry = +(Math.min(px, a.price + 0.25 * atr) - 0.25 * atr).toFixed(2);

  // structure-aware stop (just under the swing low), clamped to 0.8–2.2 ATR risk
  let stop = Math.min(a.recentLow - 0.25 * atr, entry - 1.5 * atr);
  if (entry - stop > 2.2 * atr) stop = entry - 2.2 * atr;
  if (entry - stop < 0.8 * atr) stop = entry - 1.0 * atr;
  stop = +stop.toFixed(2);
  const risk = entry - stop;
  const target = +(entry + 1.8 * risk).toFixed(2); // keeps R:R ~1.8

  const news = a.news !== undefined ? a.news : await analyzeNews(a.symbol).catch(() => null);

  return {
    id: ++alertSeq,
    symbol: a.symbol,
    timeframe: a.timeframe,
    score: a.finalScore != null ? Math.round(a.finalScore) : a.score,
    rsi: a.rsi, adx: a.adx, relVol: a.relVol, atrPct: a.atrPct,
    reasons: a.reasons,
    entry, target, stop,
    targetPct: +(((target - entry) / entry) * 100).toFixed(2),
    stopPct: +(((stop - entry) / entry) * 100).toFixed(2),
    riskReward: risk > 0 ? +((target - entry) / risk).toFixed(2) : 1.8,
    news,
    status: "open",
    openedAt: new Date().toISOString(),
    // exit-management tracking
    atr, stop0: stop, recentLow: a.recentLow, movedBE: false, stopMoves: 0, ticks: 0,
  };
}

// Scan the watchlist, return qualifying setups ranked by score.
async function scanCandidates() {
  const analyses = [];
  const CHUNK = 6;
  for (let i = 0; i < WATCHLIST.length; i += CHUNK) {
    const batch = WATCHLIST.slice(i, i + CHUNK);
    const results = await Promise.all(
      batch.map(async (symbol) => {
        try {
          const { candles, timeframe } = await fetchCandles(symbol);
          return analyze(symbol, candles, timeframe);
        } catch (_) { return null; }
      })
    );
    results.forEach((a) => { if (a) analyses.push(a); });
  }
  alertsScanned = analyses.length;
  const ranked = analyses
    .filter((a) => a.passFilter && a.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8); // only enrich the top 8 (cheap)

  // Confluence gate: technical + options flow + news must agree. VETO a bullish
  // setup when options flow OR news is bearish (this is the CAT fix).
  await Promise.all(
    ranked.map(async (a) => {
      const [opt, news] = await Promise.all([
        getOptions(a.symbol, a.price),
        analyzeNews(a.symbol).catch(() => null),
      ]);
      a.options = opt;
      a.news = news;
      a.veto = (opt && opt.flowDir === "bearish") || (news && news.sentiment === "Bearish");
      let conf = 0;
      if (opt) conf += opt.flowDir === "bullish" ? 8 : opt.flowDir === "bearish" ? -12 : 0;
      if (news) conf += news.sentiment === "Bullish" ? 6 : news.sentiment === "Bearish" ? -14 : 0;
      a.confluence = conf;
      a.finalScore = a.score + conf;
    })
  );

  const passTech = analyses.filter((a) => a.passFilter && a.score >= MIN_SCORE).length;
  const out = ranked
    .filter((a) => !a.veto && a.finalScore >= 58) // ~3 over MIN_SCORE — still fills slots
    .sort((a, b) => b.finalScore - a.finalScore);
  console.log(`scan funnel: ${analyses.length} scanned → ${passTech} passed tech gate → top8 vetoed:${ranked.filter((a) => a.veto).length} → ${out.length} issued`);
  return out;
}

// Manage open positions: move to breakeven, trail winners, and close on
// target / stop / time-stop. Runs only while the market actually moves.
const TIME_STOP_TICKS = 1200; // ~5 market hours at one 15s tick each
function monitorPositions() {
  if (!isUsMarketOpen()) return [];
  const closed = [];
  for (const a of activeAlerts) {
    const px = currentPrice(a.symbol);
    if (px == null) continue;
    const R = a.entry - a.stop0; // initial risk per share

    // breakeven once +1R, then chandelier-trail once +1.5R (never lower a stop)
    if (R > 0 && !a.movedBE && px >= a.entry + 1.0 * R) {
      a.stop = Math.max(a.stop, +(a.entry + 0.05 * a.atr).toFixed(2));
      a.movedBE = true; a.stopMoves++;
    }
    if (R > 0 && px >= a.entry + 1.5 * R) {
      const trail = +(px - 1.5 * a.atr).toFixed(2);
      if (trail > a.stop) { a.stop = trail; a.stopMoves++; }
    }

    let resolved = null;
    if (px >= a.target) resolved = "target";
    else if (px <= a.stop) resolved = "stop";
    else {
      a.ticks++;
      if (a.ticks >= TIME_STOP_TICKS && px < a.entry + 0.5 * R) resolved = "timeout";
    }
    if (!resolved) continue;

    a.status = resolved;
    a.closedAt = new Date().toISOString();
    a.closePrice = +px.toFixed(2);
    a.resultPct = +(((px - a.entry) / a.entry) * 100).toFixed(2);
    if (resolved === "timeout") stats.scratches++;
    else if (a.resultPct >= 0) stats.wins++;     // target, or stop after breakeven/trail
    else stats.losses++;
    closed.push(a);
  }
  if (closed.length) {
    activeAlerts = activeAlerts.filter((a) => a.status === "open");
    closedAlerts = [...closed, ...closedAlerts].slice(0, 12);
    closed.forEach((a) => {
      const tag = a.status === "target" ? "✅ TARGET" : a.status === "timeout" ? "⏱️ TIMEOUT" : (a.resultPct >= 0 ? "🔒 LOCKED" : "🛑 STOP");
      console.log(`Alert ${a.symbol} ${tag} @ ${a.closePrice} (${a.resultPct}%)`);
    });
  }
  return closed;
}

// Fill empty slots with the best fresh setups (excluding ones already open).
async function backfillAlerts() {
  if (managing || activeAlerts.length >= MAX_ALERTS) return;
  managing = true;
  lastBackfillAt = Date.now();
  try {
    const need = MAX_ALERTS - activeAlerts.length;
    const held = new Set(activeAlerts.map((a) => a.symbol));
    const candidates = (await scanCandidates()).filter((a) => !held.has(a.symbol)).slice(0, need);
    const fresh = (await Promise.all(candidates.map((a) => issueAlert(a).catch(() => null)))).filter(Boolean);
    activeAlerts.push(...fresh);
    activeAlerts.sort((a, b) => b.score - a.score);
    alertsUpdatedAt = new Date().toISOString();
    if (activeAlerts.length) {
      const pick = await claudeBestTrade(activeAlerts).catch(() => null);
      if (pick) bestTrade = { ...pick, at: new Date().toISOString() };
    } else bestTrade = null;
    console.log(
      `Alerts: ${activeAlerts.length} open [${activeAlerts.map((a) => a.symbol + ":" + a.score).join(", ")}] · W:${stats.wins} L:${stats.losses}`
    );
  } finally {
    managing = false;
  }
}

// One management tick: resolve any target/stop hits, then top up empty slots.
async function manageAlerts() {
  const closed = monitorPositions();
  const needTopUp = activeAlerts.length < MAX_ALERTS;
  if (closed.length || (needTopUp && Date.now() - lastBackfillAt > BACKFILL_MS)) {
    await backfillAlerts();
  }
  // F&O radar — independent throttled scan (every 60s in market hours, +1 warm on boot)
  if (Date.now() - lastFnoScanAt > 60000 && (isUsMarketOpen() || lastFnoScanAt === 0)) {
    scanFno(); // fire and forget
  }
}

// ---- API: live positions ----
app.get("/api/alerts", (req, res) => {
  res.json({
    updated: alertsUpdatedAt,
    minScore: MIN_SCORE,
    scanned: alertsScanned,
    marketOpen: isUsMarketOpen(),
    stats,
    closed: closedAlerts.slice(0, 6),
    bestTrade,
    alerts: activeAlerts,
  });
});

// ---- F&O Radar: a SEPARATE, bidirectional options engine -------------------
// Independent of the long-only stock alerts. For each symbol it scores BOTH a
// bullish (CALL) and bearish (PUT) case from technicals + options flow, then
// issues the decisive winner. So bearish names get PUT ideas, not forced calls.
let fnoIdeas = [];
let fnoUpdatedAt = null;
let fnoScanning = false;
let lastFnoScanAt = 0;

function scoreFnoDirection(symbol, candles, opt) {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const vols = candles.map((c) => c.volume || 0);
  const n = closes.length;
  if (n < 30) return null;
  const price = closes[n - 1];
  const last = (a) => a[a.length - 1];
  const ema9 = last(EMA.calculate({ period: 9, values: closes }));
  const ema21 = last(EMA.calculate({ period: 21, values: closes }));
  const ema50 = last(EMA.calculate({ period: 50, values: closes })) || ema21;
  const rsi = last(RSI.calculate({ period: 14, values: closes }));
  const atr = last(ATR.calculate({ period: 14, high: highs, low: lows, close: closes })) || price * 0.01;
  const macdArr = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignalLine: false });
  const macd = last(macdArr) || { MACD: 0, signal: 0, histogram: 0 };
  const macdPrev = macdArr[macdArr.length - 2] || macd;
  const adx = last(ADX.calculate({ high: highs, low: lows, close: closes, period: 14 })) || { adx: 0, pdi: 0, mdi: 0 };
  const atrPct = (atr / price) * 100;
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
  const cv = vols.slice(0, -1).filter((v) => v > 0);
  const relVol = avg(cv.slice(-11, -3)) ? avg(cv.slice(-3)) / avg(cv.slice(-11, -3)) : 0;
  const histRising = macd.histogram > (macdPrev.histogram ?? 0);
  const extPct = ((price - ema9) / ema9) * 100;
  const flowDir = opt.flowDir;

  let bull = 0; const br = [];
  if (ema9 > ema21 && price > ema50) { bull += 25; br.push("Uptrend (EMA stack)"); }
  if (macd.MACD > macd.signal && histRising) { bull += 20; br.push("MACD rising"); }
  if (adx.adx >= 20 && adx.pdi > adx.mdi) { bull += 15; br.push(`ADX ${adx.adx.toFixed(0)} (buyers)`); }
  if (rsi >= 50 && rsi <= 65) bull += 15;
  if (flowDir === "bullish" || (opt.unusualCalls && opt.unusualCalls.length)) { bull += 15; br.push("Bullish call flow"); }
  if (Math.abs(extPct) <= 1.2 * atrPct && price >= ema9) bull += 10;

  let bear = 0; const pr = [];
  if (ema9 < ema21 && price < ema50) { bear += 25; pr.push("Downtrend (EMA stack)"); }
  if (macd.MACD < macd.signal && !histRising) { bear += 20; pr.push("MACD falling"); }
  if (adx.adx >= 20 && adx.mdi > adx.pdi) { bear += 15; pr.push(`ADX ${adx.adx.toFixed(0)} (sellers)`); }
  if (rsi >= 35 && rsi <= 50) bear += 15;
  if (flowDir === "bearish" || (opt.unusualPuts && opt.unusualPuts.length) || (opt.pcr != null && opt.pcr >= 1.3)) { bear += 15; pr.push("Bearish put flow"); }
  if (Math.abs(extPct) <= 1.2 * atrPct && price <= ema9) bear += 10;

  const liquid = atrPct >= 0.3 && cv.length >= 5 && (opt.callOI + opt.putOI) >= 500 && opt.atmIV != null;
  let direction = "NONE", score = 0, reasons = [];
  if (liquid) {
    if (bull >= bear && bull >= 60 && bull - bear >= 12) { direction = "CALL"; score = bull; reasons = br; }
    else if (bear > bull && bear >= 60 && bear - bull >= 12) { direction = "PUT"; score = bear; reasons = pr; }
  }
  // Never issue a direction that CONTRADICTS the options flow (the user's rule,
  // both ways): no CALL when flow is bearish, no PUT when flow is bullish.
  if ((direction === "CALL" && flowDir === "bearish") || (direction === "PUT" && flowDir === "bullish")) {
    direction = "NONE"; score = 0; reasons = [];
  }
  return {
    symbol, direction, score: Math.round(score), bullScore: bull, bearScore: bear,
    rsi: +rsi.toFixed(1), adx: +adx.adx.toFixed(0), atrPct: +atrPct.toFixed(2), relVol: +relVol.toFixed(2),
    pcr: opt.pcr, flow: opt.flow, flowDir, atmIV: opt.atmIV, price: +price.toFixed(2), atr, reasons,
  };
}

async function scanFno() {
  if (fnoScanning) return;
  fnoScanning = true;
  lastFnoScanAt = Date.now();
  try {
    const ideas = [];
    const heldLong = new Set(activeAlerts.map((a) => a.symbol)); // don't duplicate stock alerts
    const CHUNK = 6;
    for (let i = 0; i < WATCHLIST.length; i += CHUNK) {
      const batch = WATCHLIST.slice(i, i + CHUNK);
      const res = await Promise.all(
        batch.map(async (sym) => {
          try {
            if (heldLong.has(sym)) return null; // it's already a long alert — keep F&O separate
            const { candles } = await fetchCandles(sym);
            const px = candles[candles.length - 1].close;
            const opt = await getOptions(sym, px);
            if (!opt || opt.callOI + opt.putOI < 500) return null;
            const d = scoreFnoDirection(sym, candles, opt);
            if (!d || d.direction === "NONE" || d.score < 60) return null;
            const contract = d.direction === "CALL" ? opt.makeCall() : opt.makePut();
            if (!contract) return null;
            const price = d.price, atr = d.atr;
            const plan = d.direction === "CALL"
              ? { entryRef: +price.toFixed(2), stopRef: +(price - 1.5 * atr).toFixed(2), targetRef: +(price + 2.5 * atr).toFixed(2) }
              : { entryRef: +price.toFixed(2), stopRef: +(price + 1.5 * atr).toFixed(2), targetRef: +(price - 2.5 * atr).toFixed(2) };
            plan.targetPct = +(((plan.targetRef - price) / price) * 100).toFixed(2);
            plan.stopPct = +(((plan.stopRef - price) / price) * 100).toFixed(2);
            plan.riskReward = +(Math.abs(plan.targetRef - price) / Math.max(Math.abs(price - plan.stopRef), 1e-9)).toFixed(2);
            const unusual = d.direction === "CALL" ? opt.unusualCalls : opt.unusualPuts;
            const flowAgrees = (d.direction === "CALL" && opt.flowDir === "bullish") || (d.direction === "PUT" && opt.flowDir === "bearish");
            const rankScore = d.score + (flowAgrees ? 8 : 0) + Math.min(10, (unusual ? unusual.length : 0) * 3) - (opt.atmIV > 80 ? 6 : 0);
            return {
              symbol: sym, direction: d.direction, score: d.score, rankScore: Math.round(rankScore),
              flow: opt.flow, pcr: opt.pcr, flowDir: opt.flowDir, atmIV: opt.atmIV,
              underlyingPrice: price, rsi: d.rsi, adx: d.adx, atrPct: d.atrPct,
              reasons: d.reasons, contract, plan, unusual,
            };
          } catch (_) { return null; }
        })
      );
      res.forEach((x) => { if (x) ideas.push(x); });
    }
    ideas.sort((a, b) => b.rankScore - a.rankScore);
    fnoIdeas = ideas.slice(0, 6);
    fnoUpdatedAt = new Date().toISOString();
    console.log(`F&O: ${fnoIdeas.length} ideas [${fnoIdeas.map((i) => i.symbol + ":" + i.direction).join(", ")}]`);
  } finally {
    fnoScanning = false;
  }
}

app.get("/api/fno", (req, res) => {
  res.json({
    updated: fnoUpdatedAt,
    marketOpen: isUsMarketOpen(),
    scanned: WATCHLIST.length,
    ideas: fnoIdeas,
  });
});

// ---- Backtest: measure the strategy's REAL edge on history -------------
// Walks the SAME signal logic over ~400 days of daily data per stock,
// simulates each trade (enter next open, exit at target / stop / 20-bar time),
// and reports honest stats. This is how quants decide — not on hope.
let backtest = null;
let backtestRunning = false;
const MAXHOLD = 20; // bars to hold before time-exit

function simulateSymbol(symbol, candles) {
  const trades = [];
  const MINBARS = 60; // need history before the first signal
  let open = null;
  for (let i = MINBARS; i < candles.length; i++) {
    const bar = candles[i];
    // manage an open trade (exits start the bar AFTER entry)
    if (open && i > open.entryIdx) {
      if (bar.low <= open.stop) {
        trades.push({ ...open, outcomeR: -1 }); open = null;
      } else if (bar.high >= open.target) {
        trades.push({ ...open, outcomeR: open.rr }); open = null;
      } else if (i - open.entryIdx >= MAXHOLD) {
        trades.push({ ...open, outcomeR: (bar.close - open.entry) / open.risk }); open = null;
      }
    }
    // look for a new signal only when flat
    if (!open && i < candles.length - 1) {
      const a = analyze(symbol, candles.slice(0, i + 1), "1d");
      if (a && a.passFilter && a.score >= MIN_SCORE) {
        const atr = (a.entry - a.stop) / 1.5;
        const next = candles[i + 1];
        const entry = next.open || a.entry;
        const stop = entry - 1.5 * atr;
        const target = entry + 2.5 * atr;
        const risk = entry - stop;
        if (risk > 0) {
          open = {
            symbol, entryIdx: i + 1, entryDate: next.date,
            entry, stop, target, risk, rr: (target - entry) / risk,
          };
        }
      }
    }
  }
  return trades;
}

async function runBacktest() {
  if (backtestRunning) return;
  backtestRunning = true;
  try {
    const all = [];
    const CHUNK = 6;
    for (let i = 0; i < WATCHLIST.length; i += CHUNK) {
      const batch = WATCHLIST.slice(i, i + CHUNK);
      const res = await Promise.all(
        batch.map(async (sym) => {
          try {
            const { candles } = await fetchCandles(sym, "1d", 400);
            return simulateSymbol(sym, candles);
          } catch (_) { return []; }
        })
      );
      res.forEach((t) => all.push(...t));
    }
    if (!all.length) { backtest = { trades: 0, updated: new Date().toISOString() }; return; }

    all.sort((a, b) => new Date(a.entryDate) - new Date(b.entryDate));
    const n = all.length;
    const winsArr = all.filter((t) => t.outcomeR > 0);
    const lossArr = all.filter((t) => t.outcomeR <= 0);
    const grossWin = winsArr.reduce((s, t) => s + t.outcomeR, 0);
    const grossLoss = -lossArr.reduce((s, t) => s + t.outcomeR, 0);
    const avgR = all.reduce((s, t) => s + t.outcomeR, 0) / n;

    // equity curve risking 1% per trade
    let eq = 100, peak = 100, maxDD = 0;
    for (const t of all) {
      eq *= 1 + 0.01 * t.outcomeR;
      peak = Math.max(peak, eq);
      maxDD = Math.max(maxDD, ((peak - eq) / peak) * 100);
    }
    // worst losing streak
    let mcl = 0, cur = 0;
    for (const t of all) {
      if (t.outcomeR < 0) { cur++; mcl = Math.max(mcl, cur); } else cur = 0;
    }

    backtest = {
      trades: n,
      winRate: +((winsArr.length / n) * 100).toFixed(1),
      profitFactor: grossLoss ? +(grossWin / grossLoss).toFixed(2) : null,
      expectancyR: +avgR.toFixed(3),
      avgWinR: +(grossWin / Math.max(winsArr.length, 1)).toFixed(2),
      avgLossR: +(grossLoss / Math.max(lossArr.length, 1)).toFixed(2),
      totalReturnPct: +(eq - 100).toFixed(1),
      maxDrawdownPct: +maxDD.toFixed(1),
      maxConsecLosses: mcl,
      riskPerTrade: 1,
      symbols: WATCHLIST.length,
      updated: new Date().toISOString(),
    };
    console.log(
      `Backtest: ${n} trades, win ${backtest.winRate}%, PF ${backtest.profitFactor}, ` +
      `expectancy ${backtest.expectancyR}R, maxDD ${backtest.maxDrawdownPct}%, return ${backtest.totalReturnPct}%`
    );
  } finally {
    backtestRunning = false;
  }
}

app.get("/api/backtest", (req, res) => {
  res.json(backtest || { trades: null, status: "running" });
});

// ---- Live price engine -------------------------------------------------
// Finnhub WebSocket gives true tick prices for the ETFs + stocks we subscribe to.
// /api/quotes reads from in-memory state only (no external call) so the browser
// can poll it every second.
const ALL_SYMBOLS = SUBSCRIBE;
const NAME_BY_SYMBOL = Object.fromEntries(CHARTS.map((c) => [c.symbol, c.name]));

// last tick from Finnhub: { SYMBOL: { price, ts } }
const liveTicks = {};
// cached Yahoo quote (price + prev close for % change): { SYMBOL: { price, prevClose, changePct } }
const yahooCache = {};

// Refresh the Yahoo cache periodically (indices + fallback/prevClose for stocks)
async function refreshYahooCache() {
  try {
    const quotes = await yahooFinance.quote(ALL_SYMBOLS);
    (Array.isArray(quotes) ? quotes : [quotes]).forEach((q) => {
      yahooCache[q.symbol] = {
        price: q.regularMarketPrice ?? null,
        prevClose: q.regularMarketPreviousClose ?? null,
        changePct:
          q.regularMarketChangePercent != null
            ? +q.regularMarketChangePercent.toFixed(2)
            : null,
      };
    });
  } catch (_) {}
}
refreshYahooCache();
setInterval(refreshYahooCache, 5000); // every 5s (indices have no Finnhub tick)

// Connect to Finnhub WebSocket and keep live ticks flowing
let finnhubWs = null;
function connectFinnhub() {
  finnhubWs = new WebSocket(`wss://ws.finnhub.io?token=${FINNHUB_KEY}`);

  finnhubWs.on("open", () => {
    console.log("Finnhub WS connected — subscribing to", SUBSCRIBE.length, "symbols");
    SUBSCRIBE.forEach((sym) =>
      finnhubWs.send(JSON.stringify({ type: "subscribe", symbol: sym }))
    );
  });

  finnhubWs.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "trade" && Array.isArray(msg.data)) {
        msg.data.forEach((t) => {
          liveTicks[t.s] = { price: t.p, ts: t.t };
        });
      }
    } catch (_) {}
  });

  finnhubWs.on("close", () => {
    console.log("Finnhub WS closed — reconnecting in 5s");
    setTimeout(connectFinnhub, 5000);
  });
  finnhubWs.on("error", (e) => {
    console.log("Finnhub WS error:", e.message);
  });
}
connectFinnhub();

// ---- API: fast live prices (served from memory, safe to poll every 1s) ----
app.get("/api/quotes", (req, res) => {
  const now = Date.now();
  const quotes = ALL_SYMBOLS.map((sym) => {
    const tick = liveTicks[sym];
    const cache = yahooCache[sym] || {};
    // Prefer a fresh Finnhub tick (within 60s); else Yahoo cache
    const live = tick && now - tick.ts < 60000;
    const price = live ? tick.price : cache.price ?? null;
    // compute % change vs prev close when we have a live tick
    let changePct = cache.changePct ?? null;
    if (live && cache.prevClose) {
      changePct = +(((tick.price - cache.prevClose) / cache.prevClose) * 100).toFixed(2);
    }
    return {
      symbol: sym,
      name: NAME_BY_SYMBOL[sym] || sym,
      price: price != null ? +Number(price).toFixed(2) : null,
      changePct,
      live: !!live,
    };
  });
  res.json({ updated: new Date().toISOString(), quotes });
});

// Fill positions on boot, then manage them (resolve hits + top up) every 15s
manageAlerts();
setInterval(manageAlerts, MONITOR_MS);

// Backtest the strategy shortly after boot, then every 6 hours
setTimeout(runBacktest, 8000);
setInterval(runBacktest, 6 * 60 * 60 * 1000);

// HOST=127.0.0.1 keeps the app private (behind nginx) on a shared server.
const HOST = process.env.HOST || "0.0.0.0";
app.listen(PORT, HOST, () => {
  console.log(`US Market Alerts running at http://${HOST}:${PORT}`);
});

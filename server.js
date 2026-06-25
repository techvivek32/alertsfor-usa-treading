// US Market Alerts Dashboard - backend server
// Free data via Yahoo Finance. Signals are technical heuristics, NOT guaranteed profit.

const express = require("express");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawn } = require("child_process");
const WebSocket = require("ws");
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

  // ---- Weighted 0-100 Opportunity Score ----
  const breakdown = {};
  const reasons = [];
  let score = 0;

  // 1) TREND (max 30)
  let trend = 0;
  if (ema9 > ema21) trend += 10;
  if (price > ema50) trend += 6;
  if (macd.MACD > macd.signal) trend += 8;
  if (adx.adx >= 20 && adx.pdi > adx.mdi) trend += 6;
  trend = Math.min(trend, 30);
  breakdown.trend = trend; score += trend;
  if (trend >= 22) reasons.push(`Strong uptrend (ADX ${adx.adx.toFixed(0)})`);
  else if (ema9 > ema21) reasons.push("Uptrend forming");

  // 2) MOMENTUM (max 20)
  let mom = 0;
  if (rsi >= 50 && rsi <= 68) mom += 12;
  else if (rsi > 68) mom += 3;               // overbought, less room
  else if (rsi >= 40 && rsi < 50) mom += 6;
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

  // 4) BREAKOUT (max 15)
  let brk = 0;
  if (price >= recentHigh) brk = 15;
  else if (price >= recentHigh * 0.997) brk = 11;
  else if (price >= recentHigh * 0.99) brk = 6;
  breakdown.breakout = brk; score += brk;
  if (brk >= 11) reasons.push("Breaking recent high");

  // 5) VOLATILITY QUALITY (max 15) — enough movement to be worth it, not crazy
  let vq = 0;
  if (atrPct >= 0.4 && atrPct <= 4) vq = 15;        // sweet spot
  else if (atrPct > 0.25 && atrPct < 0.4) vq = 7;
  else if (atrPct > 4 && atrPct <= 7) vq = 7;       // very volatile = extra risk
  breakdown.volatility = vq; score += vq;

  score = Math.round(score);

  // ---- Noise / liquidity filter (your "no $1-change" rule) ----
  // Gate on: does it MOVE enough to be worth trading, and does it actually trade.
  // (Volume surge is a scoring signal, not a gate — it's time-of-day biased.)
  const MIN_ATR_PCT = 0.3;          // skip dead movers (tiny range = noise)
  const tooQuiet = atrPct < MIN_ATR_PCT;
  const liquid = completedVols.length >= 5; // it has real trading history
  const passFilter = !tooQuiet && liquid;

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

  // 3) Suggested CALL: near-ATM with some liquidity
  const liquid = calls.filter((c) => (c.volume || 0) + (c.openInterest || 0) >= 50);
  const pool = liquid.length ? liquid : calls;
  const sug = pool
    .slice()
    .sort((a, b) => Math.abs(a.strike - price) - Math.abs(b.strike - price))[0];
  let suggestion = null;
  if (sug) {
    const premium = sug.lastPrice || ((sug.bid || 0) + (sug.ask || 0)) / 2 || 0;
    const breakeven = sug.strike + premium;
    suggestion = {
      type: "CALL",
      expiry: new Date(chain.expirationDate).toISOString().slice(0, 10),
      strike: sug.strike,
      premium: +premium.toFixed(2),
      bid: sug.bid ?? null,
      ask: sug.ask ?? null,
      iv: sug.impliedVolatility ? Math.round(sug.impliedVolatility * 100) : null,
      volume: sug.volume || 0,
      openInterest: sug.openInterest || 0,
      breakeven: +breakeven.toFixed(2),
      breakevenPct: +(((breakeven - price) / price) * 100).toFixed(2),
    };
  }

  // 4) Unusual call activity (fresh money): volume > openInterest and sizable
  const unusual = calls0
    .filter((c) => (c.volume || 0) > Math.max(c.openInterest || 0, 200))
    .sort((a, b) => (b.volume || 0) - (a.volume || 0))
    .slice(0, 3)
    .map((c) => ({
      strike: c.strike,
      volume: c.volume || 0,
      openInterest: c.openInterest || 0,
      premium: c.lastPrice ?? null,
    }));

  return { underlyingPrice: +(+price).toFixed(2), pcr, flow, suggestion, unusual };
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

// Generic: send a prompt to `claude -p`, parse one JSON object from the output.
function claudeJSON(prompt, model, timeoutMs) {
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
  const o = await claudeJSON(prompt, "haiku", 30000);
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

  const o = await claudeJSON(prompt, null, 45000); // default model for best reasoning
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

// ---- Alert manager: scan, keep top 5, refresh every 10 min ----
const MIN_SCORE = 55; // out of 100
const ALERT_REFRESH_MS = 10 * 60 * 1000; // 10 minutes
let activeAlerts = [];
let alertsUpdatedAt = null;
let alertsScanned = 0;
let alertsRefreshing = false;
let bestTrade = null; // Claude's single best-trade pick across the candidates

async function refreshAlertSet() {
  if (alertsRefreshing) return;
  alertsRefreshing = true;
  try {
    const analyses = [];
    const CHUNK = 6; // modest concurrency — fast, but won't hammer Yahoo
    for (let i = 0; i < WATCHLIST.length; i += CHUNK) {
      const batch = WATCHLIST.slice(i, i + CHUNK);
      const results = await Promise.all(
        batch.map(async (symbol) => {
          try {
            const { candles, timeframe } = await fetchCandles(symbol);
            return analyze(symbol, candles, timeframe);
          } catch (_) {
            return null;
          }
        })
      );
      results.forEach((a) => { if (a) analyses.push(a); });
    }
    analyses.sort((a, b) => b.score - a.score);
    const top = analyses
      .filter((a) => a.passFilter && a.score >= MIN_SCORE)
      .slice(0, 5); // keep the best 5

    // enrich each with F&O idea + news (in parallel)
    await Promise.all(
      top.map(async (a) => {
        const [opt, news] = await Promise.all([
          analyzeOptions(a.symbol, a.price).catch(() => null),
          analyzeNews(a.symbol).catch(() => null),
        ]);
        a.options = opt;
        a.news = news;
        a.generatedAt = new Date().toISOString();
      })
    );

    activeAlerts = top;
    alertsScanned = analyses.length;
    alertsUpdatedAt = new Date().toISOString();
    console.log(
      `Alerts refreshed: ${top.length} active [${top.map((a) => `${a.symbol}:${a.score}`).join(", ")}]`
    );

    // Claude weighs everything and names the single best trade
    if (top.length) {
      const pick = await claudeBestTrade(top).catch(() => null);
      if (pick) {
        bestTrade = { ...pick, at: new Date().toISOString() };
        console.log(`Claude best trade: ${pick.pick} (${pick.confidence})`);
      }
    } else {
      bestTrade = null;
    }
  } finally {
    alertsRefreshing = false;
  }
}

// ---- API: cached top-5 alerts (stable for 10 min, served instantly) ----
app.get("/api/alerts", (req, res) => {
  res.json({
    updated: alertsUpdatedAt,
    refreshEverySec: ALERT_REFRESH_MS / 1000,
    nextRefreshInSec: alertsUpdatedAt
      ? Math.max(0, Math.round((new Date(alertsUpdatedAt).getTime() + ALERT_REFRESH_MS - Date.now()) / 1000))
      : null,
    minScore: MIN_SCORE,
    scanned: alertsScanned,
    bestTrade,
    alerts: activeAlerts,
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

// Build the first alert set on boot, then refresh every 10 minutes
refreshAlertSet();
setInterval(refreshAlertSet, ALERT_REFRESH_MS);

// Backtest the strategy shortly after boot, then every 6 hours
setTimeout(runBacktest, 8000);
setInterval(runBacktest, 6 * 60 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`US Market Alerts running at http://localhost:${PORT}`);
});

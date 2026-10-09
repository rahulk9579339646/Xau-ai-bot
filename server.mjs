
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const HF_SECRET = process.env.HF_SECRET || "";
const LIQUID_AUTO_TRADE =
  String(process.env.LIQUID_AUTO_TRADE || "false").toLowerCase() === "true";

const SYMBOL = "XAU/USD";
const OUTPUT_SYMBOL = "XAUUSD";
const INTERVAL = "5min";
const OUTPUT_SIZE = 500;

const INITIAL_BALANCE = 100;
const RISK_PERCENT = 1;
const RR = 2;
const ATR_PERIOD = 14;
const SWING_LEFT = 3;
const SWING_RIGHT = 3;
const SR_TOLERANCE_ATR = 0.25;

let telegramEnabled = true;
let lastTelegramKey = "";
let lastTelegramPoll = 0;
let lastDecision = null;
let lastScanAt = null;
let lastError = null;
let telegramOffset = 0;

function auth(req, res, next) {
  if (!HF_SECRET) return next();

  const supplied =
    req.headers["x-hf-secret"] ||
    req.headers["x-api-key"] ||
    req.query.secret;

  if (supplied !== HF_SECRET) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized"
    });
  }

  next();
}

function finite(n) {
  return Number.isFinite(Number(n));
}

function roundPrice(n) {
  return Number(Number(n).toFixed(2));
}

function parseTime(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function fetchCandles() {
  if (!TWELVE_DATA_API_KEY) {
    throw new Error("TWELVE_DATA_API_KEY is not configured");
  }

  const url = new URL("https://api.twelvedata.com/time_series");
  url.searchParams.set("symbol", SYMBOL);
  url.searchParams.set("interval", INTERVAL);
  url.searchParams.set("outputsize", String(OUTPUT_SIZE));
  url.searchParams.set("order", "ASC");
  url.searchParams.set("apikey", TWELVE_DATA_API_KEY);

  const response = await fetch(url.toString());
  const payload = await response.json();

  if (!response.ok || payload.status === "error" || !Array.isArray(payload.values)) {
    throw new Error(
      payload.message || `Twelve Data request failed: ${response.status}`
    );
  }

  const candles = payload.values
    .map(c => ({
      time: c.datetime,
      timestamp: new Date(c.datetime).getTime(),
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close)
    }))
    .filter(c =>
      Number.isFinite(c.timestamp) &&
      finite(c.open) &&
      finite(c.high) &&
      finite(c.low) &&
      finite(c.close)
    )
    .sort((a, b) => a.timestamp - b.timestamp);

  if (candles.length < 50) {
    throw new Error(`Not enough candles received: ${candles.length}`);
  }

  return candles;
}

function calculateATR(candles) {
  const tr = [];

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = i > 0 ? candles[i - 1].close : c.close;

    tr.push(Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose)
    ));
  }

  const atr = new Array(candles.length).fill(null);

  for (let i = ATR_PERIOD - 1; i < candles.length; i++) {
    const slice = tr.slice(i - ATR_PERIOD + 1, i + 1);
    atr[i] = slice.reduce((sum, value) => sum + value, 0) / ATR_PERIOD;
  }

  return atr;
}

function isSwingHigh(candles, index) {
  const current = candles[index].high;

  for (let j = index - SWING_LEFT; j < index; j++) {
    if (current <= candles[j].high) return false;
  }

  for (let j = index + 1; j <= index + SWING_RIGHT; j++) {
    if (current < candles[j].high) return false;
  }

  return true;
}

function isSwingLow(candles, index) {
  const current = candles[index].low;

  for (let j = index - SWING_LEFT; j < index; j++) {
    if (current >= candles[j].low) return false;
  }

  for (let j = index + 1; j <= index + SWING_RIGHT; j++) {
    if (current > candles[j].low) return false;
  }

  return true;
}

/*
 * Strategy #5 — Support / Resistance Rejection
 *
 * Live-safe swing confirmation:
 * At candle i, the possible pivot is i - SWING_RIGHT.
 * Thus the pivot is not used until the 3 right-hand candles exist.
 */
function strategy5Scan(candles) {
  const atr = calculateATR(candles);

  let lastResistance = NaN;
  let lastSupport = NaN;
  let resistanceTested = false;
  let supportTested = false;
  let latestSignal = null;

  for (let i = 0; i < candles.length; i++) {
    const pivotIndex = i - SWING_RIGHT;

    if (pivotIndex >= SWING_LEFT) {
      if (isSwingHigh(candles, pivotIndex)) {
        lastResistance = candles[pivotIndex].high;
        resistanceTested = false;
      }

      if (isSwingLow(candles, pivotIndex)) {
        lastSupport = candles[pivotIndex].low;
        supportTested = false;
      }
    }

    const c = candles[i];
    const currentATR = atr[i];

    if (!Number.isFinite(currentATR) || currentATR <= 0) continue;
    if (!Number.isFinite(lastResistance)) continue;
    if (!Number.isFinite(lastSupport)) continue;

    const tolerance = currentATR * SR_TOLERANCE_ATR;

    // BUY — Support rejection
    const supportRejection =
      c.low <= lastSupport + tolerance &&
      c.close > lastSupport &&
      c.close > c.open &&
      !supportTested;

    if (supportRejection) {
      const entry = c.close;
      let sl = c.low;

      if (entry - sl < currentATR) {
        sl = entry - currentATR;
      }

      const riskDistance = entry - sl;

      if (riskDistance > 0) {
        latestSignal = {
          index: i,
          time: c.time,
          timestamp: c.timestamp,
          side: "BUY",
          entry,
          sl,
          tp: entry + riskDistance * RR,
          atr: currentATR,
          support: lastSupport,
          resistance: lastResistance,
          riskDistance,
          rr: RR
        };
      }

      supportTested = true;
      continue;
    }

    // SELL — Resistance rejection
    const resistanceRejection =
      c.high >= lastResistance - tolerance &&
      c.close < lastResistance &&
      c.close < c.open &&
      !resistanceTested;

    if (resistanceRejection) {
      const entry = c.close;
      let sl = c.high;

      if (sl - entry < currentATR) {
        sl = entry + currentATR;
      }

      const riskDistance = sl - entry;

      if (riskDistance > 0) {
        latestSignal = {
          index: i,
          time: c.time,
          timestamp: c.timestamp,
          side: "SELL",
          entry,
          sl,
          tp: entry - riskDistance * RR,
          atr: currentATR,
          support: lastSupport,
          resistance: lastResistance,
          riskDistance,
          rr: RR
        };
      }

      resistanceTested = true;
      continue;
    }
  }

  const latestCandle = candles[candles.length - 1];

  // Only expose a signal formed on the newest candle.
  if (!latestSignal || latestSignal.index !== candles.length - 1) {
    return {
      executable: false,
      strategy: "Strategy #5 — Support/Resistance Rejection",
      symbol: OUTPUT_SYMBOL,
      candleTime: latestCandle.time,
      message: "No new Strategy #5 signal on the latest candle"
    };
  }

  return {
    executable: true,
    executionAllowed: LIQUID_AUTO_TRADE,
    strategy: "Strategy #5 — Support/Resistance Rejection",
    symbol: OUTPUT_SYMBOL,
    direction: latestSignal.side,
    signalTime: latestSignal.time,
    signalTimestamp: latestSignal.timestamp,
    entry: roundPrice(latestSignal.entry),
    stopLoss: roundPrice(latestSignal.sl),
    takeProfit: roundPrice(latestSignal.tp),
    atr: Number(latestSignal.atr.toFixed(4)),
    support: roundPrice(latestSignal.support),
    resistance: roundPrice(latestSignal.resistance),
    rr: RR,
    riskPercent: RISK_PERCENT,
    compounding: true,
    tradeLevels: {
      entry: roundPrice(latestSignal.entry),
      stopLoss: roundPrice(latestSignal.sl),
      takeProfit: roundPrice(latestSignal.tp)
    },
    message: `${latestSignal.side} — Support/Resistance Rejection`
  };
}

async function telegramSend(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message
      })
    }
  );

  if (!response.ok) {
    throw new Error(`Telegram send failed: ${response.status}`);
  }
}

function formatSignal(d) {
  return [
    "XAUUSD — STRATEGY #5",
    "Support / Resistance Rejection",
    `Signal: ${d.direction}`,
    `Time: ${d.signalTime}`,
    `Entry: ${d.entry}`,
    `SL: ${d.stopLoss}`,
    `TP: ${d.takeProfit}`,
    "RR: 1:2",
    "Risk: 1% current equity",
    "Compounding: ON"
  ].join("\n");
}

async function scanAndAlert() {
  try {
    const candles = await fetchCandles();
    const decision = strategy5Scan(candles);

    lastDecision = decision;
    lastScanAt = new Date().toISOString();
    lastError = null;

    if (decision.executable) {
      const key = `${decision.signalTimestamp}_${decision.direction}`;

      if (key !== lastTelegramKey && telegramEnabled) {
        await telegramSend(formatSignal(decision));
        lastTelegramKey = key;
      }
    }

    return decision;
  } catch (error) {
    lastError = error.message;
    console.error("Strategy #5 scan error:", error.message);
    throw error;
  }
}

async function handleTelegramCommands() {
  if (!TELEGRAM_BOT_TOKEN || Date.now() - lastTelegramPoll < 2500) return;
  lastTelegramPoll = Date.now();

  try {
    const url = new URL(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates`
    );
    url.searchParams.set("offset", String(telegramOffset));
    url.searchParams.set("timeout", "0");

    const response = await fetch(url.toString());
    const data = await response.json();

    if (!data.ok || !Array.isArray(data.result)) return;

    for (const update of data.result) {
      telegramOffset = Math.max(telegramOffset, update.update_id + 1);

      const message = update.message;
      if (!message || !message.text) continue;

      if (
        TELEGRAM_CHAT_ID &&
        String(message.chat.id) !== String(TELEGRAM_CHAT_ID)
      ) continue;

      const command = message.text.trim().toLowerCase();

      if (command === "/start_p78") {
        telegramEnabled = true;
        await telegramSend("Strategy #5 Telegram alerts: ON");
      } else if (command === "/stop_p78") {
        telegramEnabled = false;
        await telegramSend("Strategy #5 Telegram alerts: OFF");
      } else if (command === "/status_p78") {
        await telegramSend([
          "STRATEGY #5 STATUS",
          `Telegram alerts: ${telegramEnabled ? "ON" : "OFF"}`,
          `Auto-trade allowed: ${LIQUID_AUTO_TRADE ? "ON" : "OFF"}`,
          `Last scan: ${lastScanAt || "Not scanned yet"}`,
          `Last signal: ${lastDecision?.direction || "None"}`,
          `Last error: ${lastError || "None"}`
        ].join("\n"));
      }
    }
  } catch (error) {
    console.error("Telegram command error:", error.message);
  }
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "XAUUSD Strategy #5",
    strategy: "Support/Resistance Rejection"
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    strategy: "Strategy #5",
    lastScanAt,
    lastError
  });
});

app.get("/status", auth, (req, res) => {
  res.json({
    ok: true,
    strategy: "Strategy #5 — Support/Resistance Rejection",
    telegramEnabled,
    liquidAutoTrade: LIQUID_AUTO_TRADE,
    lastScanAt,
    lastError,
    decision: lastDecision
  });
});

app.get("/p78/status", auth, (req, res) => {
  res.json({
    ok: true,
    strategy: "Strategy #5 — Support/Resistance Rejection",
    telegramEnabled,
    liquidAutoTrade: LIQUID_AUTO_TRADE,
    lastScanAt,
    lastError,
    decision: lastDecision
  });
});

app.get("/p78/decision", auth, async (req, res) => {
  try {
    const decision = await scanAndAlert();
    res.json({
      ok: true,
      ...decision,
      executionAllowed: LIQUID_AUTO_TRADE
    });
  } catch (error) {
    res.status(503).json({
      ok: false,
      executable: false,
      strategy: "Strategy #5",
      error: error.message
    });
  }
});

app.get("/signal", auth, (req, res) => {
  res.json(lastDecision || {
    ok: true,
    executable: false,
    strategy: "Strategy #5",
    message: "No scan completed yet"
  });
});

app.post("/p78/telegram", auth, async (req, res) => {
  try {
    const message = String(req.body?.message || "Strategy #5 test message");
    await telegramSend(message);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/p78/telegram/start", auth, (req, res) => {
  telegramEnabled = true;
  res.json({ ok: true, telegramEnabled });
});

app.post("/p78/telegram/stop", auth, (req, res) => {
  telegramEnabled = false;
  res.json({ ok: true, telegramEnabled });
});

// Keep the existing route compatible with Liquid Chart.
app.get("/p78/decision", auth, async (req, res) => {
  // This duplicate route is intentionally not needed; Express uses the first
  // matching handler above. Remove this block if your editor flags duplicates.
  res.json(lastDecision || { executable: false });
});

setInterval(() => {
  scanAndAlert().catch(() => {});
  handleTelegramCommands().catch(() => {});
}, 20000);

scanAndAlert().catch(() => {});
handleTelegramCommands().catch(() => {});

app.listen(PORT, () => {
  console.log(`Strategy #5 server listening on ${PORT}`);
});

import express from "express";

const app = express();
app.use(express.json());

// =========================================================
// HF EXECUTION CORS
// MyTrader/Liquid Chart scripts run in a browser worker.
// These headers explicitly allow the external XAUUSD executor.
// =========================================================
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-HF-Secret");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

const PORT = process.env.PORT || 10000;

const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-5.4-mini";
const OPENROUTER_FALLBACK_MODEL = process.env.OPENROUTER_FALLBACK_MODEL || "anthropic/claude-sonnet-4.6";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID =
  process.env.TELEGRAM_CHAT_ID || "710410869";

const SYMBOL = "XAU/USD";
const OUTPUT_SYMBOL = "XAUUSD";

const TF = {
  "1H": "1h",
  "15M": "15min",
  "5M": "5min"
};

const CACHE = new Map();
const CACHE_MS = 15000;
const TRENDLINE_ALERT_STATE = new Map();

/* =========================================================
   BASIC HELPERS
========================================================= */

function num(v, d = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function round(v, d = 2) {
  if (!Number.isFinite(v)) return null;

  const p = 10 ** d;

  return Math.round(v * p) / p;
}

function last(a) {
  return Array.isArray(a) && a.length
    ? a[a.length - 1]
    : null;
}

function previous(a) {
  return Array.isArray(a) && a.length > 1
    ? a[a.length - 2]
    : null;
}

function avg(a) {
  const x = a.filter(Number.isFinite);

  return x.length
    ? x.reduce((s, v) => s + v, 0) / x.length
    : null;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

/* =========================================================
   CANDLES
========================================================= */

function normalizeCandles(values) {
  return values
    .map(x => ({
      time: x.datetime,
      open: num(x.open),
      high: num(x.high),
      low: num(x.low),
      close: num(x.close),
      volume: num(x.volume)
    }))
    .filter(
      x =>
        x.time &&
        [
          x.open,
          x.high,
          x.low,
          x.close
        ].every(Number.isFinite)
    )
    .sort(
      (a, b) =>
        new Date(a.time) -
        new Date(b.time)
    );
}

function normalizeBiquoteCandles(bars) {
  return bars
    .filter(x => !x.isOpen)
    .map(x => ({
      time: x.openTime,
      open: num(x.open),
      high: num(x.high),
      low: num(x.low),
      close: num(x.close),
      volume: (() => {
        const actualVolume = num(x.volume);
        const tickVolume = num(x.tickVolume);
        return actualVolume !== null && actualVolume > 0
          ? actualVolume
          : tickVolume;
      })()
    }))
    .filter(
      x =>
        x.time &&
        [x.open, x.high, x.low, x.close].every(Number.isFinite)
    )
    .sort(
      (a, b) =>
        new Date(a.time) -
        new Date(b.time)
    );
}

function biquoteInterval(interval) {
  const map = {
    "1min": "1m",
    "5min": "5m",
    "15min": "15m",
    "30min": "30m",
    "1h": "1h",
    "4h": "4h",
    "1d": "1d"
  };

  return map[interval] || interval;
}

async function getCandlesFromBiquote(
  interval,
  outputsize = 350
) {
  const limit = Math.min(
    Math.max(outputsize, 100),
    1000
  );

  const url =
    `https://biquote.io/api/XAUUSD/ohlc` +
    `?interval=${encodeURIComponent(
      biquoteInterval(interval)
    )}` +
    `&limit=${limit}`;

  const response =
    await fetch(url);

  const json =
    await response.json();

  if (
    !response.ok ||
    !Array.isArray(json.bars)
  ) {
    throw new Error(
      json.message ||
      `Biquote ${interval} candles unavailable`
    );
  }

  const candles =
    normalizeBiquoteCandles(
      json.bars
    );

  if (candles.length < 60) {
    throw new Error(
      `Biquote returned insufficient ${interval} closed candles`
    );
  }

  return candles;
}

async function getCandles(
  interval,
  outputsize = 350
) {
  const cacheKey =
    `${SYMBOL}-${interval}-${outputsize}`;

  const cached =
    CACHE.get(cacheKey);

  if (
    cached &&
    Date.now() - cached.time <
      CACHE_MS
  ) {
    return cached.data;
  }

  let twelveError = null;

  if (TWELVE_DATA_API_KEY) {
    try {
      const url =
        `https://api.twelvedata.com/time_series` +
        `?symbol=${encodeURIComponent(SYMBOL)}` +
        `&interval=${encodeURIComponent(interval)}` +
        `&outputsize=${outputsize}` +
        `&apikey=${encodeURIComponent(
          TWELVE_DATA_API_KEY
        )}`;

      const response =
        await fetch(url);

      const json =
        await response.json();

      if (
        !response.ok ||
        json.status === "error" ||
        !json.values
      ) {
        throw new Error(
          json.message ||
          "Unable to retrieve Twelve Data candles"
        );
      }

      const candles =
        normalizeCandles(
          json.values
        );

      CACHE.set(cacheKey, {
        time: Date.now(),
        data: candles
      });

      return candles;
    } catch (error) {
      twelveError = error;
    }
  } else {
    twelveError = new Error(
      "TWELVE_DATA_API_KEY is missing"
    );
  }

  try {
    const candles =
      await getCandlesFromBiquote(
        interval,
        outputsize
      );

    CACHE.set(cacheKey, {
      time: Date.now(),
      data: candles
    });

    return candles;
  } catch (biquoteError) {
    throw new Error(
      `Twelve Data failed: ${
        twelveError?.message ||
        "unknown error"
      }; ` +
      `Biquote failed: ${
        biquoteError?.message ||
        "unknown error"
      }`
    );
  }
}

/* =========================================================
   TELEGRAM
========================================================= */

async function sendTelegramMessage(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return {
      sent: false,
      reason: "Telegram environment variables not configured"
    };
  }

  try {
    const text = String(message ?? "");
    const chunks = [];

    for (let i = 0; i < text.length; i += 3900) {
      chunks.push(text.slice(i, i + 3900));
    }

    if (!chunks.length) {
      chunks.push("XAU AI BOT\n\nEmpty Telegram message.");
    }

    for (const chunk of chunks) {
      const response = await fetch(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            chat_id: TELEGRAM_CHAT_ID,
            text: chunk
          })
        }
      );

      const data = await response.json();

      if (!response.ok || !data.ok) {
        return {
          sent: false,
          error: data.description || "Telegram message failed"
        };
      }
    }

    return {
      sent: true,
      chunks: chunks.length
    };
  } catch (error) {
    return {
      sent: false,
      error: error.message
    };
  }
}

function buildTelegramMessage(mtf) {
  const entry =
    mtf.ENTRY_CONFIRMATION ||
    {};

  const levels =
    mtf.TRADE_LEVELS ||
    null;

  const price =
    entry.currentPrice ??
    mtf.importantLevels?.currentPrice ??
    "N/A";

  let message =
    `XAUUSD MTF ALERT\n\n` +
    `Price: ${price}\n` +
    `Status: ${entry.status || "Waiting"}\n` +
    `Direction: ${entry.direction || "None"}\n\n` +

    `1H: ${mtf.MTF?.["1H"] || "N/A"}\n` +
    `15M: ${mtf.MTF?.["15M"] || "N/A"}\n` +
    `5M: ${mtf.MTF?.["5M"] || "N/A"}\n` +
    `Alignment: ${mtf.MTF?.alignment || "N/A"}\n\n` +

    `Bull Score: ${entry.bullishScore ?? 0}\n` +
    `Bear Score: ${entry.bearishScore ?? 0}\n\n` +

    `BOS / CHoCH / MSS\n` +
    `1H BOS: ${mtf.MTF_CONFIRMATION?.HTF_BOS || "None"}\n` +
    `15M CHoCH: ${mtf.MTF_CONFIRMATION?.["15M_CHoCH"] || "None"}\n` +
    `5M BOS: ${mtf.MTF_CONFIRMATION?.LTF_BOS || "None"}\n` +
    `5M CHoCH: ${mtf.MTF_CONFIRMATION?.["5M_CHoCH"] || "None"}\n`;

  if (
    entry.bullishReasons?.length
  ) {
    message +=
      `\nBullish Reasons:\n` +
      entry.bullishReasons
        .slice(0, 8)
        .map(x => `• ${x}`)
        .join("\n") +
      "\n";
  }

  if (
    entry.bearishReasons?.length
  ) {
    message +=
      `\nBearish Reasons:\n` +
      entry.bearishReasons
        .slice(0, 8)
        .map(x => `• ${x}`)
        .join("\n") +
      "\n";
  }

  if (levels) {
    message +=
      `\nTRADE LEVELS\n` +
      `Entry: ${levels.entry}\n` +
      `SL: ${levels.stopLoss}\n` +
      `TP1: ${levels.takeProfit.TP1_1R}\n` +
      `TP2: ${levels.takeProfit.TP2_1_5R}\n` +
      `TP3: ${levels.takeProfit.TP3_2R}\n`;
  }

  return message;
}

/* =========================================================
   INDICATORS
========================================================= */

function ema(values, period) {
  if (values.length < period) {
    return null;
  }

  const k =
    2 / (period + 1);

  let e =
    avg(
      values.slice(
        0,
        period
      )
    );

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    e =
      values[i] * k +
      e * (1 - k);
  }

  return e;
}

function emaSeries(
  values,
  period
) {
  if (
    values.length <
    period
  ) {
    return [];
  }

  const result =
    new Array(
      values.length
    ).fill(null);

  const k =
    2 / (period + 1);

  let e =
    avg(
      values.slice(
        0,
        period
      )
    );

  result[
    period - 1
  ] = e;

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    e =
      values[i] * k +
      e * (1 - k);

    result[i] = e;
  }

  return result;
}

function rsi(
  values,
  period = 14
) {
  if (
    values.length <= period
  ) {
    return null;
  }

  let gains = 0;
  let losses = 0;

  for (
    let i = 1;
    i <= period;
    i++
  ) {
    const diff =
      values[i] -
      values[i - 1];

    if (diff >= 0) {
      gains += diff;
    } else {
      losses +=
        Math.abs(diff);
    }
  }

  let avgGain =
    gains / period;

  let avgLoss =
    losses / period;

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {
    const diff =
      values[i] -
      values[i - 1];

    const gain =
      diff > 0
        ? diff
        : 0;

    const loss =
      diff < 0
        ? Math.abs(diff)
        : 0;

    avgGain =
      (
        avgGain *
          (period - 1) +
        gain
      ) / period;

    avgLoss =
      (
        avgLoss *
          (period - 1) +
        loss
      ) / period;
  }

  if (avgLoss === 0) {
    return 100;
  }

  const rs =
    avgGain / avgLoss;

  return (
    100 -
    100 / (1 + rs)
  );
}

function atr(
  candles,
  period = 14
) {
  if (
    candles.length <= period
  ) {
    return null;
  }

  const trs = [];

  for (
    let i = 1;
    i < candles.length;
    i++
  ) {
    const c =
      candles[i];

    const p =
      candles[i - 1];

    trs.push(
      Math.max(
        c.high - c.low,

        Math.abs(
          c.high -
          p.close
        ),

        Math.abs(
          c.low -
          p.close
        )
      )
    );
  }

  return avg(
    trs.slice(-period)
  );
}

function macd(values) {
  if (
    values.length < 35
  ) {
    return null;
  }

  const e12 =
    ema(values, 12);

  const e26 =
    ema(values, 26);

  if (
    !Number.isFinite(e12) ||
    !Number.isFinite(e26)
  ) {
    return null;
  }

  const s12 =
    emaSeries(values, 12);

  const s26 =
    emaSeries(values, 26);

  const series = [];

  for (
    let i = 0;
    i < values.length;
    i++
  ) {
    if (
      Number.isFinite(s12[i]) &&
      Number.isFinite(s26[i])
    ) {
      series.push(
        s12[i] - s26[i]
      );
    }
  }

  const signal =
    ema(series, 9);

  const line =
    e12 - e26;

  if (
    !Number.isFinite(signal)
  ) {
    return {
      line,
      signal: null,
      histogram: null,
      bias: "Unknown"
    };
  }

  const histogram =
    line - signal;

  return {
    line,
    signal,
    histogram,

    bias:
      histogram > 0
        ? "Bullish"
        : histogram < 0
          ? "Bearish"
          : "Neutral"
  };
}

/* =========================================================
   MARKET STRUCTURE
========================================================= */

function detectSwings(
  candles,
  left = 2,
  right = 2
) {
  const highs = [];
  const lows = [];

  for (
    let i = left;
    i < candles.length - right;
    i++
  ) {
    let highPivot = true;
    let lowPivot = true;

    for (
      let j = i - left;
      j <= i + right;
      j++
    ) {
      if (j === i) continue;

      if (
        candles[j].high >=
        candles[i].high
      ) {
        highPivot = false;
      }

      if (
        candles[j].low <=
        candles[i].low
      ) {
        lowPivot = false;
      }
    }

    if (highPivot) {
      highs.push({
        index: i,
        price:
          candles[i].high,
        time:
          candles[i].time
      });
    }

    if (lowPivot) {
      lows.push({
        index: i,
        price:
          candles[i].low,
        time:
          candles[i].time
      });
    }
  }

  return {
    highs,
    lows
  };
}

function structureAnalysis(
  candles
) {
  const {
    highs,
    lows
  } =
    detectSwings(
      candles
    );

  const h1 =
    last(highs);

  const h2 =
    highs.length > 1
      ? highs[
          highs.length - 2
        ]
      : null;

  const l1 =
    last(lows);

  const l2 =
    lows.length > 1
      ? lows[
          lows.length - 2
        ]
      : null;

  const HH =
    !!(
      h1 &&
      h2 &&
      h1.price >
        h2.price
    );

  const LH =
    !!(
      h1 &&
      h2 &&
      h1.price <
        h2.price
    );

  const HL =
    !!(
      l1 &&
      l2 &&
      l1.price >
        l2.price
    );

  const LL =
    !!(
      l1 &&
      l2 &&
      l1.price <
        l2.price
    );

  let structure =
    "Mixed Structure";

  if (HH && HL) {
    structure =
      "Bullish Structure";
  } else if (
    LH && LL
  ) {
    structure =
      "Bearish Structure";
  }

  return {
    structure,
    HH,
    HL,
    LH,
    LL,

    latestSwingHigh:
      h1,

    previousSwingHigh:
      h2,

    latestSwingLow:
      l1,

    previousSwingLow:
      l2
  };
}

/* =========================================================
   BOS / CHOCH / MSS
========================================================= */

function structureBreakAnalysis(
  candles,
  structure
) {
  const current =
    last(candles);

  const prev =
    previous(candles);

  if (!current || !prev) {
    return {
      BOS: "None",
      CHoCH: "None",
      MSS: "None",
      brokenLevel: null,
      direction: "None"
    };
  }

  const atrValue =
    atr(candles, 14) ||
    0;

  const buffer =
    atrValue * 0.03;

  const brokeHigh =
    structure.latestSwingHigh &&
    current.close >
      structure.latestSwingHigh.price +
      buffer &&
    prev.close <=
      structure.latestSwingHigh.price +
      buffer;

  const brokeLow =
    structure.latestSwingLow &&
    current.close <
      structure.latestSwingLow.price -
      buffer &&
    prev.close >=
      structure.latestSwingLow.price -
      buffer;

  const body =
    Math.abs(
      current.close -
      current.open
    );

  const range =
    current.high -
    current.low;

  const bodyRatio =
    range > 0
      ? body / range
      : 0;

  const displacement =
    atrValue > 0 &&
    range >=
      atrValue * 0.85 &&
    bodyRatio >= 0.50;

  if (
    brokeHigh &&
    displacement
  ) {
    const oldBearish =
      structure.structure ===
        "Bearish Structure" ||
      structure.LL;

    return {
      BOS:
        "Bullish BOS",

      CHoCH:
        oldBearish
          ? "Bullish CHoCH"
          : "None",

      MSS:
        oldBearish
          ? "Bullish MSS"
          : "None",

      brokenLevel:
        structure
          .latestSwingHigh
          .price,

      direction:
        "Bullish"
    };
  }

  if (
    brokeLow &&
    displacement
  ) {
    const oldBullish =
      structure.structure ===
        "Bullish Structure" ||
      structure.HH;

    return {
      BOS:
        "Bearish BOS",

      CHoCH:
        oldBullish
          ? "Bearish CHoCH"
          : "None",

      MSS:
        oldBullish
          ? "Bearish MSS"
          : "None",

      brokenLevel:
        structure
          .latestSwingLow
          .price,

      direction:
        "Bearish"
    };
  }

  return {
    BOS: "None",
    CHoCH: "None",
    MSS: "None",
    brokenLevel: null,
    direction: "None"
  };
}

/* =========================================================
   CANDLE
========================================================= */

function candleAnalysis(
  candles
) {
  const c =
    last(candles);

  const p =
    previous(candles);

  if (!c) return null;

  const range =
    c.high - c.low;

  const body =
    Math.abs(
      c.close -
      c.open
    );

  const upperWick =
    c.high -
    Math.max(
      c.open,
      c.close
    );

  const lowerWick =
    Math.min(
      c.open,
      c.close
    ) - c.low;

  const bodyRatio =
    range > 0
      ? body / range
      : 0;

  const bullish =
    c.close >
    c.open;

  const bearish =
    c.close <
    c.open;

  let strength =
    "Weak";

  if (
    bodyRatio >= 0.70
  ) {
    strength =
      "Strong";
  } else if (
    bodyRatio >= 0.45
  ) {
    strength =
      "Medium";
  }

  const patterns = [];

  if (
    bodyRatio <= 0.15
  ) {
    patterns.push(
      "Doji-like"
    );
  }

  if (
    p &&
    bullish &&
    p.close < p.open &&
    c.open <= p.close &&
    c.close >= p.open
  ) {
    patterns.push(
      "Bullish Engulfing"
    );
  }

  if (
    p &&
    bearish &&
    p.close > p.open &&
    c.open >= p.close &&
    c.close <= p.open
  ) {
    patterns.push(
      "Bearish Engulfing"
    );
  }

  if (
    lowerWick >
      body * 2 &&
    upperWick <
      body * 1.5
  ) {
    patterns.push(
      "Bullish Rejection"
    );
  }

  if (
    upperWick >
      body * 2 &&
    lowerWick <
      body * 1.5
  ) {
    patterns.push(
      "Bearish Rejection"
    );
  }

  const atrValue =
    atr(candles, 14);

  let displacement =
    "None";

  if (
    atrValue &&
    range >=
      atrValue * 1.2 &&
    bodyRatio >= 0.65
  ) {
    displacement =
      bullish
        ? "Bullish Displacement"
        : bearish
          ? "Bearish Displacement"
          : "None";
  }

  return {
    direction:
      bullish
        ? "Bullish"
        : bearish
          ? "Bearish"
          : "Neutral",

    strength,

    body:
      round(body, 5),

    range:
      round(range, 5),

    bodyRatio:
      round(bodyRatio, 3),

    upperWick:
      round(upperWick, 5),

    lowerWick:
      round(lowerWick, 5),

    patterns,

    displacement
  };
}

/* =========================================================
   LIQUIDITY
========================================================= */

function clusterLevels(
  values,
  tolerance
) {
  const sorted =
    [...values].sort(
      (a, b) => a - b
    );

  const clusters = [];

  for (
    const value of sorted
  ) {
    const existing =
      clusters.find(
        c =>
          Math.abs(
            c.price - value
          ) <= tolerance
      );

    if (existing) {
      existing.values.push(
        value
      );

      existing.price =
        avg(
          existing.values
        );

      existing.count++;
    } else {
      clusters.push({
        price: value,
        values: [value],
        count: 1
      });
    }
  }

  return clusters
    .filter(
      x => x.count >= 2
    )
    .sort(
      (a, b) =>
        b.count - a.count
    )
    .slice(0, 10)
    .map(x => ({
      price:
        round(
          x.price,
          5
        ),
      count:
        x.count
    }));
}

function liquidityAnalysis(
  candles
) {
  const atrValue =
    atr(candles, 14) ||
    1;

  const tolerance =
    atrValue * 0.08;

  const highs =
    candles.map(
      x => x.high
    );

  const lows =
    candles.map(
      x => x.low
    );

  const equalHighs =
    clusterLevels(
      highs,
      tolerance
    );

  const equalLows =
    clusterLevels(
      lows,
      tolerance
    );

  let latestSweep =
    "None";

  const recent =
    candles.slice(-8);

  for (
    const c of recent
  ) {
    const sweptHigh =
      equalHighs.some(
        x =>
          c.high >
            x.price +
            tolerance * 0.25 &&
          c.close <
            x.price
      );

    const sweptLow =
      equalLows.some(
        x =>
          c.low <
            x.price -
            tolerance * 0.25 &&
          c.close >
            x.price
      );

    if (sweptHigh) {
      latestSweep =
        "Bearish Liquidity Sweep";
    }

    if (sweptLow) {
      latestSweep =
        "Bullish Liquidity Sweep";
    }
  }

  return {
    equalHighs,
    equalLows,
    latestSweep
  };
}

/* =========================================================
   FVG
========================================================= */

function findFVG(
  candles,
  maxZones = 8
) {
  const bullish = [];
  const bearish = [];

  for (
    let i = 2;
    i < candles.length;
    i++
  ) {
    const a =
      candles[i - 2];

    const c =
      candles[i];

    if (
      a.high <
      c.low
    ) {
      bullish.push({
        low:
          round(
            a.high,
            5
          ),

        high:
          round(
            c.low,
            5
          ),

        index: i,

        time:
          candles[
            i - 1
          ].time
      });
    }

    if (
      a.low >
      c.high
    ) {
      bearish.push({
        low:
          round(
            c.high,
            5
          ),

        high:
          round(
            a.low,
            5
          ),

        index: i,

        time:
          candles[
            i - 1
          ].time
      });
    }
  }

  return {
    bullish:
      bullish.slice(
        -maxZones
      ),

    bearish:
      bearish.slice(
        -maxZones
      )
  };
}

/* =========================================================
   ORDER BLOCK
========================================================= */

function findOrderBlocks(
  candles,
  maxZones = 6
) {
  const bullish = [];
  const bearish = [];

  for (
    let i = 1;
    i < candles.length - 1;
    i++
  ) {
    const prev =
      candles[i - 1];

    const current =
      candles[i];

    const range =
      current.high -
      current.low;

    const body =
      Math.abs(
        current.close -
        current.open
      );

    const strongMove =
      range > 0 &&
      body / range >=
        0.65;

    if (!strongMove) {
      continue;
    }

    if (
      prev.close <
        prev.open &&
      current.close >
        current.open &&
      current.close >
        prev.high
    ) {
      bullish.push({
        low:
          round(
            prev.low,
            5
          ),

        high:
          round(
            prev.high,
            5
          ),

        index:
          i - 1,

        time:
          prev.time
      });
    }

    if (
      prev.close >
        prev.open &&
      current.close <
        current.open &&
      current.close <
        prev.low
    ) {
      bearish.push({
        low:
          round(
            prev.low,
            5
          ),

        high:
          round(
            prev.high,
            5
          ),

        index:
          i - 1,

        time:
          prev.time
      });
    }
  }

  return {
    bullish:
      bullish.slice(
        -maxZones
      ),

    bearish:
      bearish.slice(
        -maxZones
      )
  };
}

/* =========================================================
   SUPPORT / RESISTANCE
========================================================= */

function supportResistance(
  candles,
  structure
) {
  const current =
    last(candles);

  const supports = [];
  const resistances = [];

  if (
    structure.latestSwingLow
  ) {
    supports.push(
      structure
        .latestSwingLow
        .price
    );
  }

  if (
    structure.previousSwingLow
  ) {
    supports.push(
      structure
        .previousSwingLow
        .price
    );
  }

  if (
    structure.latestSwingHigh
  ) {
    resistances.push(
      structure
        .latestSwingHigh
        .price
    );
  }

  if (
    structure.previousSwingHigh
  ) {
    resistances.push(
      structure
        .previousSwingHigh
        .price
    );
  }

  const below =
    supports
      .filter(
        x =>
          x <
          current.close
      )
      .sort(
        (a, b) => b - a
      );

  const above =
    resistances
      .filter(
        x =>
          x >
          current.close
      )
      .sort(
        (a, b) => a - b
      );

  return {
    currentPrice:
      round(
        current.close,
        5
      ),

    support:
      below[0] ??
      null,

    nextSupport:
      below[1] ??
      null,

    resistance:
      above[0] ??
      null,

    nextResistance:
      above[1] ??
      null
  };
}

/* =========================================================
   SUPPLY / DEMAND
========================================================= */

function findSupplyDemand(
  candles,
  maxZones = 6
) {
  const demand = [];
  const supply = [];

  for (
    let i = 2;
    i < candles.length - 1;
    i++
  ) {
    const a =
      candles[i - 1];

    const b =
      candles[i];

    const range =
      b.high - b.low;

    const body =
      Math.abs(
        b.close -
        b.open
      );

    if (
      !range ||
      body / range <
        0.55
    ) {
      continue;
    }

    if (
      b.close >
        b.open &&
      b.close >
        a.high
    ) {
      demand.push({
        low:
          round(
            a.low,
            5
          ),

        high:
          round(
            a.high,
            5
          ),

        time:
          a.time
      });
    }

    if (
      b.close <
        b.open &&
      b.close <
        a.low
    ) {
      supply.push({
        low:
          round(
            a.low,
            5
          ),

        high:
          round(
            a.high,
            5
          ),

        time:
          a.time
      });
    }
  }

  return {
    demand:
      demand.slice(
        -maxZones
      ),

    supply:
      supply.slice(
        -maxZones
      )
  };
}

/* =========================================================
   VOLUME
========================================================= */

function volumeAnalysis(
  candles
) {
  const volumes =
    candles
      .map(
        x => x.volume
      )
      .filter(
        Number.isFinite
      );

  if (
    volumes.length <
    20
  ) {
    return {
      available: false,

      message:
        "Volume unavailable from data source"
    };
  }

  const current =
    last(volumes);

  const average =
    avg(
      volumes.slice(
        -20
      )
    );

  return {
    available: true,

    current:
      round(
        current,
        2
      ),

    average20:
      round(
        average,
        2
      ),

    ratio:
      round(
        current /
          average,
        2
      ),

    state:
      current >
        average * 1.5
        ? "High Volume"
        : current >
            average
          ? "Above Average"
          : "Normal/Low"
  };
}

/* =========================================================
   INDICATOR ANALYSIS
========================================================= */

function indicatorAnalysis(
  candles
) {
  const closes =
    candles.map(
      x => x.close
    );

  const EMA9 =
    ema(closes, 9);

  const EMA21 =
    ema(closes, 21);

  const EMA50 =
    ema(closes, 50);

  const RSI14 =
    rsi(closes, 14);

  const ATR14 =
    atr(candles, 14);

  const MACD =
    macd(closes);

  let trend =
    "Neutral";

  if (
    EMA9 > EMA21 &&
    EMA21 > EMA50
  ) {
    trend =
      "Strong Bullish";
  } else if (
    EMA9 < EMA21 &&
    EMA21 < EMA50
  ) {
    trend =
      "Strong Bearish";
  } else if (
    EMA9 > EMA21
  ) {
    trend =
      "Bullish";
  } else if (
    EMA9 < EMA21
  ) {
    trend =
      "Bearish";
  }

  let momentum =
    "Neutral Momentum";

  if (
    RSI14 >= 55
  ) {
    momentum =
      "Bullish Momentum";
  } else if (
    RSI14 <= 45
  ) {
    momentum =
      "Bearish Momentum";
  }

  return {
    EMA9:
      round(
        EMA9,
        5
      ),

    EMA21:
      round(
        EMA21,
        5
      ),

    EMA50:
      round(
        EMA50,
        5
      ),

    RSI14:
      round(
        RSI14,
        2
      ),

    ATR14:
      round(
        ATR14,
        5
      ),

    MACD:
      MACD
        ? {
            line:
              round(
                MACD.line,
                5
              ),

            signal:
              round(
                MACD.signal,
                5
              ),

            histogram:
              round(
                MACD.histogram,
                5
              ),

            bias:
              MACD.bias
          }
        : null,

    trend,
    momentum
  };
}

/* =========================================================
   RELEVANT ZONES
========================================================= */

function zoneContains(
  zone,
  price
) {
  return (
    Number.isFinite(
      zone.low
    ) &&
    Number.isFinite(
      zone.high
    ) &&
    price >= zone.low &&
    price <= zone.high
  );
}

function relevantZones(
  candles,
  fvg,
  ob,
  sd
) {
  const price =
    last(candles).close;

  const atrValue =
    atr(candles, 14) ||
    10;

  const maxDistance =
    atrValue * 4;

  const clean =
    arr =>
      arr
        .filter(
          z =>
            Number.isFinite(
              z.low
            ) &&
            Number.isFinite(
              z.high
            )
        )
        .map(
          z => ({
            ...z,

            distance:
              Math.min(
                Math.abs(
                  price -
                    z.low
                ),
                Math.abs(
                  price -
                    z.high
                )
              )
          })
        )
        .filter(
          z =>
            z.distance <=
            maxDistance
        )
        .sort(
          (a, b) =>
            a.distance -
            b.distance
        )
        .slice(
          0,
          3
        );

  return {
    bullishFVG:
      clean(
        fvg.bullish
      ),

    bearishFVG:
      clean(
        fvg.bearish
      ),

    bullishOB:
      clean(
        ob.bullish
      ),

    bearishOB:
      clean(
        ob.bearish
      ),

    demand:
      clean(
        sd.demand
      ),

    supply:
      clean(
        sd.supply
      )
  };
}

/* =========================================================
   TIMEFRAME ENGINE
========================================================= */

function analyzeTimeframe(
  candles,
  timeframe
) {
  const current =
    last(candles);

  const structure =
    structureAnalysis(
      candles
    );

  const breaks =
    structureBreakAnalysis(
      candles,
      structure
    );

  const candle =
    candleAnalysis(
      candles
    );

  const liquidity =
    liquidityAnalysis(
      candles
    );

  const FVG =
    findFVG(
      candles
    );

  const orderBlocks =
    findOrderBlocks(
      candles
    );

  const supportResistanceData =
    supportResistance(
      candles,
      structure
    );

  const supplyDemand =
    findSupplyDemand(
      candles
    );

  const volume =
    volumeAnalysis(
      candles
    );

  const indicators =
    indicatorAnalysis(
      candles
    );

  const zones =
    relevantZones(
      candles,
      FVG,
      orderBlocks,
      supplyDemand
    );

  return {
    timeframe,

    currentPrice:
      round(
        current?.close,
        5
      ),

    trend:
      indicators.trend,

    structure,

    BOS:
      breaks.BOS,

    CHoCH:
      breaks.CHoCH,

    MSS:
      breaks.MSS,

    breakDirection:
      breaks.direction,

    brokenLevel:
      breaks.brokenLevel,

    candle,

    liquidity,

    FVG,

    orderBlocks,

    supplyDemand,

    supportResistance:
      supportResistanceData,

    volume,

    indicators,

    zones,

    displacement:
      candle?.displacement ||
      "None"
  };
}

/* =========================================================
   MTF RETEST
========================================================= */

function buildRetest(
  a15,
  a5,
  currentPrice
) {
  const bullishZones = [
    ...(a5.zones?.bullishFVG || []),
    ...(a5.zones?.bullishOB || []),
    ...(a5.zones?.demand || [])
  ];

  const bearishZones = [
    ...(a5.zones?.bearishFVG || []),
    ...(a5.zones?.bearishOB || []),
    ...(a5.zones?.supply || [])
  ];

  const bullish =
    bullishZones
      .filter(
        z =>
          Number.isFinite(z.low) &&
          Number.isFinite(z.high)
      )
      .sort(
        (a, b) =>
          Math.abs(
            currentPrice -
              ((a.low + a.high) / 2)
          ) -
          Math.abs(
            currentPrice -
              ((b.low + b.high) / 2)
          )
      )[0] ||
    null;

  const bearish =
    bearishZones
      .filter(
        z =>
          Number.isFinite(z.low) &&
          Number.isFinite(z.high)
      )
      .sort(
        (a, b) =>
          Math.abs(
            currentPrice -
              ((a.low + a.high) / 2)
          ) -
          Math.abs(
            currentPrice -
              ((b.low + b.high) / 2)
          )
      )[0] ||
    null;

  return {
    bullishRetestZone:
      bullish
        ? {
            low:
              bullish.low,
            high:
              bullish.high
          }
        : null,

    bearishRetestZone:
      bearish
        ? {
            low:
              bearish.low,
            high:
              bearish.high
          }
        : null,

    priceInBullishZone:
      !!(
        bullish &&
        zoneContains(
          bullish,
          currentPrice
        )
      ),

    priceInBearishZone:
      !!(
        bearish &&
        zoneContains(
          bearish,
          currentPrice
        )
      ),

    bullishRetestConfirmed:
      !!(
        bullish &&
        zoneContains(
          bullish,
          currentPrice
        ) &&
        (
          a5.breakDirection ===
          "Bullish" ||
          a5.candle?.direction ===
          "Bullish"
        )
      ),

    bearishRetestConfirmed:
      !!(
        bearish &&
        zoneContains(
          bearish,
          currentPrice
        ) &&
        (
          a5.breakDirection ===
          "Bearish" ||
          a5.candle?.direction ===
          "Bearish"
        )
      )
  };
}

/* =========================================================
   TRENDLINE ENGINE
========================================================= */

function buildTrendline(points) {
  if (!Array.isArray(points) || points.length < 2) {
    return null;
  }

  const p1 = points[points.length - 2];
  const p2 = points[points.length - 1];

  if (
    !p1 ||
    !p2 ||
    p2.index <= p1.index ||
    !Number.isFinite(p1.price) ||
    !Number.isFinite(p2.price)
  ) {
    return null;
  }

  const slope =
    (p2.price - p1.price) /
    (p2.index - p1.index);

  return {
    start: p1,
    end: p2,
    slope,
    priceAt(index) {
      return p1.price + slope * (index - p1.index);
    }
  };
}

function trendlineVolumeConfirmation(candles, breakoutIndex) {
  const current = candles[breakoutIndex];
  if (!current) {
    return {
      available: false,
      confirmed: false,
      state: "Unavailable",
      ratio: null
    };
  }

  const values = candles
    .slice(Math.max(0, breakoutIndex - 20), breakoutIndex)
    .map(x => x.volume)
    .filter(Number.isFinite);

  if (values.length < 10 || !Number.isFinite(current.volume)) {
    return {
      available: false,
      confirmed: false,
      state: "Unavailable",
      ratio: null
    };
  }

  const baseline = avg(values);
  if (!Number.isFinite(baseline) || baseline <= 0) {
    return {
      available: false,
      confirmed: false,
      state: "Unavailable",
      ratio: null
    };
  }

  const ratio = current.volume / baseline;

  return {
    available: true,
    confirmed: ratio >= 1.2,
    state:
      ratio >= 1.5
        ? "Strong Volume"
        : ratio >= 1.2
          ? "Above Average"
          : "Normal/Low",
    current: round(current.volume, 2),
    average20: round(baseline, 2),
    ratio: round(ratio, 2)
  };
}

function findTrendlineBreakout(candles, direction, maxBars = 24) {
  if (!Array.isArray(candles) || candles.length < 40) {
    return {
      direction: "None",
      confirmed: false,
      trendline: null,
      breakoutIndex: null,
      breakoutPrice: null,
      strength: "None",
      candle: null,
      volume: {
        available: false,
        confirmed: false,
        state: "Unavailable",
        ratio: null
      },
      retest: null,
      projectionDistance: null,
      targetProjection: null
    };
  }

  const swings = detectSwings(candles, 2, 2);
  const atrValue = atr(candles, 14) || 0;
  const tolerance = atrValue > 0 ? atrValue * 0.08 : 0.5;
  const endIndex = candles.length - 1;

  let points;
  let trendline;
  let breakoutIndex = null;
  let breakoutCandle = null;

  if (direction === "Bullish") {
    const descendingHighs = swings.highs.filter((p, i, arr) => {
      if (i < 1) return false;
      const prev = arr[i - 1];
      return p.price < prev.price;
    });

    points = descendingHighs.slice(-2);
    trendline = buildTrendline(points);

    if (trendline && trendline.slope < 0) {
      for (let i = Math.max(0, trendline.end.index + 1); i <= endIndex; i++) {
        const c = candles[i];
        const line = trendline.priceAt(i);
        const prev = candles[i - 1];
        if (
          c.close > line + tolerance * 0.15 &&
          prev.close <= trendline.priceAt(i - 1) + tolerance * 0.15
        ) {
          breakoutIndex = i;
          breakoutCandle = c;
          break;
        }
      }
    }
  } else if (direction === "Bearish") {
    const ascendingLows = swings.lows.filter((p, i, arr) => {
      if (i < 1) return false;
      const prev = arr[i - 1];
      return p.price > prev.price;
    });

    points = ascendingLows.slice(-2);
    trendline = buildTrendline(points);

    if (trendline && trendline.slope > 0) {
      for (let i = Math.max(0, trendline.end.index + 1); i <= endIndex; i++) {
        const c = candles[i];
        const line = trendline.priceAt(i);
        const prev = candles[i - 1];
        if (
          c.close < line - tolerance * 0.15 &&
          prev.close >= trendline.priceAt(i - 1) - tolerance * 0.15
        ) {
          breakoutIndex = i;
          breakoutCandle = c;
          break;
        }
      }
    }
  }

  if (
    !trendline ||
    breakoutIndex === null ||
    !breakoutCandle ||
    endIndex - breakoutIndex > maxBars
  ) {
    return {
      direction,
      confirmed: false,
      trendline: trendline
        ? {
            start: trendline.start,
            end: trendline.end,
            slope: round(trendline.slope, 8),
            currentLine: round(trendline.priceAt(endIndex), 5)
          }
        : null,
      breakoutIndex: null,
      breakoutPrice: null,
      strength: "None",
      candle: null,
      volume: {
        available: false,
        confirmed: false,
        state: "Unavailable",
        ratio: null
      },
      retest: null,
      projectionDistance: null,
      targetProjection: null
    };
  }

  const range = breakoutCandle.high - breakoutCandle.low;
  const body = Math.abs(breakoutCandle.close - breakoutCandle.open);
  const bodyRatio = range > 0 ? body / range : 0;
  const closeLocation =
    range > 0
      ? direction === "Bullish"
        ? (breakoutCandle.close - breakoutCandle.low) / range
        : (breakoutCandle.high - breakoutCandle.close) / range
      : 0;

  const strongCandle = bodyRatio >= 0.55 && closeLocation >= 0.65;
  const displacement =
    atrValue > 0 && range >= atrValue * 1.1 && bodyRatio >= 0.6;

  const strength =
    displacement
      ? "Strong"
      : strongCandle
        ? "Valid"
        : "Weak";

  const volume = trendlineVolumeConfirmation(candles, breakoutIndex);

  let retest = {
    occurred: false,
    held: false,
    index: null,
    price: null,
    line: null
  };

  for (let i = breakoutIndex + 1; i <= endIndex; i++) {
    const c = candles[i];
    const line = trendline.priceAt(i);

    if (direction === "Bullish") {
      const touched = c.low <= line + tolerance;
      const held = touched && c.close > line;
      if (touched) {
        retest = {
          occurred: true,
          held,
          index: i,
          price: round(c.close, 5),
          line: round(line, 5)
        };
        if (held) break;
      }
    } else {
      const touched = c.high >= line - tolerance;
      const held = touched && c.close < line;
      if (touched) {
        retest = {
          occurred: true,
          held,
          index: i,
          price: round(c.close, 5),
          line: round(line, 5)
        };
        if (held) break;
      }
    }
  }

  const lastCandle = candles[endIndex];
  const lastLine = trendline.priceAt(endIndex);
  const continuation =
    direction === "Bullish"
      ? lastCandle.close > lastLine &&
        lastCandle.close >= lastCandle.open
      : lastCandle.close < lastLine &&
        lastCandle.close <= lastCandle.open;

  const referencePoint =
    direction === "Bullish"
      ? swings.lows
          .filter(x => x.index < breakoutIndex)
          .slice(-1)[0]
      : swings.highs
          .filter(x => x.index < breakoutIndex)
          .slice(-1)[0];

  const projectionDistance = referencePoint
    ? Math.abs(
        trendline.priceAt(referencePoint.index) -
          referencePoint.price
      )
    : null;

  const targetProjection =
    Number.isFinite(projectionDistance) && projectionDistance > 0
      ? direction === "Bullish"
        ? breakoutCandle.close + projectionDistance
        : breakoutCandle.close - projectionDistance
      : null;

  return {
    direction,
    confirmed: true,
    trendline: {
      start: trendline.start,
      end: trendline.end,
      slope: round(trendline.slope, 8),
      currentLine: round(lastLine, 5)
    },
    breakoutIndex,
    breakoutPrice: round(breakoutCandle.close, 5),
    strength,
    candle: {
      bodyRatio: round(bodyRatio, 3),
      closeLocation: round(closeLocation, 3),
      displacement,
      range: round(range, 5)
    },
    volume,
    retest,
    continuation,
    projectionDistance: round(projectionDistance, 5),
    targetProjection: round(targetProjection, 5)
  };
}

function trendlineScoreForDirection(
  direction,
  t1,
  t15,
  t5,
  a1,
  a15,
  a5
) {
  const isBullish = direction === "BUY";
  const oneH = isBullish ? t1.bullish : t1.bearish;
  const fifteen = isBullish ? t15.bullish : t15.bearish;
  const five = isBullish ? t5.bullish : t5.bearish;

  const opposite15 = isBullish ? t15.bearish : t15.bullish;
  const opposite5 = isBullish ? t5.bearish : t5.bullish;

  let score = 0;
  const reasons = [];
  const warnings = [];
  let hardBlock = false;

  const mainTrendAligned = isBullish
    ? (
        a1?.trend?.includes("Bullish") ||
        a1?.structure?.structure === "Bullish Structure"
      )
    : (
        a1?.trend?.includes("Bearish") ||
        a1?.structure?.structure === "Bearish Structure"
      );

  const mainTrendOpposite = isBullish
    ? (
        a1?.trend?.includes("Bearish") &&
        a1?.structure?.structure === "Bearish Structure"
      )
    : (
        a1?.trend?.includes("Bullish") &&
        a1?.structure?.structure === "Bullish Structure"
      );

  if (mainTrendOpposite) {
    hardBlock = true;
    warnings.push("1H trend and structure oppose the trendline direction");
  } else if (mainTrendAligned) {
    reasons.push("1H market direction supports trendline direction");
  }

  if (oneH.confirmed) {
    score += 1;
    reasons.push("1H valid trendline");
  } else {
    warnings.push("No confirmed 1H trendline breakout");
  }

  if (oneH.confirmed && oneH.strength !== "Weak") {
    score += 2;
    reasons.push("1H breakout candle body-close confirmed");
  } else if (oneH.confirmed) {
    warnings.push("1H breakout candle is weak");
  }

  if (oneH.strength === "Strong") {
    score += 1;
    reasons.push("1H breakout has strong displacement");
  }

  const fifteenTrendAligned = isBullish
    ? (
        a15?.trend?.includes("Bullish") ||
        a15?.structure?.structure === "Bullish Structure"
      )
    : (
        a15?.trend?.includes("Bearish") ||
        a15?.structure?.structure === "Bearish Structure"
      );

  const fifteenStrongOpposite = isBullish
    ? (
        a15?.trend?.includes("Bearish") &&
        a15?.structure?.structure === "Bearish Structure"
      )
    : (
        a15?.trend?.includes("Bullish") &&
        a15?.structure?.structure === "Bullish Structure"
      );

  if (fifteenStrongOpposite && opposite15?.confirmed && opposite15?.strength === "Strong") {
    hardBlock = true;
    warnings.push("Fresh strong opposite 15M breakout and structure detected");
  }

  if (fifteen.confirmed && fifteen.strength !== "Weak") {
    score += 2;
    reasons.push("15M trendline confirmation");
  } else if (fifteenTrendAligned && !fifteenStrongOpposite) {
    score += 2;
    reasons.push("15M structure/trend confirms direction");
  } else if (fifteen.confirmed) {
    warnings.push("15M breakout is weak");
  } else {
    warnings.push("15M direction is not fully confirmed");
  }

  const fiveStructure = isBullish
    ? (
        a5?.structure?.structure === "Bullish Structure" ||
        a5?.breakDirection === "Bullish" ||
        a5?.candle?.direction === "Bullish"
      )
    : (
        a5?.structure?.structure === "Bearish Structure" ||
        a5?.breakDirection === "Bearish" ||
        a5?.candle?.direction === "Bearish"
      );

  const fiveMomentum = isBullish
    ? (
        a5?.indicators?.RSI14 > 50 &&
        a5?.indicators?.MACD?.bias === "Bullish"
      )
    : (
        a5?.indicators?.RSI14 < 50 &&
        a5?.indicators?.MACD?.bias === "Bearish"
      );

  const oppositeFiveStrong = !!opposite5?.confirmed && opposite5?.strength === "Strong";

  if (oppositeFiveStrong && !fiveStructure) {
    hardBlock = true;
    warnings.push("Fresh strong opposite 5M breakout conflicts with entry");
  }

  if (fiveStructure && fiveMomentum) {
    score += 2;
    reasons.push("5M structure and momentum confirm entry");
  } else if (fiveStructure) {
    score += 1;
    reasons.push("5M structure supports entry");
    warnings.push("5M momentum is not fully aligned");
  } else {
    warnings.push("5M entry structure is not confirmed");
  }

  if (oneH.volume?.available) {
    if (oneH.volume.confirmed) {
      score += 1;
      reasons.push("1H breakout volume confirmation");
    } else {
      warnings.push("1H breakout volume is not expanded");
    }
  } else {
    warnings.push("Volume unavailable from candle source");
  }

  if (oneH.retest?.occurred && oneH.retest?.held) {
    score += 1;
    reasons.push("1H breakout retest held");
  } else if (oneH.retest?.occurred && !oneH.retest?.held) {
    hardBlock = true;
    warnings.push("1H breakout retest failed");
  } else if (oneH.continuation && oneH.strength === "Strong") {
    reasons.push("Strong continuation without retest");
  } else {
    warnings.push("No confirmed 1H retest or strong continuation");
  }

  if (opposite15?.confirmed && opposite15?.strength !== "Weak") {
    warnings.push(
      fifteenStrongOpposite
        ? "Opposite 15M trendline is structurally conflicting"
        : "Opposite 15M trendline detected but not treated as a standalone block"
    );
  }

  return {
    score: Math.max(0, Math.min(10, score)),
    reasons,
    warnings,
    hardBlock,
    retestRequired: false,
    retestOccurred: !!oneH.retest?.occurred,
    retestHeld: !!oneH.retest?.held,
    continuation: !!oneH.continuation,
    mainTrendAligned,
    fifteenTrendAligned,
    fiveStructure,
    fiveMomentum
  };
}

function buildTrendlineTradeLevels(direction, a1, a15, a5, trendlineData, tradeTimeframe = "5M") {
  const analysis = tradeTimeframe === "1H" ? a1 : tradeTimeframe === "15M" ? a15 : a5;
  const currentPrice = num(analysis?.currentPrice);
  const atrValue = num(analysis?.indicators?.ATR14);

  if (!Number.isFinite(currentPrice) || !Number.isFinite(atrValue) || atrValue <= 0) return null;

  const isBuy = direction === "BUY";
  const isSell = direction === "SELL";
  if (!isBuy && !isSell) return null;

  const t = isBuy ? trendlineData?.bullish : trendlineData?.bearish;
  if (!t?.confirmed || t.strength === "Weak") return null;

  const s = analysis.structure || {};
  const swingLow = num(s.latestSwingLow?.price);
  const swingHigh = num(s.latestSwingHigh?.price);
  const s1 = a1.structure || {};
  const s15 = a15.structure || {};
  const s5 = a5.structure || {};

  const ob = isBuy
    ? num(analysis.orderBlocks?.bullish?.[0]?.low ?? analysis.orderBlocks?.bullish?.[0]?.priceLow)
    : num(analysis.orderBlocks?.bearish?.[0]?.high ?? analysis.orderBlocks?.bearish?.[0]?.priceHigh);

  const sd = isBuy
    ? num(analysis.supplyDemand?.demand?.[0]?.low ?? analysis.supplyDemand?.demand?.[0]?.priceLow)
    : num(analysis.supplyDemand?.supply?.[0]?.high ?? analysis.supplyDemand?.supply?.[0]?.priceHigh);

  const retestLine = num(t?.retest?.line);
  const trendlineLine = num(t?.trendline?.currentLine);
  const breakoutPrice = num(t?.breakoutPrice);
  const noiseBuffer = Math.max(atrValue * 0.08, 0.05);
  const minimumRisk = atrValue * 0.25;
  const maximumRisk = atrValue * 1.50;

  const lowerLows = [num(s5.latestSwingLow?.price), num(s15.latestSwingLow?.price), num(s1.latestSwingLow?.price)].filter(Number.isFinite);
  const lowerHighs = [num(s5.latestSwingHigh?.price), num(s15.latestSwingHigh?.price), num(s1.latestSwingHigh?.price)].filter(Number.isFinite);

  const rawStops = isBuy
    ? [swingLow, ob, sd, ...lowerLows, retestLine, trendlineLine, breakoutPrice].filter(Number.isFinite).filter(x => x < currentPrice).sort((a,b)=>b-a)
    : [swingHigh, ob, sd, ...lowerHighs, retestLine, trendlineLine, breakoutPrice].filter(Number.isFinite).filter(x => x > currentPrice).sort((a,b)=>a-b);

  let stopLoss = null;
  for (const base of rawStops) {
    const candidate = isBuy ? base - noiseBuffer : base + noiseBuffer;
    const risk = Math.abs(currentPrice - candidate);
    if (risk >= minimumRisk && risk <= maximumRisk) { stopLoss = candidate; break; }
  }

  if (!Number.isFinite(stopLoss)) {
    const fallbackRisk = Math.min(maximumRisk, Math.max(minimumRisk, atrValue * 0.50));
    stopLoss = isBuy ? currentPrice - fallbackRisk : currentPrice + fallbackRisk;
  }

  const risk = Math.abs(currentPrice - stopLoss);
  if (!Number.isFinite(risk) || risk < minimumRisk || risk > maximumRisk) return null;

  const supportLevels = [
    num(analysis.supportResistance?.support), num(analysis.supportResistance?.nextSupport), swingLow,
    num(a5.supportResistance?.support), num(a5.supportResistance?.nextSupport),
    num(a15.supportResistance?.support), num(a15.supportResistance?.nextSupport),
    num(a1.supportResistance?.support), num(a1.supportResistance?.nextSupport)
  ];
  const resistanceLevels = [
    num(analysis.supportResistance?.resistance), num(analysis.supportResistance?.nextResistance), swingHigh,
    num(a5.supportResistance?.resistance), num(a5.supportResistance?.nextResistance),
    num(a15.supportResistance?.resistance), num(a15.supportResistance?.nextResistance),
    num(a1.supportResistance?.resistance), num(a1.supportResistance?.nextResistance)
  ];

  const projection = num(t.targetProjection);
  const targetPool = [...(isBuy ? resistanceLevels : supportLevels), projection]
    .filter(Number.isFinite).filter(x => isBuy ? x > currentPrice : x < currentPrice).sort((a,b)=>isBuy ? a-b : b-a);

  const minRR = 1.20;
  const dedupeGap = Math.max(atrValue * 0.05, 0.05);
  const targets = [];
  for (const target of targetPool) {
    const rr = Math.abs(target-currentPrice)/risk;
    if (rr < minRR) continue;
    if (targets.some(x=>Math.abs(x-target)<dedupeGap)) continue;
    targets.push(target);
    if (targets.length===3) break;
  }
  if (!targets.length) return null;

  for (const rr of [2.0,3.0]) {
    if (targets.length>=3) break;
    const target = isBuy ? currentPrice+risk*rr : currentPrice-risk*rr;
    if (!targets.some(x=>Math.abs(x-target)<dedupeGap)) targets.push(target);
  }

  const tp1=targets[0]??null, tp2=targets[1]??null, tp3=targets[2]??null;
  const rr1=Number.isFinite(tp1)?Math.abs(tp1-currentPrice)/risk:null;
  if (!Number.isFinite(rr1)||rr1<minRR) return null;

  return {
    timeframe: tradeTimeframe, direction, entry: round(currentPrice,5), stopLoss: round(stopLoss,5), risk: round(risk,5),
    takeProfit:{TP1:round(tp1,5),TP2:Number.isFinite(tp2)?round(tp2,5):null,TP3:Number.isFinite(tp3)?round(tp3,5):null},
    invalidation:round(stopLoss,5),
    targetMethod:`Real ${tradeTimeframe}/MTF structure + trendline projection; measured extensions only when required`,
    trendlineProjection:Number.isFinite(projection)?round(projection,5):null, riskRewardTP1:round(rr1,2)
  };
}

function buildIndependentTrendlineTradeSignal(direction, timeframe, analysis, trendlineData) {
  const isBuy = direction === "BUY";
  const trend = isBuy ? trendlineData?.bullish : trendlineData?.bearish;
  if (!trend?.confirmed || trend.strength === "Weak") return null;

  const label = timeframe;
  const structureAligned = isBuy
    ? (analysis?.structure?.structure === "Bullish Structure" || analysis?.breakDirection === "Bullish")
    : (analysis?.structure?.structure === "Bearish Structure" || analysis?.breakDirection === "Bearish");
  const momentumAligned = isBuy
    ? (Number(analysis?.indicators?.RSI14) > 50 && analysis?.indicators?.MACD?.bias === "Bullish")
    : (Number(analysis?.indicators?.RSI14) < 50 && analysis?.indicators?.MACD?.bias === "Bearish");
  const candleAligned = isBuy ? analysis?.candle?.direction === "Bullish" : analysis?.candle?.direction === "Bearish";

  let score=3; const reasons=[`${label} ${direction} trendline breakout confirmed`]; const warnings=[];
  if (trend.strength === "Strong") { score+=2; reasons.push(`${label} breakout has strong displacement`); }
  else { score+=1; reasons.push(`${label} breakout candle is valid`); }
  if (structureAligned) { score+=2; reasons.push(`${label} ${direction} structure confirmation`); } else warnings.push(`${label} structure break is not fully confirmed`);
  if (momentumAligned) { score+=2; reasons.push(`${label} ${direction} RSI + MACD momentum confirmation`); } else warnings.push(`${label} RSI/MACD momentum is not fully aligned`);
  if (candleAligned) { score+=1; reasons.push(`${label} ${direction} candle confirmation`); }
  if (trend.retest?.occurred && trend.retest?.held) { score+=1; reasons.push(`${label} breakout retest held`); }
  else if (trend.continuation) reasons.push(`${label} continuation confirmed`);

  return { ready: trend.confirmed && trend.strength!=="Weak" && structureAligned && momentumAligned && score>=7, direction, timeframe, score, maxScore:11, structureAligned, momentumAligned, candleAligned, reasons, warnings };
}

function build5MTrendlineTradeSignal(direction, a5, t5) {
  return buildIndependentTrendlineTradeSignal(direction, "5M", a5, t5);
}

function trendlineAnalysis(candles1H, candles15M, candles5M) {
  const a1=analyzeTimeframe(candles1H,"1H"), a15=analyzeTimeframe(candles15M,"15M"), a5=analyzeTimeframe(candles5M,"5M");
  const trendlines={
    "1H":{bullish:findTrendlineBreakout(candles1H,"Bullish",24),bearish:findTrendlineBreakout(candles1H,"Bearish",24)},
    "15M":{bullish:findTrendlineBreakout(candles15M,"Bullish",32),bearish:findTrendlineBreakout(candles15M,"Bearish",32)},
    "5M":{bullish:findTrendlineBreakout(candles5M,"Bullish",24),bearish:findTrendlineBreakout(candles5M,"Bearish",24)}
  };

  const bullishScoreData=trendlineScoreForDirection("BUY",trendlines["1H"],trendlines["15M"],trendlines["5M"],a1,a15,a5);
  const bearishScoreData=trendlineScoreForDirection("SELL",trendlines["1H"],trendlines["15M"],trendlines["5M"],a1,a15,a5);
  const analyses={"1H":a1,"15M":a15,"5M":a5};
  const independentSignals={};
  const independentLevels={};
  const timeframeState={};

  function classify(candidate, levels) {
    if (!candidate) return {status:"WAITING", lifecycle:"WAITING", ready:false};
    if (candidate.ready && levels) return {status:candidate.score>=9?"STRONG CONFIRMED":"CONFIRMED", lifecycle:"CONFIRMED", ready:true};
    const developing = !!(candidate.structureAligned || candidate.momentumAligned || candidate.candleAligned || candidate.score>=5);
    return developing ? {status:"DEVELOPING", lifecycle:"DEVELOPING", ready:false} : {status:"WAITING", lifecycle:"WAITING", ready:false};
  }

  for (const tf of ["1H","15M","5M"]) {
    independentSignals[tf]={};
    independentLevels[tf]={};
    for (const direction of ["BUY","SELL"]) {
      const candidate=buildIndependentTrendlineTradeSignal(direction,tf,analyses[tf],trendlines[tf]);
      let levels=candidate?.ready ? buildTrendlineTradeLevels(direction,a1,a15,a5,trendlines[tf],tf) : null;
      if (candidate?.ready && !levels) candidate.ready=false;
      const state=classify(candidate,levels);
      if (candidate) {
        candidate.lifecycle=state.lifecycle;
        candidate.status=state.status;
        candidate.levelsAvailable=!!levels;
      }
      independentSignals[tf][direction]=candidate;
      independentLevels[tf][direction]=levels;
    }

    const b=independentSignals[tf].BUY, s=independentSignals[tf].SELL;
    let selectedSignal=null, selectedLevels=null, selectedTrend=null;
    if (b?.ready && (!s?.ready || b.score>s.score)) { selectedSignal=b; selectedLevels=independentLevels[tf].BUY; selectedTrend=trendlines[tf].bullish; }
    else if (s?.ready && (!b?.ready || s.score>b.score)) { selectedSignal=s; selectedLevels=independentLevels[tf].SELL; selectedTrend=trendlines[tf].bearish; }

    const best=b?.score ?? 0 > (s?.score ?? 0) ? b : s;
    const developing=(b?.score??0)>=(s?.score??0) ? b : s;
    timeframeState[tf]={
      status:selectedSignal?selectedSignal.status:(developing?.lifecycle||"WAITING"),
      lifecycle:selectedSignal?selectedSignal.lifecycle:(developing?.lifecycle||"WAITING"),
      direction:selectedSignal?.direction||"None",
      score:selectedSignal?.score??developing?.score??0,
      confirmationGrade:selectedSignal?.score>=9?"STRONG":selectedSignal?.score>=7?"CONFIRMED":developing?.score>=5?"WATCH":"NONE",
      ready:!!selectedSignal,
      entry:selectedLevels?.entry??null,
      stopLoss:selectedLevels?.stopLoss??null,
      TP1:selectedLevels?.takeProfit?.TP1??null,
      TP2:selectedLevels?.takeProfit?.TP2??null,
      TP3:selectedLevels?.takeProfit?.TP3??null,
      reasons:selectedSignal?.reasons??developing?.reasons??[],
      warnings:selectedSignal?.warnings??developing?.warnings??[]
    };
  }

  const selected={};
  for (const tf of ["1H","15M","5M"]) {
    const b=independentSignals[tf].BUY, s=independentSignals[tf].SELL;
    if (b?.ready && (!s?.ready || b.score>s.score)) selected[tf]={signal:b,levels:independentLevels[tf].BUY,trend:trendlines[tf].bullish};
    else if (s?.ready && (!b?.ready || s.score>b.score)) selected[tf]={signal:s,levels:independentLevels[tf].SELL,trend:trendlines[tf].bearish};
    else selected[tf]={signal:null,levels:null,trend:null};
  }

  const readyTFs=["1H","15M","5M"].filter(tf=>selected[tf].signal);
  const primary=readyTFs.length===1?selected[readyTFs[0]]:readyTFs.length>1?selected[readyTFs[0]]:null;
  const primaryTF=readyTFs[0]||"None";
  const topSignal=primary?.signal ? {
    status:primary.signal.direction+" "+(primary.signal.score>=9?"STRONG CONFIRMED":"CONFIRMED"),
    direction:primary.signal.direction, score:primary.signal.score, maxScore:11,
    confirmationGrade:primary.signal.score>=9?"STRONG":"CONFIRMED", signalTimeframe:primaryTF,
    independentTimeframeBreakouts:true, reasons:primary.signal.reasons,warnings:primary.signal.warnings,
    retest:primary.trend?.retest??null,noRetestPath:!!(primary.trend?.continuation&&!primary.trend?.retest?.held),
    timeframeStatuses:timeframeState
  } : {
    status:"WAITING", direction:"None",
    score:Math.max(...["1H","15M","5M"].map(tf=>timeframeState[tf].score)), maxScore:11,
    confirmationGrade:"NONE", signalTimeframe:primaryTF, independentTimeframeBreakouts:true,
    reasons:["No independent timeframe trade is currently confirmed"], warnings:[], timeframeStatuses:timeframeState
  };

  return {
    success:true,instrument:OUTPUT_SYMBOL,generatedAt:new Date().toISOString(),currentPrice:a5.currentPrice,
    TRENDLINE_SIGNAL:topSignal,
    TRENDLINE_SCORE:{BUY:{...bullishScoreData,independentTimeframeSignals:independentSignals},SELL:{...bearishScoreData,independentTimeframeSignals:independentSignals}},
    TRENDLINES:trendlines,
    TRADE_LEVELS:primary?.levels||null,
    INDEPENDENT_TRADE_SIGNALS:{
      "1H":{signal:selected["1H"].signal,levels:selected["1H"].levels,state:timeframeState["1H"]},
      "15M":{signal:selected["15M"].signal,levels:selected["15M"].levels,state:timeframeState["15M"]},
      "5M":{signal:selected["5M"].signal,levels:selected["5M"].levels,state:timeframeState["5M"]}
    },
    analysis:analyses
  };
}

function buildTrendlineTelegramMessage(result) {
  const signal=result?.TRENDLINE_SIGNAL||{};
  let message=`XAUUSD INDEPENDENT TRENDLINE ALERT\n\nPrice: ${result?.currentPrice??"N/A"}\n\n`;
  for (const tf of ["1H","15M","5M"]) {
    const item=result?.INDEPENDENT_TRADE_SIGNALS?.[tf]||{};
    const s=item.signal||{};
    const l=item.levels||{};
    const state=item.state||{};
    message+=`${tf}: ${state.status||"WAITING"} | ${s.direction||state.direction||"None"} | Score ${s.score??state.score??0}/11\n`;
    if(l.entry) message+=`Entry: ${l.entry} | SL: ${l.stopLoss} | TP1: ${l.takeProfit?.TP1??"N/A"} | TP2: ${l.takeProfit?.TP2??"N/A"} | TP3: ${l.takeProfit?.TP3??"N/A"}\n`;
    if(state.reasons?.length) message+=`Confirmations: ${state.reasons.slice(0,5).join("; ")}\n`;
    if(state.warnings?.length) message+=`Warnings: ${state.warnings.slice(0,4).join("; ")}\n`;
    message+=`\n`;
  }
  if(signal.direction && signal.direction!=="None") message+=`Primary confirmed timeframe: ${signal.signalTimeframe}\n`;
  message+=`Independent timeframes: YES\n`;
  return message;
}

function trendlineAlertKey(result, timeframe = "5M") {
  const selected = result?.INDEPENDENT_TRADE_SIGNALS?.[timeframe] || {};
  const signal = selected.signal || {};
  if (!signal.direction || signal.direction === "None") return null;
  const tl = result.TRENDLINES?.[timeframe]?.[signal.direction === "BUY" ? "bullish" : "bearish"];
  return `${timeframe}:${signal.direction}:${tl?.breakoutIndex ?? "na"}:${tl?.breakoutPrice ?? "na"}`;
}

/* =========================================================
   ENTRY CONFIRMATION
========================================================= */

function entryConfirmation(
  a1,
  a15,
  a5,
  retest
) {
  let bullishScore = 0;
  let bearishScore = 0;

  const bullishReasons = [];
  const bearishReasons = [];

  const bullishStructureBreak =
    a5.breakDirection ===
    "Bullish";

  const bearishStructureBreak =
    a5.breakDirection ===
    "Bearish";

  const bullishTechnical =
    a5.indicators?.RSI14 > 50 &&
    a5.indicators?.MACD?.bias ===
      "Bullish";

  const bearishTechnical =
    a5.indicators?.RSI14 < 50 &&
    a5.indicators?.MACD?.bias ===
      "Bearish";

  const bullishHTF =
    a1.structure.structure !==
    "Bearish Structure";

  const bearishHTF =
    a1.structure.structure !==
    "Bullish Structure";

  if (
    a1.structure.structure ===
    "Bullish Structure"
  ) {
    bullishScore += 2;
    bullishReasons.push(
      "1H bullish structure"
    );
  }

  if (
    a15.structure.structure ===
    "Bullish Structure"
  ) {
    bullishScore += 1;
    bullishReasons.push(
      "15M bullish structure"
    );
  }

  if (
    a15.breakDirection ===
    "Bullish"
  ) {
    bullishScore += 2;
    bullishReasons.push(
      "15M bullish structure confirmation"
    );
  }

  if (
    bullishStructureBreak
  ) {
    bullishScore += 3;
    bullishReasons.push(
      "5M bullish break"
    );
  }

  if (
    a5.indicators?.RSI14 >
    50
  ) {
    bullishScore += 1;
    bullishReasons.push(
      "RSI above 50"
    );
  }

  if (
    a5.indicators?.MACD?.bias ===
    "Bullish"
  ) {
    bullishScore += 1;
    bullishReasons.push(
      "MACD bullish"
    );
  }

  if (
    a5.liquidity?.latestSweep ===
    "Bullish Liquidity Sweep"
  ) {
    bullishScore += 2;
    bullishReasons.push(
      "Bullish liquidity sweep"
    );
  }

  if (
    a5.candle?.direction ===
      "Bullish" &&
    (
      a5.candle?.strength ===
        "Strong" ||
      a5.candle?.patterns?.includes(
        "Bullish Engulfing"
      ) ||
      a5.candle?.patterns?.includes(
        "Bullish Rejection"
      )
    )
  ) {
    bullishScore += 1;
    bullishReasons.push(
      "Bullish candle confirmation"
    );
  }

  if (
    a1.structure.structure ===
    "Bearish Structure"
  ) {
    bearishScore += 2;
    bearishReasons.push(
      "1H bearish structure"
    );
  }

  if (
    a15.structure.structure ===
    "Bearish Structure"
  ) {
    bearishScore += 1;
    bearishReasons.push(
      "15M bearish structure"
    );
  }

  if (
    a15.breakDirection ===
    "Bearish"
  ) {
    bearishScore += 2;
    bearishReasons.push(
      "15M bearish structure confirmation"
    );
  }

  if (
    bearishStructureBreak
  ) {
    bearishScore += 3;
    bearishReasons.push(
      "5M bearish break"
    );
  }

  if (
    a5.indicators?.RSI14 <
    50
  ) {
    bearishScore += 1;
    bearishReasons.push(
      "RSI below 50"
    );
  }

  if (
    a5.indicators?.MACD?.bias ===
    "Bearish"
  ) {
    bearishScore += 1;
    bearishReasons.push(
      "MACD bearish"
    );
  }

  if (
    a5.liquidity?.latestSweep ===
    "Bearish Liquidity Sweep"
  ) {
    bearishScore += 2;
    bearishReasons.push(
      "Bearish liquidity sweep"
    );
  }

  if (
    a5.candle?.direction ===
      "Bearish" &&
    (
      a5.candle?.strength ===
        "Strong" ||
      a5.candle?.patterns?.includes(
        "Bearish Engulfing"
      ) ||
      a5.candle?.patterns?.includes(
        "Bearish Rejection"
      )
    )
  ) {
    bearishScore += 1;
    bearishReasons.push(
      "Bearish candle confirmation"
    );
  }

  const bullishConfirmed =
    bullishStructureBreak &&
    bullishTechnical &&
    bullishHTF &&
    bullishScore >= 7 &&
    bullishScore >
      bearishScore + 2;

  const bearishConfirmed =
    bearishStructureBreak &&
    bearishTechnical &&
    bearishHTF &&
    bearishScore >= 7 &&
    bearishScore >
      bullishScore + 2;

  let status =
    "WAITING";

  let direction =
    "None";

  if (
    bullishConfirmed
  ) {
    status =
      "BUY CONFIRMED";

    direction =
      "BUY";
  } else if (
    bearishConfirmed
  ) {
    status =
      "SELL CONFIRMED";

    direction =
      "SELL";
  }

  return {
    status,

    direction,

    bullishScore,

    bearishScore,

    bullishReasons,

    bearishReasons,

    bullishTechnical,

    bearishTechnical,

    bullishHTF,

    bearishHTF,

    bullishStructureBreak,

    bearishStructureBreak,

    retest
  };
}

/* =========================================================
   TRADE LEVELS
========================================================= */

function buildTradeLevels(
  direction,
  currentPrice,
  a5
) {
  if (
    direction !== "BUY" &&
    direction !== "SELL"
  ) {
    return null;
  }

  const atrValue =
    a5.indicators?.ATR14;

  if (
    !Number.isFinite(
      atrValue
    ) ||
    atrValue <= 0
  ) {
    return null;
  }

  const recentLow =
    a5.structure
      ?.latestSwingLow
      ?.price;

  const recentHigh =
    a5.structure
      ?.latestSwingHigh
      ?.price;

  let stopLoss;

  if (
    direction === "BUY"
  ) {
    stopLoss =
      Number.isFinite(
        recentLow
      )
        ? Math.min(
            recentLow,
            currentPrice -
              atrValue
          )
        : currentPrice -
          atrValue;
  } else {
    stopLoss =
      Number.isFinite(
        recentHigh
      )
        ? Math.max(
            recentHigh,
            currentPrice +
              atrValue
          )
        : currentPrice +
          atrValue;
  }

  const risk =
    Math.abs(
      currentPrice -
      stopLoss
    );

  if (
    !Number.isFinite(
      risk
    ) ||
    risk <= 0
  ) {
    return null;
  }

  const TP1 =
    direction === "BUY"
      ? currentPrice +
        risk
      : currentPrice -
        risk;

  const TP2 =
    direction === "BUY"
      ? currentPrice +
        risk * 1.5
      : currentPrice -
        risk * 1.5;

  const TP3 =
    direction === "BUY"
      ? currentPrice +
        risk * 2
      : currentPrice -
        risk * 2;

  return {
    direction,

    entry:
      round(
        currentPrice,
        5
      ),

    stopLoss:
      round(
        stopLoss,
        5
      ),

    risk:
      round(
        risk,
        5
      ),

    takeProfit: {
      TP1_1R:
        round(
          TP1,
          5
        ),

      TP2_1_5R:
        round(
          TP2,
          5
        ),

      TP3_2R:
        round(
          TP3,
          5
        )
    }
  };
}

/* =========================================================
   INVALIDATION
========================================================= */

function invalidation(
  a1,
  a15,
  a5
) {
  return {
    BUY: {
      primary:
        a5.structure
          ?.latestSwingLow
          ?.price ??
        null,

      secondary:
        a15.structure
          ?.latestSwingLow
          ?.price ??
        null,

      reason:
        "BUY invalidation if confirmed bullish structure fails below the latest protected swing low."
    },

    SELL: {
      primary:
        a5.structure
          ?.latestSwingHigh
          ?.price ??
        null,

      secondary:
        a15.structure
          ?.latestSwingHigh
          ?.price ??
        null,

      reason:
        "SELL invalidation if confirmed bearish structure fails above the latest protected swing high."
    }
  };
}

/* =========================================================
   MTF ANALYSIS
========================================================= */

async function mtfAnalysis() {
  const [
    candles1H,
    candles15M,
    candles5M
  ] =
    await Promise.all([
      getCandles(
        TF["1H"],
        350
      ),

      getCandles(
        TF["15M"],
        350
      ),

      getCandles(
        TF["5M"],
        350
      )
    ]);

  const a1 =
    analyzeTimeframe(
      candles1H,
      "1H"
    );

  const a15 =
    analyzeTimeframe(
      candles15M,
      "15M"
    );

  const a5 =
    analyzeTimeframe(
      candles5M,
      "5M"
    );

  const currentPrice =
    a5.currentPrice;

  const retest =
    buildRetest(
      a15,
      a5,
      currentPrice
    );

  const confirmation =
    entryConfirmation(
      a1,
      a15,
      a5,
      retest
    );

  const levels =
    buildTradeLevels(
      confirmation.direction,
      currentPrice,
      a5
    );

  let alignment =
    "Mixed MTF Alignment";

  if (
    a1.trend.includes(
      "Bullish"
    ) &&
    a15.trend.includes(
      "Bullish"
    ) &&
    a5.trend.includes(
      "Bullish"
    )
  ) {
    alignment =
      "Full MTF Bullish Alignment";
  } else if (
    a1.trend.includes(
      "Bearish"
    ) &&
    a15.trend.includes(
      "Bearish"
    ) &&
    a5.trend.includes(
      "Bearish"
    )
  ) {
    alignment =
      "Full MTF Bearish Alignment";
  }

  const structureBias =
    a1.structure.structure ===
      "Bullish Structure" &&
    a15.structure.structure !==
      "Bearish Structure"
      ? "Bullish"
      : a1.structure.structure ===
          "Bearish Structure" &&
        a15.structure.structure !==
          "Bullish Structure"
        ? "Bearish"
        : "Mixed";

  const reversalState =
    a1.CHoCH !== "None" ||
    a15.CHoCH !== "None" ||
    a5.CHoCH !== "None"
      ? "Potential Reversal"
      : "No Confirmed Reversal";

  const structure = {
    "1H":
      a1.structure.structure,

    "15M":
      a15.structure.structure,

    "5M":
      a5.structure.structure,

    structureBias,

    reversalState
  };

  return {
    success: true,

    instrument:
      OUTPUT_SYMBOL,

    generatedAt:
      new Date().toISOString(),

    MTF: {
      "1H":
        a1.trend,

      "15M":
        a15.trend,

      "5M":
        a5.trend,

      alignment
    },

    MTF_STRUCTURE:
      structure,

    MTF_CONFIRMATION: {
      HTF_BOS:
        a1.BOS,

      LTF_BOS:
        a5.BOS,

      "1H_CHoCH":
        a1.CHoCH,

      "15M_CHoCH":
        a15.CHoCH,

      "5M_CHoCH":
        a5.CHoCH,

      "1H_MSS":
        a1.MSS,

      "15M_MSS":
        a15.MSS,

      "5M_MSS":
        a5.MSS
    },

    ENTRY_CONFIRMATION: {
      ...confirmation,

      currentPrice:
        round(
          currentPrice,
          5
        )
    },

    RETEST:
      retest,

    TRADE_LEVELS:
      levels,

    TRENDLINE_ANALYSIS:
      await trendlineAnalysis(
        candles1H,
        candles15M,
        candles5M
      ),

    INVALIDATION:
      invalidation(
        a1,
        a15,
        a5
      ),

    importantLevels: {
      currentPrice:
        round(
          currentPrice,
          5
        ),

      support:
        a5.supportResistance
          .support,

      nextSupport:
        a5.supportResistance
          .nextSupport,

      resistance:
        a5.supportResistance
          .resistance,

      nextResistance:
        a5.supportResistance
          .nextResistance
    },

    analysis: {
      "1H": a1,
      "15M": a15,
      "5M": a5
    }
  };
}
/* =========================================================
   GEMINI AI
========================================================= */

async function openRouterAnalysis(mtf) {
  if (!OPENROUTER_API_KEY) {
    return {
      available: false,
      provider: "OpenRouter",
      message: "OPENROUTER_API_KEY not configured"
    };
  }

  const prompt = `
You are a financial market analysis assistant.

Analyze XAUUSD using ONLY the supplied technical engine output.
Do not invent price data.

Explain:
1. 1H bias
2. 15M bias
3. 5M bias
4. Market structure
5. BOS / CHoCH / MSS
6. Liquidity
7. FVG
8. Order blocks
9. Retest
10. Entry confirmation
11. Invalidation
12. Why the engine is BUY, SELL or WAITING

If confirmation is insufficient, explicitly say WAITING.
Do not claim certainty or guaranteed profit.

DATA:
${JSON.stringify(mtf, null, 2)}
`;

  try {
    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://xau-ai-bot-1.onrender.com",
          "X-Title": "XAU AI Strong Market Analysis Engine"
        },
        body: JSON.stringify({
          model: OPENROUTER_MODEL,
          models: [
            OPENROUTER_MODEL,
            OPENROUTER_FALLBACK_MODEL
          ],
          messages: [
            {
              role: "user",
              content: prompt
            }
          ],
          temperature: 0.2,
          max_tokens: 3000
        })
      }
    );

    const json = await response.json();

    if (!response.ok) {
      return {
        available: false,
        provider: "OpenRouter",
        error: json.error?.message || "OpenRouter request failed"
      };
    }

    const text =
      json.choices?.[0]?.message?.content ||
      "";

    if (!text) {
      return {
        available: false,
        provider: "OpenRouter",
        error: "OpenRouter returned an empty response"
      };
    }

    return {
      available: true,
      provider: "OpenRouter",
      model: json.model || OPENROUTER_MODEL,
      text
    };
  } catch (error) {
    return {
      available: false,
      provider: "OpenRouter",
      error: error.message
    };
  }
}

async function geminiAnalysis(mtf) {
  const prompt = `
You are a financial market analysis assistant.

Analyze XAUUSD using ONLY the supplied technical engine output.
Do not invent price data.

Explain:
1. 1H bias
2. 15M bias
3. 5M bias
4. Market structure
5. BOS / CHoCH / MSS
6. Liquidity
7. FVG
8. Order blocks
9. Retest
10. Entry confirmation
11. Invalidation
12. Why the engine is BUY, SELL or WAITING

If confirmation is insufficient, explicitly say WAITING.
Do not claim certainty or guaranteed profit.

DATA:
${JSON.stringify(mtf, null, 2)}
`;

  if (GEMINI_API_KEY) {
    try {
      const response = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": GEMINI_API_KEY
          },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  { text: prompt }
                ]
              }
            ]
          })
        }
      );

      const json = await response.json();

      if (response.ok) {
        const text =
          json.candidates?.[0]?.content?.parts?.[0]?.text ||
          "";

        if (text) {
          return {
            available: true,
            provider: "Gemini",
            model: "gemini-3.8-flash",
            text
          };
        }
      }

      console.log(
        "Gemini failed; trying OpenRouter fallback:",
        json.error?.message || "empty Gemini response"
      );
    } catch (error) {
      console.log(
        "Gemini request error; trying OpenRouter fallback:",
        error.message
      );
    }
  } else {
    console.log(
      "GEMINI_API_KEY not configured; trying OpenRouter fallback."
    );
  }

  const fallback = await openRouterAnalysis(mtf);

  if (fallback.available) {
    return fallback;
  }

  return {
    available: false,
    provider: "Gemini + OpenRouter",
    error:
      fallback.error ||
      fallback.message ||
      "Gemini and OpenRouter analysis unavailable"
  };
}

/* =========================================================
   HOURLY TELEGRAM STATUS
========================================================= */

let lastHourlyTelegramKey =
  null;

function buildHourlyTelegramMessage(
  mtf,
  ai = null
) {
  const entry =
    mtf.ENTRY_CONFIRMATION ||
    {};

  const structure =
    mtf.MTF_STRUCTURE ||
    {};

  const confirmation =
    mtf.MTF_CONFIRMATION ||
    {};

  const levels =
    mtf.TRADE_LEVELS ||
    null;

  const invalid =
    mtf.INVALIDATION ||
    {};

  const important =
    mtf.importantLevels ||
    {};

  const a1 =
    mtf.analysis?.["1H"] ||
    {};

  const a15 =
    mtf.analysis?.["15M"] ||
    {};

  const a5 =
    mtf.analysis?.["5M"] ||
    {};

  const price =
    entry.currentPrice ??
    important.currentPrice ??
    "N/A";

  const now =
    new Date();

  let message =
    `XAUUSD HOURLY STATUS\n\n` +

    `Time: ${now.toLocaleString(
      "en-IN",
      {
        timeZone:
          "Asia/Kolkata"
      }
    )} IST\n` +

    `Price: ${price}\n` +

    `Status: ${
      entry.status ||
      "Waiting"
    }\n` +

    `Direction: ${
      entry.direction ||
      "None"
    }\n\n` +

    `MTF TREND\n` +

    `1H: ${
      mtf.MTF?.["1H"] ||
      "N/A"
    }\n` +

    `15M: ${
      mtf.MTF?.["15M"] ||
      "N/A"
    }\n` +

    `5M: ${
      mtf.MTF?.["5M"] ||
      "N/A"
    }\n` +

    `Alignment: ${
      mtf.MTF?.alignment ||
      "N/A"
    }\n\n` +

    `MARKET STRUCTURE\n` +

    `1H: ${
      structure["1H"] ||
      a1.structure?.structure ||
      "N/A"
    }\n` +

    `15M: ${
      structure["15M"] ||
      a15.structure?.structure ||
      "N/A"
    }\n` +

    `5M: ${
      structure["5M"] ||
      a5.structure?.structure ||
      "N/A"
    }\n` +

    `Bias: ${
      structure.structureBias ||
      "N/A"
    }\n` +

    `Reversal: ${
      structure.reversalState ||
      "N/A"
    }\n\n` +

    `BOS / CHoCH / MSS\n` +

    `1H BOS: ${
      confirmation.HTF_BOS ||
      "None"
    } | CHoCH: ${
      confirmation["1H_CHoCH"] ||
      "None"
    } | MSS: ${
      confirmation["1H_MSS"] ||
      "None"
    }\n` +

    `15M BOS: ${
      a15.BOS ||
      "None"
    } | CHoCH: ${
      confirmation["15M_CHoCH"] ||
      "None"
    } | MSS: ${
      confirmation["15M_MSS"] ||
      "None"
    }\n` +

    `5M BOS: ${
      confirmation.LTF_BOS ||
      "None"
    } | CHoCH: ${
      confirmation["5M_CHoCH"] ||
      "None"
    } | MSS: ${
      confirmation["5M_MSS"] ||
      "None"
    }\n\n` +

    `LIQUIDITY / FVG / ORDER BLOCK\n` +

    `5M Liquidity: ${
      a5.liquidity?.latestSweep ||
      "None"
    }\n` +

    `5M FVG Count: ${
      (a5.FVG?.bullish?.length || 0) +
      (a5.FVG?.bearish?.length || 0)
    }\n` +

    `5M Order Block Count: ${
      (a5.orderBlocks?.bullish?.length || 0) +
      (a5.orderBlocks?.bearish?.length || 0)
    }\n` +

    `5M Displacement: ${
      a5.displacement ||
      "None"
    }\n\n` +

    `RETEST\n` +

    `Bullish Zone: ${
      mtf.RETEST
        ?.bullishRetestZone
        ? `${mtf.RETEST.bullishRetestZone.low} - ${mtf.RETEST.bullishRetestZone.high}`
        : "None"
    }\n` +

    `In Bullish Zone: ${
      mtf.RETEST
        ?.priceInBullishZone
        ? "YES"
        : "NO"
    }\n` +

    `Bearish Zone: ${
      mtf.RETEST
        ?.bearishRetestZone
        ? `${mtf.RETEST.bearishRetestZone.low} - ${mtf.RETEST.bearishRetestZone.high}`
        : "None"
    }\n` +

    `In Bearish Zone: ${
      mtf.RETEST
        ?.priceInBearishZone
        ? "YES"
        : "NO"
    }\n\n` +

    `SCORES\n` +

    `Bullish: ${
      entry.bullishScore ??
      0
    }\n` +

    `Bearish: ${
      entry.bearishScore ??
      0
    }\n\n` +

    `SUPPORT / RESISTANCE\n` +

    `Support: ${
      important.support ??
      "N/A"
    }\n` +

    `Next Support: ${
      important.nextSupport ??
      "N/A"
    }\n` +

    `Resistance: ${
      important.resistance ??
      "N/A"
    }\n` +

    `Next Resistance: ${
      important.nextResistance ??
      "N/A"
    }\n\n` +

    `INVALIDATION\n` +

    `BUY: ${
      invalid.BUY?.primary ??
      "N/A"
    }\n` +

    `SELL: ${
      invalid.SELL?.primary ??
      "N/A"
    }\n`;

  if (levels) {
    message +=
      `\nTRADE LEVELS\n` +

      `Direction: ${
        levels.direction ||
        entry.direction ||
        "None"
      }\n` +

      `Entry: ${
        levels.entry
      }\n` +

      `SL: ${
        levels.stopLoss
      }\n` +

      `TP1: ${
        levels.takeProfit
          ?.TP1_1R
      }\n` +

      `TP2: ${
        levels.takeProfit
          ?.TP2_1_5R
      }\n` +

      `TP3: ${
        levels.takeProfit
          ?.TP3_2R
      }\n`;
  } else {
    message +=
      `\nTRADE LEVELS\n` +
      `No confirmed trade levels — engine is still waiting.\n`;
  }

  if (
    entry.bullishReasons?.length
  ) {
    message +=
      `\nBULLISH REASONS\n` +

      entry.bullishReasons
        .slice(0, 8)
        .map(
          x => `• ${x}`
        )
        .join("\n") +

      "\n";
  }

  if (
    entry.bearishReasons?.length
  ) {
    message +=
      `\nBEARISH REASONS\n` +

      entry.bearishReasons
        .slice(0, 8)
        .map(
          x => `• ${x}`
        )
        .join("\n") +

      "\n";
  }

  if (
    ai?.available &&
    ai.text
  ) {
    message +=
      `\nAI ANALYSIS\n` +
      ai.text.slice(
        0,
        3000
      ) +
      "\n";
  } else if (ai) {
    message +=
      `\nAI ANALYSIS\n` +
      `Unavailable: ${
        ai.error ||
        ai.message ||
        "temporary unavailable"
      }\n`;
  }

  return message;
}

async function sendHourlyTelegramStatus() {
  try {
    const mtf =
      await mtfAnalysis();

    const ai =
      await geminiAnalysis(
        mtf
      );

    const now =
      new Date();

    const key =
      new Intl.DateTimeFormat(
        "en-IN",
        {
          timeZone:
            "Asia/Kolkata",

          year:
            "numeric",

          month:
            "2-digit",

          day:
            "2-digit",

          hour:
            "2-digit",

          hour12:
            false
        }
      ).format(now);

    if (
      lastHourlyTelegramKey ===
      key
    ) {
      return;
    }

    const result =
      await sendTelegramMessage(
        buildHourlyTelegramMessage(
          mtf,
          ai
        )
      );

    if (
      result.sent
    ) {
      lastHourlyTelegramKey =
        key;
    }

    console.log(
      "Hourly Telegram status:",
      result
    );

    return result;
  } catch (
    error
  ) {
    console.log(
      "Hourly Telegram status error:",
      error.message
    );

    return {
      sent: false,
      error:
        error.message
    };
  }
}

/*
  First hourly status after startup.
  Then one status every 60 minutes.
*/

setTimeout(
  sendHourlyTelegramStatus,
  10000
);

setInterval(
  sendHourlyTelegramStatus,
  60 * 60 * 1000
);
/* =========================================================
   TELEGRAM COMMAND SYSTEM
   Incoming Telegram commands via getUpdates.
   Restricted to TELEGRAM_CHAT_ID and safe read/monitor controls.
========================================================= */
/* =========================================================
   GOLDARA-STYLE SPECIAL SIGNAL ENGINE
   Separate Telegram-only signal layer. No trade execution.
========================================================= */
const GOLDARA_SIGNAL_COOLDOWN_MS = 5 * 60 * 1000;
const GOLDARA_MONITOR_MS = 60 * 1000;
let goldaraMonitorEnabled = true;
let goldaraMonitorBusy = false;
let goldaraLastScan = null;
let goldaraLastTelegram = null;
let goldaraLastError = null;
let goldaraLastSignalKey = null;
let goldaraLastSignalSentAt = 0;

function goldaraZoneHit(price, zones) {
  if (!Number.isFinite(price) || !Array.isArray(zones)) return false;
  return zones.some(z => {
    const low = Number(z?.low), high = Number(z?.high);
    if (!Number.isFinite(low) || !Number.isFinite(high)) return false;
    const pad = Math.abs(high - low) * 0.35;
    return price >= low - pad && price <= high + pad;
  });
}

function goldaraAnalyzeTimeframe(candles, timeframe) {
  const current = last(candles);
  const structure = structureAnalysis(candles);
  const br = structureBreakAnalysis(candles, structure);
  const liquidity = liquidityAnalysis(candles);
  const fvg = findFVG(candles, 8);
  const orderBlocks = findOrderBlocks(candles, 8);
  const candle = candleAnalysis(candles);
  const indicators = indicatorAnalysis(candles);
  return {
    timeframe,
    currentPrice: current?.close ?? null,
    trend: indicators?.trend || "Neutral",
    structure,
    break: br,
    liquidity,
    FVG: fvg,
    orderBlocks,
    candle,
    ATR: indicators?.ATR14 ?? atr(candles, 14),
    indicators,
    lastTime: current?.time || null
  };
}

function goldaraSetup(direction, a1, a15, a5) {
  const buy = direction === "BUY";
  const reasons = [], warnings = [];
  let score = 0;
  const trendOk = buy
    ? (a1.trend === "Strong Bullish" || a1.trend === "Bullish") && !["Strong Bearish","Bearish"].includes(a15.trend)
    : (a1.trend === "Strong Bearish" || a1.trend === "Bearish") && !["Strong Bullish","Bullish"].includes(a15.trend);
  if (trendOk) { score += 2; reasons.push("1H trend + 15M alignment"); }
  const structureOk = buy
    ? (a15.structure?.structure === "Bullish Structure" || a15.break?.direction === "Bullish")
    : (a15.structure?.structure === "Bearish Structure" || a15.break?.direction === "Bearish");
  if (structureOk) { score += 2; reasons.push("15M market structure"); }
  const bosChoch = buy
    ? (a15.break?.BOS === "Bullish BOS" || a15.break?.CHoCH === "Bullish CHoCH")
    : (a15.break?.BOS === "Bearish BOS" || a15.break?.CHoCH === "Bearish CHoCH");
  if (bosChoch) { score += 2; reasons.push("15M BOS/CHoCH"); }
  const ltfDisplacement = buy ? a5.break?.BOS === "Bullish BOS" : a5.break?.BOS === "Bearish BOS";
  if (ltfDisplacement) { score += 2; reasons.push("5M displacement BOS"); }
  const sweep = buy ? a5.liquidity?.latestSweep === "Bullish Liquidity Sweep" : a5.liquidity?.latestSweep === "Bearish Liquidity Sweep";
  if (sweep) { score += 1; reasons.push("Liquidity sweep"); }
  const zone = buy
    ? (goldaraZoneHit(a5.currentPrice, a5.FVG?.demand) || goldaraZoneHit(a5.currentPrice, a5.FVG?.bullish) || goldaraZoneHit(a5.currentPrice, a5.orderBlocks?.demand) || goldaraZoneHit(a5.currentPrice, a5.orderBlocks?.bullish))
    : (goldaraZoneHit(a5.currentPrice, a5.FVG?.supply) || goldaraZoneHit(a5.currentPrice, a5.FVG?.bearish) || goldaraZoneHit(a5.currentPrice, a5.orderBlocks?.supply) || goldaraZoneHit(a5.currentPrice, a5.orderBlocks?.bearish));
  if (zone) { score += 1; reasons.push("FVG / Order Block zone"); }
  const rsi5 = Number(a5.indicators?.RSI14), ema9 = Number(a5.indicators?.EMA9), ema21 = Number(a5.indicators?.EMA21);
  const momentum = buy ? rsi5 > 52 && a5.indicators?.MACD?.bias === "Bullish" && ema9 > ema21 : rsi5 < 48 && a5.indicators?.MACD?.bias === "Bearish" && ema9 < ema21;
  if (momentum) { score += 1; reasons.push("Momentum aligned"); }
  const patterns = a5.candle?.patterns || [];
  const candleOk = buy
    ? a5.candle?.direction === "Bullish" && (a5.candle?.strength === "Strong" || a5.candle?.displacement === "Strong" || patterns.includes("Bullish Engulfing") || patterns.includes("Bullish Rejection") || patterns.includes("Bullish Pin Bar"))
    : a5.candle?.direction === "Bearish" && (a5.candle?.strength === "Strong" || a5.candle?.displacement === "Strong" || patterns.includes("Bearish Engulfing") || patterns.includes("Bearish Rejection") || patterns.includes("Bearish Pin Bar"));
  if (candleOk) { score += 1; reasons.push("5M candle confirmation"); }
  const ready = score >= 8 && trendOk && ltfDisplacement && Number(a5.ATR) > 0;
  if (score < 8) warnings.push("Insufficient confluence");
  if (!trendOk) warnings.push("Higher-timeframe conflict");
  if (!ltfDisplacement) warnings.push("No fresh 5M displacement BOS");
  return {direction, score, maxScore:12, ready, reasons, warnings, confirmations:{trendOk,structureOk,bosChoch,ltfDisplacement,sweep,zone,momentum,candleOk}};
}

function goldaraLevels(direction, a5) {
  const price = Number(a5.currentPrice), A = Number(a5.ATR || 0);
  const structural = direction === "BUY" ? Number(a5.structure?.latestSwingLow?.price) : Number(a5.structure?.latestSwingHigh?.price);
  if (!Number.isFinite(price) || !Number.isFinite(A) || A <= 0 || !Number.isFinite(structural)) return null;
  const raw = Math.abs(price - structural);
  if (raw < A * 0.75 || raw > A * 1.80) return null;
  const stopLoss = direction === "BUY" ? price - raw : price + raw;
  const risk = Math.abs(price - stopLoss);
  return {entry:round(price,2),stopLoss:round(stopLoss,2),takeProfit:{TP1:round(direction === "BUY" ? price + risk*1.5 : price - risk*1.5,2),TP2:round(direction === "BUY" ? price + risk*2 : price - risk*2,2),TP3:round(direction === "BUY" ? price + risk*2.5 : price - risk*2.5,2)},risk:round(risk,2),rr:"1:1.5 / 1:2 / 1:2.5"};
}

async function goldaraScan() {
  const [c1,c15,c5] = await Promise.all([getCandles(TF["1H"],350),getCandles(TF["15M"],350),getCandles(TF["5M"],350)]);
  const a1=goldaraAnalyzeTimeframe(c1,"1H"),a15=goldaraAnalyzeTimeframe(c15,"15M"),a5=goldaraAnalyzeTimeframe(c5,"5M");
  const buy=goldaraSetup("BUY",a1,a15,a5),sell=goldaraSetup("SELL",a1,a15,a5),candidates=[];
  for(const setup of [buy,sell]) if(setup.ready){const levels=goldaraLevels(setup.direction,a5);if(levels)candidates.push({...setup,levels});}
  candidates.sort((a,b)=>b.score-a.score);
  const chosen=candidates[0]||null;
  const result={success:true,engine:"GOLDARA_STYLE_SMC_SIGNAL",mode:"TELEGRAM_SIGNAL_ONLY",execution:false,instrument:OUTPUT_SYMBOL,generatedAt:new Date().toISOString(),currentPrice:round(a5.currentPrice,2),MTF:{"1H":a1.trend,"15M":a15.trend,"5M":a5.trend},STRUCTURE:{"1H":a1.structure?.structure,"15M":a15.structure?.structure,"5M":a5.structure?.structure},SMC:{"15M":{BOS:a15.break?.BOS,CHoCH:a15.break?.CHoCH},"5M":{BOS:a5.break?.BOS,CHoCH:a5.break?.CHoCH,Liquidity:a5.liquidity?.latestSweep}},SETUPS:{BUY:buy,SELL:sell},SIGNAL:chosen?{status:`${chosen.direction} CONFIRMED`,...chosen}:{status:"WAITING",direction:"None",score:Math.max(buy.score,sell.score),maxScore:12,reasons:[],warnings:["No complete Goldara setup"]},TRADE_LEVELS:chosen?.levels||null};
  goldaraLastScan=result; return result;
}

function buildGoldaraTelegramMessage(x) {
  const s=x?.SIGNAL||{},l=x?.TRADE_LEVELS||{};
  const lines=["━━━━━━━━━━━━━━━━━━━━","⭐ GOLDARA SPECIAL SIGNAL","━━━━━━━━━━━━━━━━━━━━","",`XAUUSD ${s.direction||"WAITING"}`,`Status: ${s.status||"WAITING"}`,`Entry: ${l.entry??x?.currentPrice??"N/A"}`,`SL: ${l.stopLoss??"N/A"}`,`TP1: ${l.takeProfit?.TP1??"N/A"}`,`TP2: ${l.takeProfit?.TP2??"N/A"}`,`TP3: ${l.takeProfit?.TP3??"N/A"}`,`RR: ${l.rr??"N/A"}`,"",`Confluence: ${s.score??0}/${s.maxScore??12}`,"",`1H: ${x?.MTF?.["1H"]||"N/A"}`,`15M: ${x?.MTF?.["15M"]||"N/A"}`,`5M: ${x?.MTF?.["5M"]||"N/A"}`,`15M BOS: ${x?.SMC?.["15M"]?.BOS||"None"}`,`15M CHoCH: ${x?.SMC?.["15M"]?.CHoCH||"None"}`,`5M BOS: ${x?.SMC?.["5M"]?.BOS||"None"}`,`Liquidity: ${x?.SMC?.["5M"]?.Liquidity||"None"}`];
  if(s.reasons?.length) lines.push("","CONFIRMATIONS",...s.reasons.slice(0,12).map(z=>`✓ ${z}`));
  if(s.warnings?.length) lines.push("","WARNINGS",...s.warnings.slice(0,8).map(z=>`• ${z}`));
  lines.push("",`Time: ${new Date().toLocaleString("en-IN",{timeZone:"Asia/Kolkata",hour12:false})} IST`); return lines.join("\n");
}

function buildGoldaraWaitingMessage(x) {
  const s=x?.SIGNAL||{},b=x?.SETUPS?.BUY||{},s2=x?.SETUPS?.SELL||{};
  return ["━━━━━━━━━━━━━━━━━━━━","🟡 GOLDARA SPECIAL SCAN","━━━━━━━━━━━━━━━━━━━━","",`Status: ${s.status||"WAITING"}`,`Price: ${x?.currentPrice??"N/A"}`,`BUY score: ${b.score??0}/12`,`SELL score: ${s2.score??0}/12`,`1H: ${x?.MTF?.["1H"]||"N/A"}`,`15M: ${x?.MTF?.["15M"]||"N/A"}`,`5M: ${x?.MTF?.["5M"]||"N/A"}`,"","No confirmed Goldara signal at this moment.","This separate engine will alert only when its required conditions are met."].join("\n");
}

async function runGoldaraMonitor(){
  if(!goldaraMonitorEnabled||goldaraMonitorBusy)return; goldaraMonitorBusy=true;
  try{const x=await goldaraScan();goldaraLastError=null;const s=x.SIGNAL||{};if(s.ready&&s.direction&&x.TRADE_LEVELS){const key=`${s.direction}:${x.TRADE_LEVELS.entry}:${x.generatedAt.slice(0,16)}`;if(key!==goldaraLastSignalKey&&Date.now()-goldaraLastSignalSentAt>=GOLDARA_SIGNAL_COOLDOWN_MS){const result=await sendTelegramMessage(buildGoldaraTelegramMessage(x));goldaraLastTelegram=result;if(result?.sent){goldaraLastSignalKey=key;goldaraLastSignalSentAt=Date.now();}}}}catch(e){goldaraLastError=e.message;}finally{goldaraMonitorBusy=false;}
}
setTimeout(runGoldaraMonitor,20000);
setInterval(runGoldaraMonitor,GOLDARA_MONITOR_MS);

let telegramUpdateOffset = 0;
let telegramPollingRunning = false;
let telegramLastPollAt = null;
let telegramLastPollError = null;
let telegramCommandTimer = null;
let telegramTrendlineMonitorEnabled = true;

function telegramCommandHelp() {
  return [
    "🤖 XAUUSD AI BOT — COMMANDS",
    "",
    "/help — Show all commands",
    "/start — Bot online status + commands",
    "/status — Bot/Telegram/monitor status",
    "/health — Data + engine health",
    "/signal — Fresh XAUUSD signal analysis",
    "/analyze — Full fresh MTF analysis",
    "/trendline — Fresh trendline analysis",
    "/startmonitor — Start 60s trendline monitor",
    "/stopmonitor — Stop 60s trendline monitor",
    "/telegramtest — Test outgoing Telegram",
    "",
    "⭐ GOLDARA SPECIAL SIGNALS",
    "/goldara_help — Goldara commands",
    "/goldara — Fresh Goldara scan",
    "/goldara_signal — Fresh Goldara signal only",
    "/goldara_status — Goldara engine status",
    "/goldara_start — Start Goldara auto alerts",
    "/goldara_stop — Stop Goldara auto alerts",
    "/goldara_volume — Goldara 5M volume",
    "",
    "Instrument: XAUUSD",
    "Timeframes: 1H / 15M / 5M",
    "Signals are sent only when the engine's confirmation rules are met."
  ].join("\n");
}

function telegramCommandAllowed(message) {
  const incoming = String(message?.chat?.id ?? "");
  return !!incoming && incoming === String(TELEGRAM_CHAT_ID);
}

function telegramCommandName(text) {
  return String(text ?? "")
    .trim()
    .split(/\s+/)[0]
    .split("@")[0]
    .toLowerCase();
}

function telegramSignalSummary(mtf) {
  const e = mtf?.ENTRY_CONFIRMATION || {};
  const levels = mtf?.TRADE_LEVELS || null;
  const lines = [
    "📡 XAUUSD SIGNAL",
    "",
    `Status: ${e.status || "WAITING"}`,
    `Direction: ${e.direction || "None"}`,
    `Bull Score: ${e.bullishScore ?? 0}`,
    `Bear Score: ${e.bearishScore ?? 0}`,
    "",
    `1H: ${mtf?.MTF?.["1H"] || "N/A"}`,
    `15M: ${mtf?.MTF?.["15M"] || "N/A"}`,
    `5M: ${mtf?.MTF?.["5M"] || "N/A"}`,
    `Alignment: ${mtf?.MTF?.alignment || "N/A"}`
  ];
  if (levels) {
    lines.push(
      "",
      "TRADE LEVELS",
      `Entry: ${levels.entry ?? "N/A"}`,
      `SL: ${levels.stopLoss ?? "N/A"}`,
      `TP1: ${levels.takeProfit?.TP1_1R ?? "N/A"}`,
      `TP2: ${levels.takeProfit?.TP2_1_5R ?? "N/A"}`,
      `TP3: ${levels.takeProfit?.TP3_2R ?? "N/A"}`
    );
  } else {
    lines.push("", "No confirmed trade levels right now.");
  }
  if (e.bullishReasons?.length) {
    lines.push("", "BULLISH", ...e.bullishReasons.slice(0, 6).map(x => `• ${x}`));
  }
  if (e.bearishReasons?.length) {
    lines.push("", "BEARISH", ...e.bearishReasons.slice(0, 6).map(x => `• ${x}`));
  }
  return lines.join("\n");
}

async function handleTelegramCommand(message) {
  if (!telegramCommandAllowed(message)) return;
  const command = telegramCommandName(message?.text);
  if (!command) return;

  try {
    if (command === "/goldara_help") {
      await sendTelegramMessage(["⭐ GOLDARA SPECIAL SIGNAL ENGINE","","/goldara — Fresh Goldara scan","/goldara_signal — Signal/WAITING result","/goldara_status — Engine + last signal status","/goldara_start — Start automatic Goldara alerts","/goldara_stop — Stop automatic Goldara alerts","/goldara_volume — Current 5M volume","","Strategy: MTF trend + 15M structure + BOS/CHoCH + fresh 5M displacement BOS + liquidity + FVG/OB + momentum + candle confirmation.","Mode: Telegram signal only — no trade execution by this Goldara layer."].join("\n"));
      return;
    }
    if (command === "/goldara" || command === "/goldara_signal") {
      const x=await goldaraScan();
      await sendTelegramMessage(x?.SIGNAL?.ready&&x?.TRADE_LEVELS?buildGoldaraTelegramMessage(x):buildGoldaraWaitingMessage(x));
      return;
    }
    if (command === "/goldara_status") {
      const s=goldaraLastScan?.SIGNAL||{},l=goldaraLastScan?.TRADE_LEVELS||{};
      await sendTelegramMessage(["⭐ GOLDARA STATUS","",`Auto alerts: ${goldaraMonitorEnabled?"ON":"OFF"}`,`Monitor busy: ${goldaraMonitorBusy?"YES":"NO"}`,`Last scan: ${goldaraLastScan?.generatedAt||"N/A"}`,`Last Telegram: ${goldaraLastTelegram?.sent?"SENT":"N/A"}`,`Last error: ${goldaraLastError||"None"}`,"",`Signal: ${s.status||"WAITING"}`,`Direction: ${s.direction||"None"}`,`Score: ${s.score??0}/${s.maxScore??12}`,`Entry: ${l.entry??"N/A"}`,`SL: ${l.stopLoss??"N/A"}`,`TP1: ${l.takeProfit?.TP1??"N/A"}`,`TP2: ${l.takeProfit?.TP2??"N/A"}`,`TP3: ${l.takeProfit?.TP3??"N/A"}`].join("\n"));
      return;
    }
    if (command === "/goldara_start") {
      goldaraMonitorEnabled=true; setTimeout(runGoldaraMonitor,0);
      await sendTelegramMessage("▶️ GOLDARA SPECIAL AUTO ALERTS STARTED.\n\nScan interval: 60 seconds."); return;
    }
    if (command === "/goldara_stop") {
      goldaraMonitorEnabled=false;
      await sendTelegramMessage("⏹️ GOLDARA SPECIAL AUTO ALERTS STOPPED.\n\nUse /goldara_start to resume."); return;
    }
    if (command === "/goldara_volume") {
      try{const c=await getCandles(TF["5M"],100),v=c.map(x=>x.volume).filter(Number.isFinite);if(v.length<20){await sendTelegramMessage("⚠️ Goldara 5M volume data unavailable.");return;}const current=last(v),average=avg(v.slice(-20)),ratio=average?current/average:null,state=ratio==null?"Unknown":ratio>=1.5?"HIGH VOLUME":ratio>=1.1?"ABOVE AVERAGE":ratio<=0.7?"LOW VOLUME":"Normal";await sendTelegramMessage(["⭐ GOLDARA 5M VOLUME","",`Current: ${round(current,2)}`,`20-candle average: ${round(average,2)}`,`Ratio: ${ratio==null?"N/A":round(ratio,2)+"x"}`,`State: ${state}`].join("\n"));}catch(e){await sendTelegramMessage(`❌ Goldara volume error: ${e.message}`);} return;
    }

    if (command === "/help" || command === "/start") {
      await sendTelegramMessage(telegramCommandHelp());
      return;
    }

    if (command === "/status") {
      await sendTelegramMessage([
        "📊 XAUUSD BOT STATUS",
        "",
        `Telegram configured: ${TELEGRAM_BOT_TOKEN ? "YES" : "NO"}`,
        `Telegram polling: ${telegramPollingRunning ? "RUNNING" : "READY"}`,
        `Last Telegram poll: ${telegramLastPollAt || "N/A"}`,
        `Poll error: ${telegramLastPollError || "None"}`,
        `Trendline monitor: ${telegramTrendlineMonitorEnabled ? "ON" : "OFF"}`,
        `Trendline running: ${trendlineMonitorRunning ? "YES" : "NO"}`,
        `Last trendline scan: ${lastTrendlineMonitorFinishedAt || "N/A"}`,
        `Last trendline error: ${lastTrendlineMonitorError || "None"}`,
        `Last trendline signal: ${lastTrendlineMonitorSignal?.status || "N/A"}`,
        `Last trendline Telegram: ${lastTrendlineTelegramResult?.sent ? "SENT" : "N/A"}`,
        `HF ticks: ${HF_STATE?.ticks ?? 0}`,
        `HF last error: ${HF_STATE?.lastError || "None"}`
      ].join("\n"));
      return;
    }

    if (command === "/health") {
      const checks = [];
      try {
        const candles = await getCandles(TF["5M"], 80);
        checks.push(`5M candles: ${candles.length >= 60 ? "OK" : "LOW"} (${candles.length})`);
      } catch (e) {
        checks.push(`5M candles: ERROR — ${e.message}`);
      }
      checks.push(`Telegram token: ${TELEGRAM_BOT_TOKEN ? "OK" : "MISSING"}`);
      checks.push(`Telegram chat ID: ${TELEGRAM_CHAT_ID ? "OK" : "MISSING"}`);
      checks.push(`Trendline monitor: ${telegramTrendlineMonitorEnabled ? "ON" : "OFF"}`);
      checks.push(`HF engine: ${HF_STATE ? "LOADED" : "MISSING"}`);
      await sendTelegramMessage("🩺 XAUUSD HEALTH\n\n" + checks.join("\n"));
      return;
    }

    if (command === "/signal" || command === "/analyze") {
      const mtf = await mtfAnalysis();
      await sendTelegramMessage(telegramSignalSummary(mtf));
      return;
    }

    if (command === "/trendline") {
      const [candles1H, candles15M, candles5M] = await Promise.all([
        getCandles(TF["1H"], 350),
        getCandles(TF["15M"], 350),
        getCandles(TF["5M"], 350)
      ]);
      const result = trendlineAnalysis(candles1H, candles15M, candles5M);
      const primary = result?.TRENDLINE_SIGNAL || {};
      const levels = result?.TRADE_LEVELS || {};
      const lines = [
        "📈 XAUUSD TRENDLINE",
        "",
        `Status: ${primary.status || "WAITING"}`,
        `Direction: ${primary.direction || "None"}`,
        `Score: ${primary.score ?? 0}/${primary.maxScore ?? 11}`,
        `Timeframe: ${primary.signalTimeframe || "5M"}`,
        `Price: ${result?.currentPrice ?? "N/A"}`,
        `Entry: ${levels.entry ?? "N/A"}`,
        `SL: ${levels.stopLoss ?? "N/A"}`,
        `TP1: ${levels.takeProfit?.TP1 ?? levels.takeProfit?.TP1_1R ?? "N/A"}`
      ];
      await sendTelegramMessage(lines.join("\n"));
      return;
    }

    if (command === "/startmonitor") {
      telegramTrendlineMonitorEnabled = true;
      if (typeof monitorTrendlineSignal === "function") {
        setTimeout(monitorTrendlineSignal, 0);
      }
      await sendTelegramMessage("✅ Trendline monitor STARTED.\n\nAutomatic scan interval: 60 seconds.");
      return;
    }

    if (command === "/stopmonitor") {
      telegramTrendlineMonitorEnabled = false;
      await sendTelegramMessage("🛑 Trendline monitor STOPPED.\n\nNo automatic trendline scans will run until /startmonitor.");
      return;
    }

    if (command === "/telegramtest") {
      const result = await sendTelegramMessage("✅ Telegram command system is working.\n\nXAUUSD bot can receive and send commands.");
      if (!result?.sent) console.log("Telegram command test failed:", result);
      return;
    }

    await sendTelegramMessage("❓ Unknown command. Send /help");
  } catch (error) {
    telegramLastPollError = error.message;
    await sendTelegramMessage(`❌ Command ${command} failed\n\n${error.message}`);
  }
}

async function pollTelegramCommands() {
  if (telegramPollingRunning || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  telegramPollingRunning = true;
  telegramLastPollAt = new Date().toISOString();
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${telegramUpdateOffset}&timeout=0&allowed_updates=${encodeURIComponent(JSON.stringify(["message"]))}`;
    const response = await fetch(url);
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.description || "Telegram getUpdates failed");

    for (const update of data.result || []) {
      telegramUpdateOffset = Math.max(telegramUpdateOffset, Number(update.update_id) + 1);
      await handleTelegramCommand(update.message);
    }
    telegramLastPollError = null;
  } catch (error) {
    telegramLastPollError = error.message;
    console.log("Telegram command polling error:", error.message);
  } finally {
    telegramPollingRunning = false;
  }
}

async function telegramCommandLoop() {
  await pollTelegramCommands();
  telegramCommandTimer = setTimeout(telegramCommandLoop, 3000);
}

telegramCommandLoop();

app.get("/goldara-signal",async(req,res)=>{try{res.json(await goldaraScan());}catch(e){res.status(500).json({success:false,error:e.message});}});
app.get("/goldara-status",(req,res)=>res.json({success:true,instrument:OUTPUT_SYMBOL,engine:"GOLDARA_STYLE_SMC_SIGNAL",mode:"TELEGRAM_SIGNAL_ONLY",autoMonitorEnabled:goldaraMonitorEnabled,monitorBusy:goldaraMonitorBusy,lastScan:goldaraLastScan?.generatedAt||null,lastTelegram:goldaraLastTelegram,lastError:goldaraLastError,signal:goldaraLastScan?.SIGNAL||null,tradeLevels:goldaraLastScan?.TRADE_LEVELS||null}));

/* =========================================================
   HTTP STATUS DIAGNOSTIC
========================================================= */
app.get("/status", (req, res) => {
  res.json({
    success: true,
    instrument: OUTPUT_SYMBOL,
    telegram: {
      configured: !!TELEGRAM_BOT_TOKEN,
      chatConfigured: !!TELEGRAM_CHAT_ID,
      polling: telegramPollingRunning,
      lastPollAt: telegramLastPollAt,
      lastPollError: telegramLastPollError
    },
    trendlineMonitor: {
      enabled: telegramTrendlineMonitorEnabled,
      running: trendlineMonitorRunning,
      lastStartedAt: lastTrendlineMonitorStartedAt,
      lastFinishedAt: lastTrendlineMonitorFinishedAt,
      lastDurationMs: lastTrendlineMonitorDurationMs,
      lastError: lastTrendlineMonitorError,
      lastSignal: lastTrendlineMonitorSignal,
      lastDecision: lastTrendlineMonitorDecision,
      lastTelegram: lastTrendlineTelegramResult
    },
    hf: HF_STATE
  });

});

/* =========================================================
   AUTOMATIC TRENDLINE MONITOR
   Checks the confirmed trendline setup every 60 seconds.
========================================================= */

let lastTrendlineMonitorError = null;
let trendlineMonitorRunning = false;
let lastTrendlineMonitorStartedAt = null;
let lastTrendlineMonitorFinishedAt = null;
let lastTrendlineMonitorDurationMs = null;
let lastTrendlineMonitorSignal = null;
let lastTrendlineMonitorDecision = null;
let lastTrendlineTelegramResult = null;
let lastTrendlineAlertKey = null;

/*
  Internal trade-state memory for Telegram safety alerts.
  This does NOT claim that Liquid Chart has closed a position.
  It only remembers the last signal for which the bot sent an entry alert.
*/
const activeTrendlineTrades = new Map();
const lastDangerAlertKeys = new Map();
const lastDangerAlertResults = new Map();
const trendlineSignalLifecycle = new Map();

function getOppositeDangerForTimeframe(result, timeframe) {
  const activeTrade = activeTrendlineTrades.get(timeframe);
  if (!activeTrade?.direction) return {danger:false,level:"NONE",direction:null,reasons:[],key:null,timeframe};

  const opposite = activeTrade.direction === "BUY" ? "SELL" : "BUY";
  const a = result?.analysis?.[timeframe];
  const t = result?.TRENDLINES?.[timeframe] || {};
  const candidate = buildIndependentTrendlineTradeSignal(opposite,timeframe,a,t);
  const trend = opposite === "BUY" ? t.bullish : t.bearish;
  const developing = !!(trend?.confirmed && trend?.strength !== "Weak" && (candidate?.structureAligned || candidate?.momentumAligned || candidate?.candleAligned));
  const confirmed = !!candidate?.ready;
  if (!developing && !confirmed) return {danger:false,level:"NONE",direction:opposite,reasons:[],key:null,timeframe};

  const key=`${timeframe}:${activeTrade.direction}->${opposite}:${trend?.breakoutIndex ?? "na"}:${trend?.breakoutPrice ?? "na"}:${candidate?.score ?? 0}`;
  return {danger:true,level:confirmed?"CRITICAL":"DANGER",direction:opposite,score:candidate?.score??0,reasons:candidate?.reasons||[],warnings:candidate?.warnings||[],key,confirmed,timeframe};
}

function buildDangerTelegramMessage(result,danger) {
  const activeTrade=activeTrendlineTrades.get(danger.timeframe);
  const active=activeTrade?.direction||"UNKNOWN";
  let message=`⚠️ XAUUSD ${danger.level} ALERT\n\n`+
    `Trade timeframe: ${danger.timeframe}\n`+
    `Active trade: ${active}\n`+
    `Opposite setup: ${danger.direction||"UNKNOWN"}\n`+
    `Price: ${result?.currentPrice??"N/A"}\n`+
    `${danger.timeframe} opposite score: ${danger.score??0}/11\n\n`;
  if(danger.level==="CRITICAL") message+=`🚨 ACTION: CLOSE THE ${active} ${danger.timeframe} TRADE\nConfirmed opposite ${danger.direction} setup on the SAME timeframe.\n\n`;
  else message+=`⚠️ ACTION: DANGER — REVIEW/CLOSE THE ${active} ${danger.timeframe} TRADE\nOpposite setup is developing on the SAME timeframe.\n\n`;
  if(danger.reasons?.length) message+=`OPPOSITE CONFIRMATIONS\n`+danger.reasons.slice(0,8).map(x=>`• ${x}`).join("\n")+"\n";
  if(danger.warnings?.length) message+=`\nWARNINGS\n`+danger.warnings.slice(0,6).map(x=>`• ${x}`).join("\n")+"\n";
  return message;
}

async function monitorTrendlineSignal() {
  if (!telegramTrendlineMonitorEnabled) return;
  if (trendlineMonitorRunning) { console.log("Trendline monitor skipped: previous run still active"); return; }
  trendlineMonitorRunning=true; lastTrendlineMonitorStartedAt=new Date().toISOString(); const startedAt=Date.now();
  try {
    const [candles1H,candles15M,candles5M]=await Promise.all([getCandles(TF["1H"],350),getCandles(TF["15M"],350),getCandles(TF["5M"],350)]);
    const result=trendlineAnalysis(candles1H,candles15M,candles5M);
    const primary=result.TRENDLINE_SIGNAL||{};
    const primaryLevels=result.TRADE_LEVELS||{};
    lastTrendlineMonitorSignal={direction:primary.direction||"None",status:primary.status||"WAITING",score:primary.score??0,maxScore:primary.maxScore??11,confirmationGrade:primary.confirmationGrade||"NONE",signalTimeframe:primary.signalTimeframe||"5M",currentPrice:result.currentPrice??null,tradeLevelsAvailable:!!(primaryLevels.entry&&primaryLevels.stopLoss&&primaryLevels.takeProfit?.TP1),activeTrades:Object.fromEntries([...activeTrendlineTrades].map(([tf,v])=>[tf,v.direction]))};

    const perTf={};
    for(const tf of ["1H","15M","5M"]){
      const selected=result.INDEPENDENT_TRADE_SIGNALS?.[tf]||{};
      const signal=selected.signal||{}; const levels=selected.levels||{};
      const eligible=!!(signal.ready&&signal.direction&&levels.entry&&levels.stopLoss&&levels.takeProfit?.TP1);
      const key=trendlineAlertKey(result,tf);
      const stateKey=`XAUUSD:${tf}`; const previousKey=TRENDLINE_ALERT_STATE.get(stateKey)||null;
      perTf[tf]={eligible,direction:signal.direction||"None",score:signal.score??0,confirmationGrade:signal.score>=9?"STRONG":signal.score>=7?"CONFIRMED":signal.score>=5?"WATCH":"NONE",entry:levels.entry??null,stopLoss:levels.stopLoss??null,TP1:levels.takeProfit?.TP1??null,alertKey:key,previousAlertKey:previousKey,duplicateSuppressed:!!(key&&previousKey===key)};

      const danger=getOppositeDangerForTimeframe(result,tf);
      if(danger.danger&&danger.key!==lastDangerAlertKeys.get(tf)){
        const telegram=await sendTelegramMessage(buildDangerTelegramMessage(result,danger));
        const dangerResult={...telegram,attemptedAt:new Date().toISOString(),alertKey:danger.key,level:danger.level,timeframe:tf,activeDirection:activeTrendlineTrades.get(tf)?.direction||null,oppositeDirection:danger.direction};
        lastDangerAlertResults.set(tf,dangerResult);
        if(telegram?.sent){lastDangerAlertKeys.set(tf,danger.key);console.log("Opposite-trade danger alert sent:",danger.key);}
      }

      if (danger.danger) {
        trendlineSignalLifecycle.set(tf, danger.level === "CRITICAL" ? "CRITICAL" : "DANGER");
      } else if (eligible) {
        trendlineSignalLifecycle.set(tf, "CONFIRMED");
      } else if (signal.lifecycle === "DEVELOPING") {
        trendlineSignalLifecycle.set(tf, "DEVELOPING");
      } else {
        trendlineSignalLifecycle.set(tf, "WAITING");
      }

      if(eligible&&key&&previousKey!==key){
        const telegram=await sendTelegramMessage(buildTrendlineTelegramMessage({...result,TRENDLINE_SIGNAL:{...signal,signalTimeframe:tf},TRADE_LEVELS:levels}));
        lastTrendlineTelegramResult={...telegram,attemptedAt:new Date().toISOString(),alertKey:key,timeframe:tf};
        if(telegram?.sent){
          TRENDLINE_ALERT_STATE.set(stateKey,key); lastTrendlineAlertKey=key;
          activeTrendlineTrades.set(tf,{timeframe:tf,direction:signal.direction,entry:levels.entry,stopLoss:levels.stopLoss,takeProfit:levels.takeProfit||null,alertKey:key,startedAt:new Date().toISOString()});
          trendlineSignalLifecycle.set(tf,"ACTIVE");
          lastDangerAlertKeys.delete(tf); lastDangerAlertResults.delete(tf);
          console.log(`Independent ${tf} Trendline entry alert sent:`,key);
        }
      }
    }

    for (const tf of ["1H","15M","5M"]) {
      perTf[tf].lifecycle=trendlineSignalLifecycle.get(tf)||"WAITING";
    }
    lastTrendlineMonitorDecision={eligible:Object.values(perTf).some(x=>x.eligible),independentTimeframes:perTf};
    lastTrendlineMonitorError=null;
  } catch(error){
    lastTrendlineMonitorError=error.message; lastTrendlineTelegramResult={sent:false,reason:"Trendline monitor exception",error:error.message,attemptedAt:new Date().toISOString()}; console.log("Trendline monitor error:",error.message);
  } finally { lastTrendlineMonitorFinishedAt=new Date().toISOString(); lastTrendlineMonitorDurationMs=Date.now()-startedAt; trendlineMonitorRunning=false; }
}

setTimeout(monitorTrendlineSignal, 15000);
setInterval(monitorTrendlineSignal, 60 * 1000);

/* =========================================================
   SPECIAL TRENDLINE SIGNAL API
   Dedicated endpoint for Liquid Chart special Trendline trading.
   Uses the existing independent timeframe Trendline engine.
========================================================= */
app.get("/special-trendline-signal", async (req, res) => {
  try {
    const [candles1H, candles15M, candles5M] = await Promise.all([
      getCandles(TF["1H"], 350),
      getCandles(TF["15M"], 350),
      getCandles(TF["5M"], 350)
    ]);

    const result = trendlineAnalysis(candles1H, candles15M, candles5M);
    const timeframes = ["1H", "15M", "5M"];
    const candidates = [];

    for (const tf of timeframes) {
      const item = result?.INDEPENDENT_TRADE_SIGNALS?.[tf] || {};
      const signal = item.signal || {};
      const levels = item.levels || {};

      if (
        signal.ready === true &&
        (signal.direction === "BUY" || signal.direction === "SELL") &&
        Number.isFinite(Number(levels.entry)) &&
        Number.isFinite(Number(levels.stopLoss)) &&
        Number.isFinite(Number(levels.takeProfit?.TP1))
      ) {
        candidates.push({ timeframe: tf, signal, levels });
      }
    }

    candidates.sort((a, b) => Number(b.signal.score || 0) - Number(a.signal.score || 0));
    const selected = candidates[0] || null;

    let telegram = { sent: false, reason: "No new special Trendline signal" };

    if (selected) {
      const key = trendlineAlertKey(result, selected.timeframe);
      const stateKey = `XAUUSD:${selected.timeframe}`;
      if (key && TRENDLINE_ALERT_STATE.get(stateKey) !== key) {
        telegram = await sendTelegramMessage(
          buildTrendlineTelegramMessage({
            ...result,
            TRENDLINE_SIGNAL: {
              ...selected.signal,
              signalTimeframe: selected.timeframe,
              status: selected.signal.score >= 9 ? "SPECIAL STRONG CONFIRMED" : "SPECIAL CONFIRMED"
            },
            TRADE_LEVELS: selected.levels
          })
        );
        if (telegram?.sent) TRENDLINE_ALERT_STATE.set(stateKey, key);
      } else {
        telegram = { sent: false, reason: "Duplicate special Trendline signal suppressed", alertKey: key };
      }
    }

    res.json({
      success: true,
      instrument: OUTPUT_SYMBOL,
      generatedAt: new Date().toISOString(),
      mode: "SPECIAL_TRENDLINE_TRADE",
      currentPrice: result.currentPrice ?? null,
      executable: !!selected,
      SPECIAL_TRENDLINE_SIGNAL: selected
        ? {
            status: selected.signal.score >= 9 ? "SPECIAL STRONG CONFIRMED" : "SPECIAL CONFIRMED",
            direction: selected.signal.direction,
            score: selected.signal.score ?? 0,
            maxScore: 11,
            confirmationGrade: selected.signal.score >= 9 ? "STRONG" : "CONFIRMED",
            signalTimeframe: selected.timeframe,
            reasons: selected.signal.reasons || [],
            warnings: selected.signal.warnings || []
          }
        : {
            status: "WAITING",
            direction: "None",
            score: 0,
            maxScore: 11,
            confirmationGrade: "NONE",
            signalTimeframe: "None",
            reasons: ["No confirmed independent Trendline trade setup"],
            warnings: []
          },
      TRADE_LEVELS: selected ? selected.levels : null,
      TELEGRAM: telegram,
      TIMEFRAME_STATES: result?.TRENDLINE_SIGNAL?.timeframeStatuses || null
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      mode: "SPECIAL_TRENDLINE_TRADE"
    });
  }
});

/* =========================================================
   ROOT
========================================================= */

app.get(
  "/",
  (req, res) => {
    res.json({
      success: true,

      bot:
        "XAU AI Strong Market Analysis Engine",

      instrument:
        OUTPUT_SYMBOL,

      engine:
        "MTF + Price Action + SMC + Technical Analysis",

      timeframes: [
        "1H",
        "15M",
        "5M"
      ],

      endpoints: [
        "/gold-data",
        "/technical-analysis",
        "/mtf-analysis",
        "/analyze",
        "/gemini-test",
        "/telegram-test",
        "/status",
        "/trendline-analysis",
        "/trendline-monitor-status",
        "/hf/status",
        "/hf/decision",
        "/hf/tick"
      ],
      trendlineMonitor: {
        intervalSeconds: 60,
        running: trendlineMonitorRunning,
        lastStartedAt: lastTrendlineMonitorStartedAt,
        lastFinishedAt: lastTrendlineMonitorFinishedAt,
        lastDurationMs: lastTrendlineMonitorDurationMs,
        lastError: lastTrendlineMonitorError,
        lastSignal: lastTrendlineMonitorSignal,
        lastDecision: lastTrendlineMonitorDecision,
        lastTelegram: lastTrendlineTelegramResult,
        lastAlertKey: lastTrendlineAlertKey,
        activeTrades: Object.fromEntries([...activeTrendlineTrades].map(([tf,v]) => [tf,v])),
        lastDangerAlerts: Object.fromEntries([...lastDangerAlertResults].map(([tf,v]) => [tf,v]))
      }
    });
  }
);

/* =========================================================
   TRENDLINE MONITOR STATUS
   Diagnostic endpoint for the 60-second automatic monitor.
========================================================= */

app.get(
  "/trendline-monitor-status",
  (req, res) => {
    res.json({
      success: true,
      instrument: OUTPUT_SYMBOL,
      monitor: {
        intervalSeconds: 60,
        running: trendlineMonitorRunning,
        lastStartedAt: lastTrendlineMonitorStartedAt,
        lastFinishedAt: lastTrendlineMonitorFinishedAt,
        lastDurationMs: lastTrendlineMonitorDurationMs,
        lastError: lastTrendlineMonitorError,
        lastSignal: lastTrendlineMonitorSignal,
        lastDecision: lastTrendlineMonitorDecision,
        lastTelegram: lastTrendlineTelegramResult,
        lastAlertKey: lastTrendlineAlertKey,
        activeTrades: Object.fromEntries([...activeTrendlineTrades].map(([tf,v]) => [tf,v])),
        lastDangerAlerts: Object.fromEntries([...lastDangerAlertResults].map(([tf,v]) => [tf,v]))
      }
    });
  }
);

/* =========================================================
   GOLD DATA
========================================================= */

app.get(
  "/gold-data",
  async (req, res) => {
    try {
      const candles =
        await getCandles(
          TF["5M"],
          100
        );

      const current =
        last(candles);

      res.json({
        success: true,

        instrument:
          OUTPUT_SYMBOL,

        currentPrice:
          current?.close ??
          null,

        candle:
          current
      });
    } catch (
      error
    ) {
      res.status(500).json({
        success: false,
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   TECHNICAL ANALYSIS
========================================================= */

app.get(
  "/technical-analysis",
  async (req, res) => {
    try {
      const candles =
        await getCandles(
          TF["5M"],
          350
        );

      const analysis =
        analyzeTimeframe(
          candles,
          "5M"
        );

      res.json({
        success: true,

        instrument:
          OUTPUT_SYMBOL,

        analysis
      });
    } catch (
      error
    ) {
      res.status(500).json({
        success: false,
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   MTF ANALYSIS
========================================================= */

app.get(
  "/mtf-analysis",
  async (req, res) => {
    try {
      const result =
        await mtfAnalysis();

      res.json(
        result
      );
    } catch (
      error
    ) {
      res.status(500).json({
        success: false,
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   TRENDLINE ANALYSIS
========================================================= */

app.get(
  "/trendline-analysis",
  async (req, res) => {
    try {
      const [candles1H,candles15M,candles5M]=await Promise.all([
        getCandles(TF["1H"],350),getCandles(TF["15M"],350),getCandles(TF["5M"],350)
      ]);
      const result=trendlineAnalysis(candles1H,candles15M,candles5M);
      const telegrams={};
      for(const tf of ["1H","15M","5M"]){
        const item=result.INDEPENDENT_TRADE_SIGNALS?.[tf]||{};
        const signal=item.signal||{}; const levels=item.levels||{};
        if(signal.ready&&signal.direction&&levels.entry&&levels.stopLoss&&levels.takeProfit?.TP1){
          const key=trendlineAlertKey(result,tf); const stateKey=`XAUUSD:${tf}`;
          if(key&&TRENDLINE_ALERT_STATE.get(stateKey)!==key){
            const tg=await sendTelegramMessage(buildTrendlineTelegramMessage({...result,TRENDLINE_SIGNAL:{...signal,signalTimeframe:tf}}));
            telegrams[tf]=tg;
            if(tg?.sent) TRENDLINE_ALERT_STATE.set(stateKey,key);
          } else telegrams[tf]={sent:false,reason:"Duplicate independent Trendline signal suppressed"};
        } else telegrams[tf]={sent:false,reason:"No confirmed independent trade setup"};
      }
      res.json({...result,TRENDLINE_TELEGRAM:telegrams});
    } catch(error){res.status(500).json({success:false,error:error.message});}
  }
);

/* =========================================================
   FULL ANALYSIS + CONFIRMED TELEGRAM
========================================================= */

app.get(
  "/analyze",
  async (req, res) => {
    try {
      const mtf =
        await mtfAnalysis();

      const ai =
        await geminiAnalysis(
          mtf
        );

      let telegram =
        null;

      if (
        mtf.ENTRY_CONFIRMATION
          ?.status ===
          "BUY CONFIRMED" ||

        mtf.ENTRY_CONFIRMATION
          ?.status ===
          "SELL CONFIRMED"
      ) {
        telegram =
          await sendTelegramMessage(
            buildTelegramMessage(
              mtf
            )
          );
      }

      let trendlineTelegram = {};
      const trendlineResult = mtf.TRENDLINE_ANALYSIS;
      for (const tf of ["1H","15M","5M"]) {
        const item = trendlineResult?.INDEPENDENT_TRADE_SIGNALS?.[tf] || {};
        const sig = item.signal || {};
        const levels = item.levels || {};
        if (sig.ready && levels.entry && levels.stopLoss && levels.takeProfit?.TP1) {
          const key = trendlineAlertKey(trendlineResult, tf);
          const stateKey = `XAUUSD:${tf}`;
          if (key && TRENDLINE_ALERT_STATE.get(stateKey) !== key) {
            const tg = await sendTelegramMessage(buildTrendlineTelegramMessage({...trendlineResult,TRENDLINE_SIGNAL:{...sig,signalTimeframe:tf}}));
            trendlineTelegram[tf] = tg;
            if (tg?.sent) TRENDLINE_ALERT_STATE.set(stateKey,key);
          } else trendlineTelegram[tf] = {sent:false,reason:"Duplicate independent Trendline signal suppressed"};
        } else trendlineTelegram[tf] = {sent:false,reason:"No confirmed independent trade setup"};
      }

      res.json({
        ...mtf,

        AI_ANALYSIS:
          ai,

        TELEGRAM:
          telegram,

        TRENDLINE_TELEGRAM:
          trendlineTelegram
      });
    } catch (
      error
    ) {
      res.status(500).json({
        success: false,
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   GEMINI TEST
========================================================= */

app.get(
  "/gemini-test",
  async (req, res) => {
    try {
      const result =
        await geminiAnalysis({
          instrument:
            OUTPUT_SYMBOL,

          message:
            "Gemini connection test"
        });

      res.json({
        success: true,

        result
      });
    } catch (
      error
    ) {
      res.status(500).json({
        success: false,
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   TELEGRAM TEST
========================================================= */

app.get(
  "/telegram-test",
  async (req, res) => {
    try {
      const result =
        await sendTelegramMessage(
          "XAU AI BOT\n\n" +
          "Telegram connection successful.\n\n" +
          "Chat ID: " +
          TELEGRAM_CHAT_ID
        );

      res.json({
        success: true,

        telegram:
          result
      });
    } catch (
      error
    ) {
      res.status(500).json({
        success: false,
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   HIGH-FREQUENCY XAUUSD EXECUTION BRIDGE
   Liquid Chart -> /hf/tick -> cached MTF decision
========================================================= */

const HF_AUTO_TRADE = String(process.env.AUTO_TRADE || "false").toLowerCase() === "true";
const HF_SECRET = process.env.HF_SECRET || "";
const HF_STATE = {
  ticks: 0,
  lastTickAt: null,
  lastBid: null,
  lastAsk: null,
  lastDecision: null,
  lastDecisionAt: null,
  lastError: null,
  decisionRunning: false
};

let hfCachedDecision = null;
let hfCachedDecisionAt = 0;
const HF_DECISION_CACHE_MS = 1200;

function hfAuthorized(req) {
  if (!HF_SECRET) return true;
  return String(req.headers["x-hf-secret"] || "") === HF_SECRET;
}

function hfNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function hfClamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function buildHFRiskLevels(direction, price, analysis) {
  const a5 = analysis?.analysis?.["5M"] || {};
  const atr = hfNumber(a5?.indicators?.ATR14);
  const sr = a5?.supportResistance || {};
  const safeAtr = atr && atr > 0 ? atr : 3.0;

  // Momentum scalping: keep SL tied to current volatility, but never absurdly tight.
  const risk = hfClamp(safeAtr * 0.85, 2.0, 7.5);
  const entry = hfNumber(price);
  if (!entry) return null;

  let stopLoss;
  let takeProfit;

  if (direction === "BUY") {
    const structuralSL = hfNumber(sr.support);
    stopLoss = structuralSL && structuralSL < entry && entry - structuralSL <= risk * 1.8
      ? structuralSL - Math.min(safeAtr * 0.10, 0.5)
      : entry - risk;
    const actualRisk = Math.max(entry - stopLoss, 0.1);
    takeProfit = entry + actualRisk * 1.55;
  } else {
    const structuralSL = hfNumber(sr.resistance);
    stopLoss = structuralSL && structuralSL > entry && structuralSL - entry <= risk * 1.8
      ? structuralSL + Math.min(safeAtr * 0.10, 0.5)
      : entry + risk;
    const actualRisk = Math.max(stopLoss - entry, 0.1);
    takeProfit = entry - actualRisk * 1.55;
  }

  return {
    entry: Number(entry.toFixed(5)),
    stopLoss: Number(stopLoss.toFixed(5)),
    takeProfit: {
      TP1: Number(takeProfit.toFixed(5))
    },
    riskDistance: Number(Math.abs(entry - stopLoss).toFixed(5)),
    rrr: 1.55,
    source: "HF_ADAPTIVE_VOLATILITY"
  };
}

function buildAdaptiveHFSignal(mtf, bid, ask) {
  const entry = mtf?.ENTRY_CONFIRMATION || {};
  const a1 = mtf?.analysis?.["1H"] || {};
  const a15 = mtf?.analysis?.["15M"] || {};
  const a5 = mtf?.analysis?.["5M"] || {};
  const trendline = mtf?.TRENDLINE_ANALYSIS || {};
  const tlBuy = Number(trendline?.TRENDLINE_SCORE?.BUY?.score || 0);
  const tlSell = Number(trendline?.TRENDLINE_SCORE?.SELL?.score || 0);
  const price = Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : hfNumber(a5.currentPrice);

  let buy = Number(entry.bullishScore || 0);
  let sell = Number(entry.bearishScore || 0);
  const buyReasons = [...(entry.bullishReasons || [])];
  const sellReasons = [...(entry.bearishReasons || [])];

  const buyTrigger = [];
  const sellTrigger = [];

  // Trendline evidence is intentionally powerful for momentum capture, but not sufficient alone.
  if (tlBuy >= 7) { buy += 3; buyReasons.push(`Trendline BUY momentum ${tlBuy}/11`); buyTrigger.push("trendline"); }
  else if (tlBuy >= 5) { buy += 2; buyReasons.push(`Trendline BUY setup ${tlBuy}/11`); }
  if (tlSell >= 7) { sell += 3; sellReasons.push(`Trendline SELL momentum ${tlSell}/11`); sellTrigger.push("trendline"); }
  else if (tlSell >= 5) { sell += 2; sellReasons.push(`Trendline SELL setup ${tlSell}/11`); }

  const fiveSweep = a5?.liquidity?.latestSweep || "";
  if (fiveSweep === "Bullish Liquidity Sweep") { buy += 2; buyReasons.push("5M bullish liquidity sweep"); buyTrigger.push("liquidity"); }
  if (fiveSweep === "Bearish Liquidity Sweep") { sell += 2; sellReasons.push("5M bearish liquidity sweep"); sellTrigger.push("liquidity"); }

  const fiveCandle = a5?.candle || {};
  if (fiveCandle?.displacement === "Strong" || fiveCandle?.displacement === true || fiveCandle?.strength === "Strong") {
    if (fiveCandle.direction === "Bullish") { buy += 2; buyReasons.push("5M bullish displacement"); buyTrigger.push("displacement"); }
    if (fiveCandle.direction === "Bearish") { sell += 2; sellReasons.push("5M bearish displacement"); sellTrigger.push("displacement"); }
  }

  const macd5 = a5?.indicators?.MACD?.bias;
  const rsi5 = Number(a5?.indicators?.RSI14);
  if (macd5 === "Bullish" && rsi5 >= 52) { buy += 1; buyReasons.push("5M momentum aligned"); }
  if (macd5 === "Bearish" && rsi5 <= 48) { sell += 1; sellReasons.push("5M momentum aligned"); }

  const trend1 = a1?.trend;
  const trend15 = a15?.trend;
  const trend5 = a5?.trend;
  if (trend1 === "Bullish" && trend15 === "Bullish") { buy += 2; buyReasons.push("1H+15M trend alignment"); }
  if (trend1 === "Bearish" && trend15 === "Bearish") { sell += 2; sellReasons.push("1H+15M trend alignment"); }
  if (trend15 === "Bullish" && trend5 === "Bullish") { buy += 1; buyReasons.push("15M+5M trend alignment"); }
  if (trend15 === "Bearish" && trend5 === "Bearish") { sell += 1; sellReasons.push("15M+5M trend alignment"); }

  const bullishBreak = a5?.breakDirection === "Bullish" || a15?.breakDirection === "Bullish";
  const bearishBreak = a5?.breakDirection === "Bearish" || a15?.breakDirection === "Bearish";
  if (bullishBreak) { buy += 2; buyReasons.push("Structure break available"); buyTrigger.push("structure"); }
  if (bearishBreak) { sell += 2; sellReasons.push("Structure break available"); sellTrigger.push("structure"); }

  // Avoid chasing an exhausted move. Strong opposite structure cancels a weak setup.
  const spread = Number.isFinite(bid) && Number.isFinite(ask) ? ask - bid : null;
  const atr = Number(a5?.indicators?.ATR14 || 0);
  const spreadOK = spread === null || atr <= 0 || spread <= atr * 0.20;
  if (!spreadOK) {
    return {
      signal: "WAIT",
      status: "SPREAD_BLOCK",
      bullishScore: buy,
      bearishScore: sell,
      bullishReasons: buyReasons,
      bearishReasons: sellReasons,
      executionAllowed: false,
      trigger: null,
      spread,
      price
    };
  }

  const margin = Math.abs(buy - sell);
  let signal = "WAIT";
  let status = "WAITING";
  let trigger = null;

  // Adaptive confirmation: at least one real trigger + sufficient evidence + directional separation.
  if (buy >= 9 && margin >= 2 && buyTrigger.length > 0) {
    signal = "BUY";
    status = "BUY CONFIRMED";
    trigger = [...new Set(buyTrigger)];
  } else if (sell >= 9 && margin >= 2 && sellTrigger.length > 0) {
    signal = "SELL";
    status = "SELL CONFIRMED";
    trigger = [...new Set(sellTrigger)];
  } else if (buy >= 7 && margin >= 3 && buyTrigger.length > 0) {
    signal = "BUY";
    status = "BUY MOMENTUM CONFIRMED";
    trigger = [...new Set(buyTrigger)];
  } else if (sell >= 7 && margin >= 3 && sellTrigger.length > 0) {
    signal = "SELL";
    status = "SELL MOMENTUM CONFIRMED";
    trigger = [...new Set(sellTrigger)];
  } else if (buy >= 6 && buy > sell + 2) {
    status = "BUY SETUP";
  } else if (sell >= 6 && sell > buy + 2) {
    status = "SELL SETUP";
  }

  return {
    signal,
    status,
    bullishScore: buy,
    bearishScore: sell,
    bullishReasons: [...new Set(buyReasons)],
    bearishReasons: [...new Set(sellReasons)],
    executionAllowed: signal === "BUY" || signal === "SELL",
    trigger,
    spread,
    price,
    margin
  };
}

async function buildHFDecision(bid, ask) {
  const now = Date.now();
  if (hfCachedDecision && now - hfCachedDecisionAt < HF_DECISION_CACHE_MS) {
    return {
      ...hfCachedDecision,
      currentPrice: Number.isFinite(bid) && Number.isFinite(ask)
        ? (bid + ask) / 2
        : hfCachedDecision.currentPrice,
      bid: Number.isFinite(bid) ? bid : hfCachedDecision.bid,
      ask: Number.isFinite(ask) ? ask : hfCachedDecision.ask,
      cached: true
    };
  }

  if (HF_STATE.decisionRunning && hfCachedDecision) {
    return {...hfCachedDecision, cached: true, busy: true};
  }

  HF_STATE.decisionRunning = true;
  try {
    const mtf = await mtfAnalysis();
    const adaptive = buildAdaptiveHFSignal(mtf, bid, ask);
    const direction = adaptive.signal === "BUY" || adaptive.signal === "SELL"
      ? adaptive.signal
      : "WAIT";

    let levels = null;
    if (direction !== "WAIT") {
      levels = mtf?.TRADE_LEVELS || null;
      if (!levels?.stopLoss && !levels?.sl) {
        levels = buildHFRiskLevels(direction, adaptive.price, mtf);
      }
    } else {
      levels = mtf?.TRADE_LEVELS || null;
    }

    const decision = {
      success: true,
      instrument: "XAUUSD",
      generatedAt: new Date().toISOString(),
      currentPrice: adaptive.price,
      bid: Number.isFinite(bid) ? bid : null,
      ask: Number.isFinite(ask) ? ask : null,
      signal: direction,
      status: adaptive.status,
      bullishScore: adaptive.bullishScore,
      bearishScore: adaptive.bearishScore,
      reasons: direction === "BUY" ? adaptive.bullishReasons : direction === "SELL" ? adaptive.bearishReasons : [],
      bullishReasons: adaptive.bullishReasons,
      bearishReasons: adaptive.bearishReasons,
      trigger: adaptive.trigger,
      margin: adaptive.margin,
      spread: adaptive.spread,
      tradeLevels: levels,
      autoTrade: HF_AUTO_TRADE,
      executionAllowed: HF_AUTO_TRADE && adaptive.executionAllowed,
      engine: "XAU_AI_ADAPTIVE_MOMENTUM_V2",
      mtf: mtf.MTF || null,
      structure: mtf.MTF_STRUCTURE || null,
      confirmation: mtf.MTF_CONFIRMATION || null,
      liquidity: mtf.analysis?.["5M"]?.liquidity || null,
      fvg: mtf.analysis?.["5M"]?.FVG || null,
      orderBlocks: mtf.analysis?.["5M"]?.orderBlocks || null,
      candle: mtf.analysis?.["5M"]?.candle || null,
      trendline: mtf.TRENDLINE_ANALYSIS || null
    };

    hfCachedDecision = decision;
    hfCachedDecisionAt = Date.now();
    HF_STATE.lastDecision = decision;
    HF_STATE.lastDecisionAt = new Date().toISOString();
    HF_STATE.lastError = null;
    return decision;
  } catch (error) {
    HF_STATE.lastError = error.message;
    if (hfCachedDecision) return {...hfCachedDecision, stale: true, error: error.message};
    return {
      success: false,
      instrument: "XAUUSD",
      signal: "WAIT",
      executionAllowed: false,
      error: error.message
    };
  } finally {
    HF_STATE.decisionRunning = false;
  }
}

/* =========================================================
   LIQUID CHART / MYTRADER DECISION BRIDGE
   Liquid UDIX polls this endpoint. Render remains analysis-only;
   actual broker execution is performed by Liquid Chart via FXB.
========================================================= */

const LIQUID_AUTO_TRADE = String(process.env.LIQUID_AUTO_TRADE || "false").toLowerCase() === "true";
const LIQUID_SIGNAL_SOURCE = String(process.env.LIQUID_SIGNAL_SOURCE || "GOLDARA").toUpperCase();

app.get("/liquid/decision", async (req, res) => {
  if (!hfAuthorized(req)) return res.status(401).json({success:false,error:"Unauthorized"});

  try {
    const bid = Number(req.query?.bid);
    const ask = Number(req.query?.ask);
    const main = await buildHFDecision(
      Number.isFinite(bid) && Number.isFinite(ask) ? bid : undefined,
      Number.isFinite(bid) && Number.isFinite(ask) ? ask : undefined
    );
    const goldara = await goldaraScan();

    const gs = goldara?.SIGNAL || {};
    const gl = goldara?.TRADE_LEVELS || null;
    const goldaraDecision = {
      signal: gs.ready && (gs.direction === "BUY" || gs.direction === "SELL") ? gs.direction : "WAIT",
      status: gs.status || "WAITING",
      score: gs.score ?? 0,
      maxScore: gs.maxScore ?? 12,
      reasons: gs.reasons || [],
      warnings: gs.warnings || [],
      tradeLevels: gl,
      executionAllowed: LIQUID_AUTO_TRADE && !!(gs.ready && gl?.entry && gl?.stopLoss && gl?.takeProfit?.TP1),
      engine: "GOLDARA_STYLE_SMC_SIGNAL"
    };

    const selected = LIQUID_SIGNAL_SOURCE === "MAIN" ? main : goldaraDecision;

    res.json({
      success: true,
      instrument: OUTPUT_SYMBOL,
      generatedAt: new Date().toISOString(),
      liquidAutoTrade: LIQUID_AUTO_TRADE,
      signalSource: LIQUID_SIGNAL_SOURCE,
      selected,
      main: {
        signal: main?.signal || "WAIT",
        status: main?.status || "WAITING",
        score: main?.signal === "BUY" ? main?.bullishScore : main?.signal === "SELL" ? main?.bearishScore : Math.max(main?.bullishScore || 0, main?.bearishScore || 0),
        bullishScore: main?.bullishScore ?? 0,
        bearishScore: main?.bearishScore ?? 0,
        reasons: main?.reasons || [],
        tradeLevels: main?.tradeLevels || null,
        executionAllowed: LIQUID_AUTO_TRADE && !!main?.executionAllowed,
        engine: main?.engine || "XAU_AI_ADAPTIVE_MOMENTUM_V2"
      },
      goldara: {
        ...goldaraDecision,
        currentPrice: goldara?.currentPrice ?? null,
        mtf: goldara?.MTF || null,
        structure: goldara?.STRUCTURE || null,
        smc: goldara?.SMC || null
      }
    });
  } catch (error) {
    res.status(500).json({success:false,error:error.message});
  }
});

app.get("/hf/status", (req, res) => {
  if (!hfAuthorized(req)) return res.status(401).json({success:false,error:"Unauthorized"});
  res.json({
    success: true,
    instrument: "XAUUSD",
    autoTrade: HF_AUTO_TRADE,
    ticks: HF_STATE.ticks,
    lastTickAt: HF_STATE.lastTickAt,
    lastBid: HF_STATE.lastBid,
    lastAsk: HF_STATE.lastAsk,
    lastDecisionAt: HF_STATE.lastDecisionAt,
    lastDecision: HF_STATE.lastDecision,
    lastError: HF_STATE.lastError
  });
});

app.post("/hf/tick", async (req, res) => {
  if (!hfAuthorized(req)) return res.status(401).json({success:false,error:"Unauthorized"});
  const bid = Number(req.body?.bid);
  const ask = Number(req.body?.ask);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) {
    return res.status(400).json({success:false,error:"Invalid bid/ask"});
  }
  HF_STATE.ticks++;
  HF_STATE.lastTickAt = new Date().toISOString();
  HF_STATE.lastBid = bid;
  HF_STATE.lastAsk = ask;
  const decision = await buildHFDecision(bid, ask);
  res.json({success:true, tick:HF_STATE.ticks, decision});
});

app.get("/hf/decision", async (req, res) => {
  if (!hfAuthorized(req)) return res.status(401).json({success:false,error:"Unauthorized"});
  const bid = Number(req.query?.bid);
  const ask = Number(req.query?.ask);

  // Treat a valid decision request carrying live prices as a live HF tick too.
  // This GET path avoids browser CORS preflight caused by JSON POST requests.
  if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
    HF_STATE.ticks++;
    HF_STATE.lastTickAt = new Date().toISOString();
    HF_STATE.lastBid = bid;
    HF_STATE.lastAsk = ask;
  }

  const decision = await buildHFDecision(bid, ask);
  res.json(decision);
});

/* =========================================================
   SERVER
========================================================= */

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `XAU AI Strong Engine running on port ${PORT}`
    );

    console.log(
      `Telegram configured: ${
        !!TELEGRAM_BOT_TOKEN
      }`
    );

    console.log(
      `Telegram Chat ID: ${
        TELEGRAM_CHAT_ID
      }`
    );

    console.log(
      "Hourly Telegram status scheduler started."
    );
  }
);

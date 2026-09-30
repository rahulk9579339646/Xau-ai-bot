import express from "express";

const app = express();
app.use(express.json());

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
        .map(x => `â€¢ ${x}`)
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
        .map(x => `â€¢ ${x}`)
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

function buildTrendlineTradeLevels(direction, a1, a15, a5, trendlineData) {
  const currentPrice = num(a5.currentPrice);
  const atrValue = num(a5.indicators?.ATR14);

  if (
    !Number.isFinite(currentPrice) ||
    !Number.isFinite(atrValue) ||
    atrValue <= 0
  ) {
    return null;
  }

  const isBuy = direction === "BUY";
  const isSell = direction === "SELL";
  if (!isBuy && !isSell) return null;

  const t = isBuy ? trendlineData?.bullish : trendlineData?.bearish;
  if (!t?.confirmed || t.strength === "Weak") return null;

  const s5 = a5.structure || {};
  const s15 = a15.structure || {};

  const swingLow5 = num(s5.latestSwingLow?.price);
  const swingHigh5 = num(s5.latestSwingHigh?.price);
  const swingLow15 = num(s15.latestSwingLow?.price);
  const swingHigh15 = num(s15.latestSwingHigh?.price);

  const ob5 = isBuy
    ? num(a5.orderBlocks?.bullish?.[0]?.low ?? a5.orderBlocks?.bullish?.[0]?.priceLow)
    : num(a5.orderBlocks?.bearish?.[0]?.high ?? a5.orderBlocks?.bearish?.[0]?.priceHigh);

  const sd5 = isBuy
    ? num(a5.supplyDemand?.demand?.[0]?.low ?? a5.supplyDemand?.demand?.[0]?.priceLow)
    : num(a5.supplyDemand?.supply?.[0]?.high ?? a5.supplyDemand?.supply?.[0]?.priceHigh);

  const retestLine = num(t?.retest?.line);
  const trendlineLine = num(t?.trendline?.currentLine);
  const breakoutPrice = num(t?.breakoutPrice);

  const noiseBuffer = Math.max(atrValue * 0.08, 0.05);
  const minimumRisk = atrValue * 0.25;
  const maximumRisk = atrValue * 1.50;

  const rawStops = isBuy
    ? [swingLow5, ob5, sd5, swingLow15, retestLine, trendlineLine, breakoutPrice]
        .filter(Number.isFinite)
        .filter(x => x < currentPrice)
        .sort((a, b) => b - a)
    : [swingHigh5, ob5, sd5, swingHigh15, retestLine, trendlineLine, breakoutPrice]
        .filter(Number.isFinite)
        .filter(x => x > currentPrice)
        .sort((a, b) => a - b);

  let stopLoss = null;

  for (const base of rawStops) {
    const candidate = isBuy
      ? base - noiseBuffer
      : base + noiseBuffer;

    const risk = Math.abs(currentPrice - candidate);

    if (risk >= minimumRisk && risk <= maximumRisk) {
      stopLoss = candidate;
      break;
    }
  }

  if (!Number.isFinite(stopLoss)) {
    const fallbackRisk = Math.min(
      maximumRisk,
      Math.max(minimumRisk, atrValue * 0.50)
    );

    stopLoss = isBuy
      ? currentPrice - fallbackRisk
      : currentPrice + fallbackRisk;
  }

  const risk = Math.abs(currentPrice - stopLoss);

  if (
    !Number.isFinite(risk) ||
    risk < minimumRisk ||
    risk > maximumRisk
  ) {
    return null;
  }

  const supportLevels = [
    num(a5.supportResistance?.support),
    num(a5.supportResistance?.nextSupport),
    swingLow5,
    swingLow15,
    num(a15.supportResistance?.support),
    num(a15.supportResistance?.nextSupport),
    num(a1.supportResistance?.support),
    num(a1.supportResistance?.nextSupport)
  ];

  const resistanceLevels = [
    num(a5.supportResistance?.resistance),
    num(a5.supportResistance?.nextResistance),
    swingHigh5,
    swingHigh15,
    num(a15.supportResistance?.resistance),
    num(a15.supportResistance?.nextResistance),
    num(a1.supportResistance?.resistance),
    num(a1.supportResistance?.nextResistance)
  ];

  const projection = num(t.targetProjection);

  const targetPool = [
    ...(isBuy ? resistanceLevels : supportLevels),
    projection
  ]
    .filter(Number.isFinite)
    .filter(x => isBuy ? x > currentPrice : x < currentPrice)
    .sort((a, b) => isBuy ? a - b : b - a);

  const minRR = 1.20;
  const dedupeGap = Math.max(atrValue * 0.05, 0.05);
  const targets = [];

  for (const target of targetPool) {
    const rr = Math.abs(target - currentPrice) / risk;

    if (rr < minRR) continue;
    if (targets.some(x => Math.abs(x - target) < dedupeGap)) continue;

    targets.push(target);
    if (targets.length === 3) break;
  }

  // TP1 must come from a real structural/projection level.
  // Do not manufacture a signal merely to fill TP2/TP3.
  if (targets.length === 0) {
    return null;
  }

  // Additional targets may use measured risk extensions only when
  // the market has supplied fewer than three real levels.
  for (const rr of [2.0, 3.0]) {
    if (targets.length >= 3) break;

    const target = isBuy
      ? currentPrice + risk * rr
      : currentPrice - risk * rr;

    if (!targets.some(x => Math.abs(x - target) < dedupeGap)) {
      targets.push(target);
    }
  }

  const tp1 = targets[0] ?? null;
  const tp2 = targets[1] ?? null;
  const tp3 = targets[2] ?? null;
  const rr1 = Number.isFinite(tp1)
    ? Math.abs(tp1 - currentPrice) / risk
    : null;

  if (!Number.isFinite(rr1) || rr1 < minRR) return null;

  return {
    direction,
    entry: round(currentPrice, 5),
    stopLoss: round(stopLoss, 5),
    risk: round(risk, 5),
    takeProfit: {
      TP1: round(tp1, 5),
      TP2: Number.isFinite(tp2) ? round(tp2, 5) : null,
      TP3: Number.isFinite(tp3) ? round(tp3, 5) : null
    },
    invalidation: round(stopLoss, 5),
    targetMethod: "Real 5M/15M/1H structure + measured trendline projection; calculated extensions only when required",
    trendlineProjection: Number.isFinite(projection) ? round(projection, 5) : null,
    riskRewardTP1: round(rr1, 2)
  };
}

function trendlineAnalysis(candles1H, candles15M, candles5M) {
  const a1 = analyzeTimeframe(candles1H, "1H");
  const a15 = analyzeTimeframe(candles15M, "15M");
  const a5 = analyzeTimeframe(candles5M, "5M");

  const trendlines = {
    "1H": {
      bullish: findTrendlineBreakout(candles1H, "Bullish", 24),
      bearish: findTrendlineBreakout(candles1H, "Bearish", 24)
    },
    "15M": {
      bullish: findTrendlineBreakout(candles15M, "Bullish", 32),
      bearish: findTrendlineBreakout(candles15M, "Bearish", 32)
    },
    "5M": {
      bullish: findTrendlineBreakout(candles5M, "Bullish", 24),
      bearish: findTrendlineBreakout(candles5M, "Bearish", 24)
    }
  };

  const bullish5 = trendlines["5M"].bullish;
  const bearish5 = trendlines["5M"].bearish;

  const bullishScoreData = trendlineScoreForDirection(
    "BUY",
    trendlines["1H"],
    trendlines["15M"],
    trendlines["5M"],
    a1,
    a15,
    a5
  );

  const bearishScoreData = trendlineScoreForDirection(
    "SELL",
    trendlines["1H"],
    trendlines["15M"],
    trendlines["5M"],
    a1,
    a15,
    a5
  );

  const bullishReady =
    trendlines["1H"].bullish.confirmed &&
    trendlines["1H"].bullish.strength !== "Weak" &&
    bullishScoreData.mainTrendAligned &&
    bullishScoreData.fifteenTrendAligned &&
    (bullish5.confirmed || bullishScoreData.continuation) &&
    !bullishScoreData.hardBlock;

  const bearishReady =
    trendlines["1H"].bearish.confirmed &&
    trendlines["1H"].bearish.strength !== "Weak" &&
    bearishScoreData.mainTrendAligned &&
    bearishScoreData.fifteenTrendAligned &&
    (bearish5.confirmed || bearishScoreData.continuation) &&
    !bearishScoreData.hardBlock;

  let status = "WAITING";
  let direction = "None";
  let score = Math.max(bullishScoreData.score, bearishScoreData.score);
  let reasons = score === bullishScoreData.score
    ? bullishScoreData.reasons
    : bearishScoreData.reasons;
  let warnings = score === bullishScoreData.score
    ? bullishScoreData.warnings
    : bearishScoreData.warnings;

  if (
    bullishReady &&
    bullishScoreData.score >= 7 &&
    !bullishScoreData.hardBlock &&
    bullishScoreData.score > bearishScoreData.score
  ) {
    status = bullishScoreData.score >= 9
      ? "BUY STRONG CONFIRMED"
      : "BUY CONFIRMED";
    direction = "BUY";
    score = bullishScoreData.score;
    reasons = bullishScoreData.reasons;
    warnings = bullishScoreData.warnings;
  } else if (
    bearishReady &&
    bearishScoreData.score >= 7 &&
    !bearishScoreData.hardBlock &&
    bearishScoreData.score > bullishScoreData.score
  ) {
    status = bearishScoreData.score >= 9
      ? "SELL STRONG CONFIRMED"
      : "SELL CONFIRMED";
    direction = "SELL";
    score = bearishScoreData.score;
    reasons = bearishScoreData.reasons;
    warnings = bearishScoreData.warnings;
  }

  const levels = direction === "BUY"
    ? buildTrendlineTradeLevels(direction, a1, a15, a5, trendlines["1H"])
    : direction === "SELL"
      ? buildTrendlineTradeLevels(direction, a1, a15, a5, trendlines["1H"])
      : null;

  if (direction !== "None" && !levels) {
    status = "WAITING";
    direction = "None";
    score = 0;
    reasons = ["Risk/reward or logical SL/target conditions not acceptable"];
    warnings = ["No valid trendline trade levels"];
  }

  const signal = {
    status,
    direction,
    score,
    maxScore: 10,
    confirmationGrade:
      score >= 9 ? "STRONG" : score >= 7 ? "CONFIRMED" : score >= 5 ? "WATCH" : "NONE",
    reasons,
    warnings,
    retest: direction === "BUY"
      ? trendlines["1H"].bullish.retest
      : direction === "SELL"
        ? trendlines["1H"].bearish.retest
        : null,
    noRetestPath:
      direction === "BUY"
        ? bullishScoreData.continuation && !trendlines["1H"].bullish.retest?.held
        : direction === "SELL"
          ? bearishScoreData.continuation && !trendlines["1H"].bearish.retest?.held
          : false
  };

  return {
    success: true,
    instrument: OUTPUT_SYMBOL,
    generatedAt: new Date().toISOString(),
    currentPrice: a5.currentPrice,
    TRENDLINE_SIGNAL: signal,
    TRENDLINE_SCORE: {
      BUY: bullishScoreData,
      SELL: bearishScoreData
    },
    TRENDLINES: trendlines,
    TRADE_LEVELS: levels,
    analysis: {
      "1H": a1,
      "15M": a15,
      "5M": a5
    }
  };
}

function buildTrendlineTelegramMessage(result) {
  const signal = result.TRENDLINE_SIGNAL || {};
  const levels = result.TRADE_LEVELS || {};

  let message =
    `XAUUSD TRENDLINE ALERT\n\n` +
    `Status: ${signal.status || "WAITING"}\n` +
    `Direction: ${signal.direction || "None"}\n` +
    `Score: ${signal.score ?? 0}/${signal.maxScore ?? 10}\n` +
    `Grade: ${signal.confirmationGrade || "NONE"}\n` +
    `Price: ${result.currentPrice ?? "N/A"}\n\n` +
    `1H Trendline: ${result.TRENDLINES?.["1H"]?.bullish?.confirmed ? "Bullish Breakout" : result.TRENDLINES?.["1H"]?.bearish?.confirmed ? "Bearish Breakdown" : "No Confirmed Break"}\n` +
    `15M: ${result.TRENDLINES?.["15M"]?.bullish?.confirmed ? "Bullish Confirm" : result.TRENDLINES?.["15M"]?.bearish?.confirmed ? "Bearish Confirm" : "No Confirmed Break"}\n` +
    `5M: ${result.TRENDLINES?.["5M"]?.bullish?.confirmed ? "Bullish Trigger" : result.TRENDLINES?.["5M"]?.bearish?.confirmed ? "Bearish Trigger" : "Continuation/No Retest"}\n` +
    `Retest: ${signal.retest?.held ? "YES - HELD" : signal.noRetestPath ? "NO - Strong Continuation" : "NO"}\n`;

  if (levels?.entry) {
    message +=
      `\nTRADE LEVELS\n` +
      `Entry: ${levels.entry}\n` +
      `SL: ${levels.stopLoss}\n` +
      `TP1: ${levels.takeProfit?.TP1 ?? "N/A"}\n` +
      `TP2: ${levels.takeProfit?.TP2 ?? "N/A"}\n` +
      `TP3: ${levels.takeProfit?.TP3 ?? "N/A"}\n` +
      `Target: ${levels.targetMethod || "Trendline / Structure"}\n`;
  }

  if (signal.reasons?.length) {
    message +=
      `\nCONFIRMATIONS\n` +
      signal.reasons.slice(0, 8).map(x => `â€¢ ${x}`).join("\n") +
      "\n";
  }

  if (signal.warnings?.length) {
    message +=
      `\nWARNINGS\n` +
      signal.warnings.slice(0, 6).map(x => `â€¢ ${x}`).join("\n") +
      "\n";
  }

  return message;
}

function trendlineAlertKey(result) {
  const signal = result.TRENDLINE_SIGNAL || {};
  if (!signal.direction || signal.direction === "None") return null;
  const tl = result.TRENDLINES?.["1H"]?.[signal.direction === "BUY" ? "bullish" : "bearish"];
  return `${signal.direction}:${tl?.breakoutIndex ?? "na"}:${tl?.breakoutPrice ?? "na"}`;
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
      `No confirmed trade levels â€” engine is still waiting.\n`;
  }

  if (
    entry.bullishReasons?.length
  ) {
    message +=
      `\nBULLISH REASONS\n` +

      entry.bullishReasons
        .slice(0, 8)
        .map(
          x => `â€¢ ${x}`
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
          x => `â€¢ ${x}`
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
   AUTOMATIC TRENDLINE MONITOR
   Checks the confirmed trendline setup every 60 seconds.
========================================================= */

let lastTrendlineMonitorError = null;
let trendlineMonitorRunning = false;

async function monitorTrendlineSignal() {
  if (trendlineMonitorRunning) return;

  trendlineMonitorRunning = true;

  try {
    const [
      candles1H,
      candles15M,
      candles5M
    ] = await Promise.all([
      getCandles(TF["1H"], 350),
      getCandles(TF["15M"], 350),
      getCandles(TF["5M"], 350)
    ]);

    const result = trendlineAnalysis(
      candles1H,
      candles15M,
      candles5M
    );

    const signal = result.TRENDLINE_SIGNAL;

    if (
      signal?.direction &&
      signal.direction !== "None" &&
      signal.score >= 7 &&
      signal.confirmationGrade !== "NONE" &&
      result.TRADE_LEVELS?.entry &&
      result.TRADE_LEVELS?.stopLoss &&
      result.TRADE_LEVELS?.takeProfit?.TP1
    ) {
      const key = trendlineAlertKey(result);

      if (
        key &&
        TRENDLINE_ALERT_STATE.get("XAUUSD") !== key
      ) {
        const telegram =
          await sendTelegramMessage(
            buildTrendlineTelegramMessage(result)
          );

        if (telegram?.sent) {
          TRENDLINE_ALERT_STATE.set(
            "XAUUSD",
            key
          );
          console.log(
            "Trendline Telegram alert sent:",
            key
          );
        } else {
          console.log(
            "Trendline Telegram alert failed:",
            telegram
          );
        }
      }
    }

    lastTrendlineMonitorError = null;
  } catch (error) {
    lastTrendlineMonitorError = error.message;
    console.log(
      "Trendline monitor error:",
      error.message
    );
  } finally {
    trendlineMonitorRunning = false;
  }
}

setTimeout(
  monitorTrendlineSignal,
  15000
);

setInterval(
  monitorTrendlineSignal,
  60 * 1000
);

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
        "/trendline-analysis"
      ],
      trendlineMonitor: {
        intervalSeconds: 60,
        running: trendlineMonitorRunning,
        lastError: lastTrendlineMonitorError
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
      const [
        candles1H,
        candles15M,
        candles5M
      ] = await Promise.all([
        getCandles(TF["1H"], 350),
        getCandles(TF["15M"], 350),
        getCandles(TF["5M"], 350)
      ]);

      const result = trendlineAnalysis(
        candles1H,
        candles15M,
        candles5M
      );

      let telegram = null;
      const signal = result.TRENDLINE_SIGNAL;

      if (
        signal?.direction &&
        signal.direction !== "None" &&
        signal.score >= 7 &&
        result.TRADE_LEVELS?.entry &&
        result.TRADE_LEVELS?.stopLoss &&
        result.TRADE_LEVELS?.takeProfit?.TP1
      ) {
        const key = trendlineAlertKey(result);

        if (
          key &&
          TRENDLINE_ALERT_STATE.get("XAUUSD") !== key
        ) {
          telegram = await sendTelegramMessage(
            buildTrendlineTelegramMessage(result)
          );

          if (telegram?.sent) {
            TRENDLINE_ALERT_STATE.set(
              "XAUUSD",
              key
            );
          }
        } else {
          telegram = {
            sent: false,
            reason: "Duplicate Trendline signal suppressed"
          };
        }
      }

      res.json({
        ...result,
        TRENDLINE_TELEGRAM: telegram
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
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

      let trendlineTelegram = null;
      const trendlineResult =
        mtf.TRENDLINE_ANALYSIS;
      const trendlineSignal =
        trendlineResult?.TRENDLINE_SIGNAL;

      if (
        trendlineSignal?.direction &&
        trendlineSignal.direction !== "None" &&
        trendlineSignal.score >= 7
      ) {
        const key = trendlineAlertKey(
          trendlineResult
        );

        if (
          key &&
          TRENDLINE_ALERT_STATE.get(
            "XAUUSD"
          ) !== key
        ) {
          trendlineTelegram =
            await sendTelegramMessage(
              buildTrendlineTelegramMessage(
                trendlineResult
              )
            );

          if (trendlineTelegram?.sent) {
            TRENDLINE_ALERT_STATE.set(
              "XAUUSD",
              key
            );
          }
        } else {
          trendlineTelegram = {
            sent: false,
            reason: "Duplicate Trendline signal suppressed"
          };
        }
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

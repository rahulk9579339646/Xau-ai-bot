import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

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

  if (!TWELVE_DATA_API_KEY) {
    throw new Error(
      "TWELVE_DATA_API_KEY is missing"
    );
  }

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
}

/* =========================================================
   TELEGRAM
========================================================= */

async function sendTelegramMessage(message) {
  if (
    !TELEGRAM_BOT_TOKEN ||
    !TELEGRAM_CHAT_ID
  ) {
    return {
      sent: false,
      reason:
        "Telegram environment variables not configured"
    };
  }

  try {
    const response =
      await fetch(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body: JSON.stringify({
            chat_id:
              TELEGRAM_CHAT_ID,

            text: message
          })
        }
      );

    const data =
      await response.json();

    if (
      !response.ok ||
      !data.ok
    ) {
      return {
        sent: false,
        error:
          data.description ||
          "Telegram message failed"
      };
    }

    return {
      sent: true
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
    atr(candles, 14) ||
    0;

  const displacement =
    atrValue > 0 &&
    range >=
      atrValue * 0.85 &&
    bodyRatio >= 0.50;

  return {
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,

    direction:
      bullish
        ? "Bullish"
        : bearish
          ? "Bearish"
          : "Neutral",

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

    strength,

    patterns,

    displacement:
      displacement
        ? "Displacement"
        : "None"
  };
}

/* =========================================================
   LIQUIDITY
========================================================= */

function liquidityAnalysis(
  candles
) {
  const swings =
    detectSwings(
      candles
    );

  const current =
    last(candles);

  const previousCandle =
    previous(candles);

  if (
    !current ||
    !previousCandle
  ) {
    return {
      buySideLiquidity: null,
      sellSideLiquidity: null,
      latestSweep: "None"
    };
  }

  const recentHighs =
    swings.highs.slice(-5);

  const recentLows =
    swings.lows.slice(-5);

  const latestHigh =
    last(recentHighs);

  const latestLow =
    last(recentLows);

  let latestSweep =
    "None";

  if (
    latestLow &&
    current.low <
      latestLow.price &&
    current.close >
      latestLow.price
  ) {
    latestSweep =
      "Bullish Liquidity Sweep";
  }

  if (
    latestHigh &&
    current.high >
      latestHigh.price &&
    current.close <
      latestHigh.price
  ) {
    latestSweep =
      "Bearish Liquidity Sweep";
  }

  return {
    buySideLiquidity:
      latestHigh
        ? {
            price:
              latestHigh.price,
            time:
              latestHigh.time
          }
        : null,

    sellSideLiquidity:
      latestLow
        ? {
            price:
              latestLow.price,
            time:
              latestLow.time
          }
        : null,

    latestSweep
  };
}

/* =========================================================
   FVG
========================================================= */

function fvgAnalysis(
  candles
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

    const b =
      candles[i - 1];

    const c =
      candles[i];

    if (
      c.low >
      a.high
    ) {
      bullish.push({
        type:
          "Bullish FVG",

        low:
          a.high,

        high:
          c.low,

        createdAt:
          b.time
      });
    }

    if (
      c.high <
      a.low
    ) {
      bearish.push({
        type:
          "Bearish FVG",

        low:
          c.high,

        high:
          a.low,

        createdAt:
          b.time
      });
    }
  }

  return {
    bullish:
      bullish.slice(-10),

    bearish:
      bearish.slice(-10)
  };
}

/* =========================================================
   ORDER BLOCKS
========================================================= */

function orderBlockAnalysis(
  candles
) {
  const bullish = [];
  const bearish = [];

  for (
    let i = 2;
    i < candles.length - 1;
    i++
  ) {
    const c =
      candles[i];

    const next =
      candles[i + 1];

    const body =
      Math.abs(
        c.close -
        c.open
      );

    const range =
      c.high -
      c.low;

    const nextBody =
      Math.abs(
        next.close -
        next.open
      );

    if (
      c.close <
        c.open &&
      next.close >
        next.open &&
      nextBody >
        body * 1.2
    ) {
      bullish.push({
        type:
          "Bullish Order Block",

        low:
          c.low,

        high:
          c.high,

        createdAt:
          c.time
      });
    }

    if (
      c.close >
        c.open &&
      next.close <
        next.open &&
      nextBody >
        body * 1.2
    ) {
      bearish.push({
        type:
          "Bearish Order Block",

        low:
          c.low,

        high:
          c.high,

        createdAt:
          c.time
      });
    }
  }

  return {
    bullish:
      bullish.slice(-10),

    bearish:
      bearish.slice(-10)
  };
}

/* =========================================================
   SUPPLY / DEMAND
========================================================= */

function supplyDemandAnalysis(
  candles
) {
  const bullish = [];
  const bearish = [];

  const recent =
    candles.slice(-80);

  for (
    let i = 2;
    i < recent.length - 2;
    i++
  ) {
    const c =
      recent[i];

    const n1 =
      recent[i + 1];

    const n2 =
      recent[i + 2];

    const body =
      Math.abs(
        c.close -
        c.open
      );

    const nextMove =
      Math.abs(
        n2.close -
        c.close
      );

    if (
      c.close <
        c.open &&
      n1.close >
        n1.open &&
      n2.close >
        c.close &&
      nextMove >
        body * 1.5
    ) {
      bullish.push({
        type:
          "Demand Zone",

        low:
          c.low,

        high:
          c.high,

        createdAt:
          c.time
      });
    }

    if (
      c.close >
        c.open &&
      n1.close <
        n1.open &&
      n2.close <
        c.close &&
      nextMove >
        body * 1.5
    ) {
      bearish.push({
        type:
          "Supply Zone",

        low:
          c.low,

        high:
          c.high,

        createdAt:
          c.time
      });
    }
  }

  return {
    demand:
      bullish.slice(-10),

    supply:
      bearish.slice(-10)
  };
}

/* =========================================================
   SUPPORT / RESISTANCE
========================================================= */

function supportResistanceAnalysis(
  candles
) {
  const swings =
    detectSwings(
      candles
    );

  const highs =
    swings.highs
      .slice(-10)
      .map(x => x.price);

  const lows =
    swings.lows
      .slice(-10)
      .map(x => x.price);

  const current =
    last(candles);

  if (!current) {
    return {
      support: null,
      nextSupport: null,
      resistance: null,
      nextResistance: null
    };
  }

  const supports =
    lows
      .filter(
        x =>
          x <
          current.close
      )
      .sort(
        (a, b) =>
          b - a
      );

  const resistances =
    highs
      .filter(
        x =>
          x >
          current.close
      )
      .sort(
        (a, b) =>
          a - b
      );

  return {
    support:
      supports[0] ??
      null,

    nextSupport:
      supports[1] ??
      null,

    resistance:
      resistances[0] ??
      null,

    nextResistance:
      resistances[1] ??
      null
  };
}

/* =========================================================
   TREND
========================================================= */

function trendAnalysis(
  candles
) {
  const closes =
    candles.map(
      x => x.close
    );

  const e9 =
    ema(closes, 9);

  const e21 =
    ema(closes, 21);

  const e50 =
    ema(closes, 50);

  const current =
    last(candles);

  if (
    !current ||
    !Number.isFinite(e9) ||
    !Number.isFinite(e21)
  ) {
    return {
      trend:
        "Unknown",

      EMA9: e9,
      EMA21: e21,
      EMA50: e50
    };
  }

  let trend =
    "Sideways";

  if (
    current.close > e9 &&
    e9 > e21
  ) {
    trend =
      "Bullish";
  }

  if (
    current.close < e9 &&
    e9 < e21
  ) {
    trend =
      "Bearish";
  }

  return {
    trend,

    EMA9:
      round(e9, 5),

    EMA21:
      round(e21, 5),

    EMA50:
      round(e50, 5)
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

  const current =
    last(candles);

  if (
    !current ||
    !volumes.length
  ) {
    return {
      available: false,
      currentVolume: null,
      averageVolume: null,
      state:
        "Unavailable"
    };
  }

  const averageVolume =
    avg(
      volumes.slice(-20)
    );

  const currentVolume =
    current.volume;

  let state =
    "Normal";

  if (
    Number.isFinite(
      averageVolume
    )
  ) {
    if (
      currentVolume >
      averageVolume * 1.5
    ) {
      state =
        "High Volume";
    } else if (
      currentVolume <
      averageVolume * 0.6
    ) {
      state =
        "Low Volume";
    }
  }

  return {
    available:
      Number.isFinite(
        currentVolume
      ),

    currentVolume,

    averageVolume,

    state
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
    zone &&
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

function relevantZonesAnalysis(
  fvg,
  orderBlocks,
  supplyDemand,
  price
) {
  const bullishFVG =
    fvg.bullish.filter(
      z =>
        zoneContains(
          z,
          price
        ) ||
        Math.abs(
          price -
            z.high
        ) <
          Math.abs(
            price *
            0.002
          )
    );

  const bearishFVG =
    fvg.bearish.filter(
      z =>
        zoneContains(
          z,
          price
        ) ||
        Math.abs(
          price -
            z.low
        ) <
          Math.abs(
            price *
            0.002
          )
    );

  const bullishOB =
    orderBlocks.bullish.filter(
      z =>
        zoneContains(
          z,
          price
        ) ||
        Math.abs(
          price -
            z.high
        ) <
          Math.abs(
            price *
            0.002
          )
    );

  const bearishOB =
    orderBlocks.bearish.filter(
      z =>
        zoneContains(
          z,
          price
        ) ||
        Math.abs(
          price -
            z.low
        ) <
          Math.abs(
            price *
            0.002
          )
    );

  const demand =
    supplyDemand.demand.filter(
      z =>
        zoneContains(
          z,
          price
        ) ||
        Math.abs(
          price -
            z.high
        ) <
          Math.abs(
            price *
            0.002
          )
    );

  const supply =
    supplyDemand.supply.filter(
      z =>
        zoneContains(
          z,
          price
        ) ||
        Math.abs(
          price -
            z.low
        ) <
          Math.abs(
            price *
            0.002
          )
    );

  return {
    bullishFVG,
    bearishFVG,
    bullishOB,
    bearishOB,
    demand,
    supply
  };
}

/* =========================================================
   TIMEFRAME ANALYSIS
========================================================= */

function analyzeTimeframe(
  candles,
  timeframe
) {
  const current =
    last(candles);

  if (!current) {
    throw new Error(
      `${timeframe} candles unavailable`
    );
  }

  const closes =
    candles.map(
      x => x.close
    );

  const structure =
    structureAnalysis(
      candles
    );

  const breaks =
    structureBreakAnalysis(
      candles,
      structure
    );

  const liquidity =
    liquidityAnalysis(
      candles
    );

  const candle =
    candleAnalysis(
      candles
    );

  const indicators = {
    EMA9:
      ema(closes, 9),

    EMA21:
      ema(closes, 21),

    EMA50:
      ema(closes, 50),

    RSI14:
      rsi(closes, 14),

    ATR14:
      atr(candles, 14),

    MACD:
      macd(closes),

    trend:
      trendAnalysis(
        candles
      ).trend,

    momentum:
      rsi(closes, 14) > 55
        ? "Bullish Momentum"
        : rsi(closes, 14) < 45
          ? "Bearish Momentum"
          : "Neutral Momentum"
  };

  const sr =
    supportResistanceAnalysis(
      candles
    );

  const fvg =
    fvgAnalysis(
      candles
    );

  const orderBlocks =
    orderBlockAnalysis(
      candles
    );

  const supplyDemand =
    supplyDemandAnalysis(
      candles
    );

  const volume =
    volumeAnalysis(
      candles
    );

  const relevant =
    relevantZonesAnalysis(
      fvg,
      orderBlocks,
      supplyDemand,
      current.close
    );

  return {
    timeframe,

    currentClosedCandle:
      current,

    formingCandle:
      null,

    candleDataNote:
      "Only closed candle data is used for confirmation.",

    structure,

    BOS:
      breaks.BOS,

    CHoCH:
      breaks.CHoCH,

    MSS:
      breaks.MSS,

    brokenLevel:
      breaks.brokenLevel,

    breakDirection:
      breaks.direction,

    liquidity,

    candle,

    displacement:
      candle?.displacement ||
      "None",

    indicators,

    trend:
      indicators.trend,

    momentum:
      indicators.momentum,

    supportResistance:
      sr,

    FVG:
      fvg,

    orderBlocks,

    supplyDemand,

    relevantZones:
      relevant,

    volume
  };
}

/* =========================================================
   MTF STRUCTURE
========================================================= */

function mtfStructure(
  a1,
  a15,
  a5
) {
  const bullish =
    [a1, a15, a5]
      .filter(
        x =>
          x.structure
            .structure ===
          "Bullish Structure"
      )
      .length;

  const bearish =
    [a1, a15, a5]
      .filter(
        x =>
          x.structure
            .structure ===
          "Bearish Structure"
      )
      .length;

  let structureBias =
    "Mixed";

  if (
    bullish >= 2
  ) {
    structureBias =
      "Bullish";
  }

  if (
    bearish >= 2
  ) {
    structureBias =
      "Bearish";
  }

  const reversal =
    a15.CHoCH !==
      "None" ||
    a15.MSS !==
      "None" ||
    a5.CHoCH !==
      "None" ||
    a5.MSS !==
      "None";

  return {
    "1H":
      a1.structure
        .structure,

    "15M":
      a15.structure
        .structure,

    "5M":
      a5.structure
        .structure,

    structureBias,

    reversalState:
      reversal
        ? "Potential Reversal Detected"
        : "No Confirmed Reversal"
  };
}

/* =========================================================
   ENTRY CONFIRMATION
========================================================= */

function entryConfirmation(
  a1,
  a15,
  a5
) {
  let bullishScore = 0;
  let bearishScore = 0;

  const bullishReasons = [];
  const bearishReasons = [];

  if (
    a1.structure
      .structure ===
    "Bullish Structure"
  ) {
    bullishScore += 2;

    bullishReasons.push(
      "1H bullish structure"
    );
  }

  if (
    a1.structure
      .structure ===
    "Bearish Structure"
  ) {
    bearishScore += 2;

    bearishReasons.push(
      "1H bearish structure"
    );
  }

  if (
    a15.structure
      .structure ===
    "Bullish Structure"
  ) {
    bullishScore++;

    bullishReasons.push(
      "15M bullish structure"
    );
  }

  if (
    a15.structure
      .structure ===
    "Bearish Structure"
  ) {
    bearishScore++;

    bearishReasons.push(
      "15M bearish structure"
    );
  }

  if (
    a15.breakDirection ===
      "Bullish" ||
    a15.CHoCH ===
      "Bullish CHoCH" ||
    a15.MSS ===
      "Bullish MSS"
  ) {
    bullishScore += 2;

    bullishReasons.push(
      "15M bullish structure confirmation"
    );
  }

  if (
    a15.breakDirection ===
      "Bearish" ||
    a15.CHoCH ===
      "Bearish CHoCH" ||
    a15.MSS ===
      "Bearish MSS"
  ) {
    bearishScore += 2;

    bearishReasons.push(
      "15M bearish structure confirmation"
    );
  }

  if (
    a5.breakDirection ===
    "Bullish"
  ) {
    bullishScore += 3;

    bullishReasons.push(
      "5M bullish BOS/CHoCH/MSS"
    );
  }

  if (
    a5.breakDirection ===
    "Bearish"
  ) {
    bearishScore += 3;

    bearishReasons.push(
      "5M bearish BOS/CHoCH/MSS"
    );
  }

  if (
    a5.indicators.RSI14 >
    50
  ) {
    bullishScore++;

    bullishReasons.push(
      "5M RSI above 50"
    );
  }

  if (
    a5.indicators.RSI14 <
    50
  ) {
    bearishScore++;

    bearishReasons.push(
      "5M RSI below 50"
    );
  }

  if (
    a5.indicators.MACD?.bias ===
    "Bullish"
  ) {
    bullishScore++;

    bullishReasons.push(
      "5M MACD bullish"
    );
  }

  if (
    a5.indicators.MACD?.bias ===
    "Bearish"
  ) {
    bearishScore++;

    bearishReasons.push(
      "5M MACD bearish"
    );
  }

  if (
    a5.liquidity.latestSweep ===
    "Bullish Liquidity Sweep"
  ) {
    bullishScore += 2;

    bullishReasons.push(
      "5M bullish liquidity sweep"
    );
  }

  if (
    a5.liquidity.latestSweep ===
    "Bearish Liquidity Sweep"
  ) {
    bearishScore += 2;

    bearishReasons.push(
      "5M bearish liquidity sweep"
    );
  }

  if (
    a5.candle?.direction ===
      "Bullish" &&
    (
      a5.candle.strength ===
        "Strong" ||
      a5.candle.patterns.includes(
        "Bullish Engulfing"
      ) ||
      a5.candle.patterns.includes(
        "Bullish Rejection"
      )
    )
  ) {
    bullishScore++;

    bullishReasons.push(
      "5M bullish candle confirmation"
    );
  }

  if (
    a5.candle?.direction ===
      "Bearish" &&
    (
      a5.candle.strength ===
        "Strong" ||
      a5.candle.patterns.includes(
        "Bearish Engulfing"
      ) ||
      a5.candle.patterns.includes(
        "Bearish Rejection"
      )
    )
  ) {
    bearishScore++;

    bearishReasons.push(
      "5M bearish candle confirmation"
    );
  }

  const bullishStructureBreak =
    a5.breakDirection ===
    "Bullish";

  const bearishStructureBreak =
    a5.breakDirection ===
    "Bearish";

  const bullishTechnical =
    a5.indicators.RSI14 >
      50 &&
    a5.indicators.MACD?.bias ===
      "Bullish";

  const bearishTechnical =
    a5.indicators.RSI14 <
      50 &&
    a5.indicators.MACD?.bias ===
      "Bearish";

  const bullishHTF =
    a1.structure.structure !==
    "Bearish Structure";

  const bearishHTF =
    a1.structure.structure !==
    "Bullish Structure";

  let status =
    "Waiting";

  let direction =
    "None";

  const entryReason = [];

  if (
    bullishStructureBreak &&
    bullishTechnical &&
    bullishHTF &&
    bullishScore >= 7 &&
    bullishScore >
      bearishScore + 2
  ) {
    status =
      "BUY CONFIRMED";

    direction =
      "BUY";

    entryReason.push(
      "5M bullish structure break confirmed"
    );

    entryReason.push(
      "5M technical confirmation aligned"
    );

    entryReason.push(
      "MTF bias supports bullish continuation/reversal"
    );
  }

  if (
    bearishStructureBreak &&
    bearishTechnical &&
    bearishHTF &&
    bearishScore >= 7 &&
    bearishScore >
      bullishScore + 2
  ) {
    status =
      "SELL CONFIRMED";

    direction =
      "SELL";

    entryReason.push(
      "5M bearish structure break confirmed"
    );

    entryReason.push(
      "5M technical confirmation aligned"
    );

    entryReason.push(
      "MTF bias supports bearish continuation/reversal"
    );
  }

  if (
    Math.abs(
      bullishScore -
      bearishScore
    ) <= 2
  ) {
    status =
      "Waiting";

    direction =
      "None";
  }

  return {
    status,
    direction,

    bullishScore,
    bearishScore,

    bullishReasons:
      [
        ...new Set(
          bullishReasons
        )
      ],

    bearishReasons:
      [
        ...new Set(
          bearishReasons
        )
      ],

    entryReason,

    confirmationRules: {
      HTFAlignmentRequired:
        true,

      LTFStructureBreakRequired:
        true,

      TechnicalConfirmationRequired:
        true,

      RetestPreferred:
        true,

      LiquiditySweepPreferred:
        true,

      DisplacementPreferred:
        true,

      CandleConfirmationPreferred:
        true
    }
  };
}

/* =========================================================
   RETEST
========================================================= */

function nearestZone(
  zones,
  price
) {
  if (
    !zones.length
  ) {
    return null;
  }

  return zones
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
    .sort(
      (a, b) =>
        a.distance -
        b.distance
    )[0];
}

function retestAnalysis(
  a5
) {
  const price =
    a5.currentClosedCandle
      .close;

  const bullishZones = [
    ...(a5.relevantZones
      .bullishFVG || []),

    ...(a5.relevantZones
      .bullishOB || []),

    ...(a5.relevantZones
      .demand || [])
  ];

  const bearishZones = [
    ...(a5.relevantZones
      .bearishFVG || []),

    ...(a5.relevantZones
      .bearishOB || []),

    ...(a5.relevantZones
      .supply || [])
  ];

  const bull =
    nearestZone(
      bullishZones,
      price
    );

  const bear =
    nearestZone(
      bearishZones,
      price
    );

  return {
    bullishRetestZone:
      bull
        ? {
            low:
              bull.low,

            high:
              bull.high,

            distance:
              round(
                bull.distance,
                5
              ),

            type:
              "Bullish zone"
          }
        : null,

    bearishRetestZone:
      bear
        ? {
            low:
              bear.low,

            high:
              bear.high,

            distance:
              round(
                bear.distance,
                5
              ),

            type:
              "Bearish zone"
          }
        : null,

    priceInBullishZone:
      !!bull &&
      zoneContains(
        bull,
        price
      ),

    priceInBearishZone:
      !!bear &&
      zoneContains(
        bear,
        price
      )
  };
}

/* =========================================================
   TRADE LEVELS
========================================================= */

function tradeLevels(
  a5,
  confirmation
) {
  if (
    confirmation.status !==
      "BUY CONFIRMED" &&
    confirmation.status !==
      "SELL CONFIRMED"
  ) {
    return null;
  }

  const price =
    a5.currentClosedCandle
      .close;

  const atrValue =
    a5.indicators.ATR14 ||
    5;

  const sr =
    a5.supportResistance;

  const direction =
    confirmation.direction;

  let stop;

  if (
    direction ===
    "BUY"
  ) {
    const structuralStop =
      sr.support
        ? sr.support -
          atrValue * 0.15
        : price -
          atrValue * 1.2;

    stop =
      Math.min(
        structuralStop,
        price -
          atrValue * 0.8
      );
  } else {
    const structuralStop =
      sr.resistance
        ? sr.resistance +
          atrValue * 0.15
        : price +
          atrValue * 1.2;

    stop =
      Math.max(
        structuralStop,
        price +
          atrValue * 0.8
      );
  }

  const risk =
    Math.abs(
      price -
      stop
    );

  if (
    !Number.isFinite(
      risk
    ) ||
    risk <= 0
  ) {
    return null;
  }

  const tp1 =
    direction ===
      "BUY"
      ? price + risk
      : price - risk;

  const tp2 =
    direction ===
      "BUY"
      ? price +
        risk * 1.5
      : price -
        risk * 1.5;

  const tp3 =
    direction ===
      "BUY"
      ? price +
        risk * 2
      : price -
        risk * 2;

  return {
    direction,

    entry:
      round(
        price,
        5
      ),

    stopLoss:
      round(
        stop,
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
          tp1,
          5
        ),

      TP2_1_5R:
        round(
          tp2,
          5
        ),

      TP3_2R:
        round(
          tp3,
          5
        )
    },

    riskReward: {
      TP1: "1:1",
      TP2: "1:1.5",
      TP3: "1:2"
    },

    note:
      "Analytical levels only. Not guaranteed execution prices."
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
        a5.supportResistance
          .support,

      structural:
        a5.structure
          .latestSwingLow
          ?.price ||
        null,

      condition:
        "Bullish thesis weakens if 5M closes below relevant structural support."
    },

    SELL: {
      primary:
        a5.supportResistance
          .resistance,

      structural:
        a5.structure
          .latestSwingHigh
          ?.price ||
        null,

      condition:
        "Bearish thesis weakens if 5M closes above relevant structural resistance."
    },

    HTFWarning: {
      "1H":
        a1.structure
          .structure,

      "15M":
        a15.structure
          .structure
    }
  };
}

/* =========================================================
   MASTER MTF ENGINE
========================================================= */

async function mtfAnalysis() {
  const [
    candles1H,
    candles15M,
    candles5M
  ] =
    await Promise.all([
      getCandles(
        TF["1H"]
      ),

      getCandles(
        TF["15M"]
      ),

      getCandles(
        TF["5M"]
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

  const confirmation =
    entryConfirmation(
      a1,
      a15,
      a5
    );

  const retest =
    retestAnalysis(
      a5
    );

  const levels =
    tradeLevels(
      a5,
      confirmation
    );

  const structure =
    mtfStructure(
      a1,
      a15,
      a5
    );

  const alignment =
    a1.trend ===
      a15.trend &&
    a15.trend ===
      a5.trend
      ? "Full MTF Alignment"
      : "Mixed MTF Alignment";

  const currentPrice =
    a5.currentClosedCandle
      .close;

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
   AI PROMPT
========================================================= */

function buildAIAnalysisPrompt(mtf) {
  return `
You are a financial market analysis assistant for XAUUSD.

Analyze ONLY the supplied technical engine output. Do not invent price data, news, indicators, levels, or confirmations.

Explain clearly:

1. 1H bias and structure
2. 15M bias and structure
3. 5M bias and structure
4. BOS / CHoCH / MSS
5. Liquidity and liquidity sweeps
6. FVG
7. Order blocks
8. Supply and demand
9. Support and resistance
10. Candlestick confirmation
11. EMA / RSI / MACD / ATR / volume information when supplied
12. Retest status
13. Entry confirmation
14. Entry, SL, TP and invalidation when supplied
15. Why the engine is BUY, SELL or WAITING

If confirmation is insufficient, explicitly say WAITING.

Do not claim certainty or guaranteed profit.
Do not override the technical engine's confirmed direction.

DATA:

${JSON.stringify(mtf, null, 2)}
`;
}

/* =========================================================
   GEMINI AI
========================================================= */

async function geminiAnalysis(mtf) {
  if (!GEMINI_API_KEY) {
    return {
      available: false,
      message:
        "GEMINI_API_KEY not configured"
    };
  }

  const prompt =
    buildAIAnalysisPrompt(mtf);

  try {
    const response =
      await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",

            "x-goog-api-key":
              GEMINI_API_KEY
          },

          body:
            JSON.stringify({
              contents: [
                {
                  parts: [
                    {
                      text:
                        prompt
                    }
                  ]
                }
              ]
            })
        }
      );

    const json =
      await response.json();

    if (
      !response.ok
    ) {
      return {
        available: false,

        error:
          json.error?.message ||
          "Gemini request failed"
      };
    }

    const text =
      json.candidates?.[0]
        ?.content?.parts?.[0]
        ?.text || null;

    if (!text) {
      return {
        available: false,
        error:
          "Gemini returned no analysis"
      };
    }

    return {
      available: true,
      provider: "Gemini",
      text
    };
  } catch (
    error
  ) {
    return {
      available: false,

      error:
        error.message
    };
  }
}

/* =========================================================
   OPENROUTER FALLBACK AI
========================================================= */

async function openRouterAnalysis(mtf) {
  if (!OPENROUTER_API_KEY) {
    return {
      available: false,
      message:
        "OPENROUTER_API_KEY not configured"
    };
  }

  const prompt =
    buildAIAnalysisPrompt(mtf);

  try {
    const response =
      await fetch(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",

            Authorization:
              `Bearer ${OPENROUTER_API_KEY}`,

            "HTTP-Referer":
              "https://xau-ai-bot-1.onrender.com",

            "X-Title":
              "XAU AI Strong Market Analysis Engine"
          },

          body:
            JSON.stringify({
              model:
                "openrouter/free",

              messages: [
                {
                  role:
                    "user",

                  content:
                    prompt
                }
              ]
            })
        }
      );

    const json =
      await response.json();

    if (
      !response.ok
    ) {
      return {
        available: false,

        error:
          json.error?.message ||
          "OpenRouter request failed"
      };
    }

    const text =
      json.choices?.[0]
        ?.message?.content ||
      null;

    if (!text) {
      return {
        available: false,

        error:
          "OpenRouter returned no analysis"
      };
    }

    return {
      available: true,

      provider:
        "OpenRouter",

      model:
        "openrouter/free",

      text
    };
  } catch (
    error
  ) {
    return {
      available: false,

      error:
        error.message
    };
  }
}

/* =========================================================
   AI FALLBACK CONTROLLER
========================================================= */

async function aiAnalysis(mtf) {
  const gemini =
    await geminiAnalysis(
      mtf
    );

  if (
    gemini?.available &&
    gemini.text
  ) {
    return gemini;
  }

  console.log(
    "Gemini unavailable. Trying OpenRouter."
  );

  const openrouter =
    await openRouterAnalysis(
      mtf
    );

  if (
    openrouter?.available &&
    openrouter.text
  ) {
    return openrouter;
  }

  return {
    available: false,

    provider:
      "None",

    error:
      "Gemini and OpenRouter unavailable",

    geminiError:
      gemini?.error ||
      gemini?.message ||
      "Gemini unavailable",

    openRouterError:
      openrouter?.error ||
      openrouter?.message ||
      "OpenRouter unavailable"
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
      `\n${ai.provider || "AI"} ANALYSIS\n` +
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

/* =========================================================
   HOURLY TELEGRAM SCHEDULER
========================================================= */

async function sendHourlyTelegramStatus() {
  try {
    const mtf =
      await mtfAnalysis();

    const ai =
      await aiAnalysis(
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

async function sendHourlyTelegramStatus() {
  try {
    const mtf =
      await mtfAnalysis();

    const ai =
      await aiAnalysis(
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
        "/telegram-test"
      ]
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
   FULL ANALYSIS + CONFIRMED TELEGRAM
========================================================= */

app.get(
  "/analyze",
  async (req, res) => {
    try {
      const mtf =
        await mtfAnalysis();

      const ai =
        await aiAnalysis(
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
              mtf,
              ai
            )
          );
      }

      res.json({
        ...mtf,

        AI_ANALYSIS:
          ai,

        TELEGRAM:
          telegram
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

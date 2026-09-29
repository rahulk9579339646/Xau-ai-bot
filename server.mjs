import express from "express";

const app = express();
app.use(express.json());
/* =========================================================
   CORS FOR FXBLUE CONDITIONS PANEL
========================================================= */

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

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

  const indicators =
    indicatorAnalysis(
      candles
    );

  const fvg =
    findFVG(
      candles
    );

  const orderBlocks =
    findOrderBlocks(
      candles
    );

  const supplyDemand =
    findSupplyDemand(
      candles
    );

  const sr =
    supportResistance(
      candles,
      structure
    );

  const volume =
    volumeAnalysis(
      candles
    );

  const relevant =
    relevantZones(
      candles,
      fvg,
      orderBlocks,
      supplyDemand
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
);/* =========================================================
   SERVER
========================================================= */
/* =========================================================
   FXBLUE CONDITIONS PANEL
   READ-ONLY - DOES NOT PLACE TRADES
========================================================= */

app.get("/conditions", async (req, res) => {
  try {
    const mtf = await mtfAnalysis();

    const a1 = mtf.analysis?.["1H"] || {};
    const a15 = mtf.analysis?.["15M"] || {};
    const a5 = mtf.analysis?.["5M"] || {};

    const buyCandle =
      a5.candle?.direction === "Bullish" &&
      (
        a5.candle?.strength === "Strong" ||
        a5.candle?.patterns?.includes("Bullish Engulfing") ||
        a5.candle?.patterns?.includes("Bullish Rejection")
      );

    const sellCandle =
      a5.candle?.direction === "Bearish" &&
      (
        a5.candle?.strength === "Strong" ||
        a5.candle?.patterns?.includes("Bearish Engulfing") ||
        a5.candle?.patterns?.includes("Bearish Rejection")
      );

    const conditions = {
      buy: {
        htfStructure:
          a1.structure?.structure === "Bullish Structure",

        m15Structure:
          a15.structure?.structure === "Bullish Structure",

        m15StructureConfirmation:
          a15.breakDirection === "Bullish" ||
          a15.CHoCH === "Bullish CHoCH" ||
          a15.MSS === "Bullish MSS",

        m5StructureBreak:
          a5.breakDirection === "Bullish",

        rsi:
          Number(a5.indicators?.RSI14) > 50,

        macd:
          a5.indicators?.MACD?.bias === "Bullish",

        liquiditySweep:
          a5.liquidity?.latestSweep ===
          "Bullish Liquidity Sweep",

        candleConfirmation:
          buyCandle
      },

      sell: {
        htfStructure:
          a1.structure?.structure === "Bearish Structure",

        m15Structure:
          a15.structure?.structure === "Bearish Structure",

        m15StructureConfirmation:
          a15.breakDirection === "Bearish" ||
          a15.CHoCH === "Bearish CHoCH" ||
          a15.MSS === "Bearish MSS",

        m5StructureBreak:
          a5.breakDirection === "Bearish",

        rsi:
          Number(a5.indicators?.RSI14) < 50,

        macd:
          a5.indicators?.MACD?.bias === "Bearish",

        liquiditySweep:
          a5.liquidity?.latestSweep ===
          "Bearish Liquidity Sweep",

        candleConfirmation:
          sellCandle
      }
    };

    res.json({
      success: true,
      instrument: "XAUUSD",

      generatedAt:
        mtf.generatedAt,

      currentPrice:
        mtf.ENTRY_CONFIRMATION?.currentPrice ?? null,

      status:
        mtf.ENTRY_CONFIRMATION?.status ?? "Waiting",

      direction:
        mtf.ENTRY_CONFIRMATION?.direction ?? "None",

      scores: {
        buy:
          mtf.ENTRY_CONFIRMATION?.bullishScore ?? 0,

        sell:
          mtf.ENTRY_CONFIRMATION?.bearishScore ?? 0,

        maximum: 13,

        minimumRequired: 7
      },

      mtf: {
        "1H":
          mtf.MTF?.["1H"] ?? null,

        "15M":
          mtf.MTF?.["15M"] ?? null,

        "5M":
          mtf.MTF?.["5M"] ?? null,

        alignment:
          mtf.MTF?.alignment ?? null
      },

      structure: {
        "1H_BOS":
          mtf.MTF_CONFIRMATION?.HTF_BOS ?? null,

        "5M_BOS":
          mtf.MTF_CONFIRMATION?.LTF_BOS ?? null,

        "1H_CHoCH":
          mtf.MTF_CONFIRMATION?.["1H_CHoCH"] ?? null,

        "15M_CHoCH":
          mtf.MTF_CONFIRMATION?.["15M_CHoCH"] ?? null,

        "5M_CHoCH":
          mtf.MTF_CONFIRMATION?.["5M_CHoCH"] ?? null,

        "1H_MSS":
          mtf.MTF_CONFIRMATION?.["1H_MSS"] ?? null,

        "15M_MSS":
          mtf.MTF_CONFIRMATION?.["15M_MSS"] ?? null,

        "5M_MSS":
          mtf.MTF_CONFIRMATION?.["5M_MSS"] ?? null
      },

      details: {
        RSI14:
          a5.indicators?.RSI14 ?? null,

        MACD:
          a5.indicators?.MACD?.bias ?? "Unknown",

        liquiditySweep:
          a5.liquidity?.latestSweep ?? "None",

        candleDirection:
          a5.candle?.direction ?? "Neutral",

        candleStrength:
          a5.candle?.strength ?? "Unknown",

        candlePatterns:
          a5.candle?.patterns ?? [],

        displacement:
          a5.candle?.displacement ?? null
      },

      conditions
    });

  } catch (error) {

    res.status(500).json({
      success: false,
      error: error.message
    });

  }
});
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

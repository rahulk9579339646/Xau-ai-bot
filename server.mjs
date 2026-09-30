import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL =
  process.env.OPENROUTER_MODEL ||
  "openai/gpt-5.4-mini";

const OPENROUTER_FALLBACK_MODEL =
  process.env.OPENROUTER_FALLBACK_MODEL ||
  "anthropic/claude-sonnet-4.6";

const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN;

const TELEGRAM_CHAT_ID =
  process.env.TELEGRAM_CHAT_ID ||
  "710410869";

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

  return Number.isFinite(n)
    ? n
    : d;
}

function round(v, d = 2) {
  if (!Number.isFinite(v)) {
    return null;
  }

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
  const x =
    a.filter(
      Number.isFinite
    );

  return x.length
    ? x.reduce(
        (s, v) => s + v,
        0
      ) / x.length
    : null;
}

function clamp(v, min, max) {
  return Math.max(
    min,
    Math.min(max, v)
  );
}

/* =========================================================
   CANDLES
========================================================= */

function normalizeCandles(values) {
  return values
    .map(x => ({
      time: x.datetime,

      open:
        num(x.open),

      high:
        num(x.high),

      low:
        num(x.low),

      close:
        num(x.close),

      volume:
        num(x.volume)
    }))
    .filter(
      x =>
        x.time &&
        [
          x.open,
          x.high,
          x.low,
          x.close
        ].every(
          Number.isFinite
        )
    )
    .sort(
      (a, b) =>
        new Date(a.time) -
        new Date(b.time)
    );
}


/*
   BIQUOTE

   Important:
   Biquote may return:
   volume = 0
   tickVolume = actual tick count

   Therefore when real volume is 0,
   tickVolume is used.
*/

function normalizeBiquoteCandles(bars) {
  return bars
    .filter(
      x => !x.isOpen
    )
    .map(x => ({
      time:
        x.openTime,

      open:
        num(x.open),

      high:
        num(x.high),

      low:
        num(x.low),

      close:
        num(x.close),

      volume:
        (() => {
          const realVolume =
            num(x.volume);

          const tickVolume =
            num(x.tickVolume);

          return (
            realVolume !== null &&
            realVolume > 0
          )
            ? realVolume
            : tickVolume;
        })()
    }))
    .filter(
      x =>
        x.time &&
        [
          x.open,
          x.high,
          x.low,
          x.close
        ].every(
          Number.isFinite
        )
    )
    .sort(
      (a, b) =>
        new Date(a.time) -
        new Date(b.time)
    );
}


function biquoteInterval(
  interval
) {
  const map = {
    "1min": "1m",
    "5min": "5m",
    "15min": "15m",
    "30min": "30m",
    "1h": "1h",
    "4h": "4h",
    "1d": "1d"
  };

  return (
    map[interval] ||
    interval
  );
}


async function getCandlesFromBiquote(
  interval,
  outputsize = 350
) {
  const limit =
    Math.min(
      Math.max(
        outputsize,
        100
      ),
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
    !Array.isArray(
      json.bars
    )
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

  if (
    candles.length < 60
  ) {
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
    Date.now() -
      cached.time <
      CACHE_MS
  ) {
    return cached.data;
  }

  let twelveError =
    null;

  if (
    TWELVE_DATA_API_KEY
  ) {
    try {
      const url =
        `https://api.twelvedata.com/time_series` +
        `?symbol=${encodeURIComponent(
          SYMBOL
        )}` +
        `&interval=${encodeURIComponent(
          interval
        )}` +
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

      CACHE.set(
        cacheKey,
        {
          time:
            Date.now(),

          data:
            candles
        }
      );

      return candles;
    } catch (error) {
      twelveError =
        error;
    }
  } else {
    twelveError =
      new Error(
        "TWELVE_DATA_API_KEY is missing"
      );
  }

  try {
    const candles =
      await getCandlesFromBiquote(
        interval,
        outputsize
      );

    CACHE.set(
      cacheKey,
      {
        time:
          Date.now(),

        data:
          candles
      }
    );

    return candles;
  } catch (
    biquoteError
  ) {
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

async function sendTelegramMessage(
  message
) {
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
    const text =
      String(
        message ?? ""
      );

    const chunks = [];

    for (
      let i = 0;
      i < text.length;
      i += 3900
    ) {
      chunks.push(
        text.slice(
          i,
          i + 3900
        )
      );
    }

    if (
      !chunks.length
    ) {
      chunks.push(
        "XAU AI BOT\n\nEmpty Telegram message."
      );
    }

    for (
      const chunk of chunks
    ) {
      const response =
        await fetch(
          `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
          {
            method:
              "POST",

            headers: {
              "Content-Type":
                "application/json"
            },

            body:
              JSON.stringify({
                chat_id:
                  TELEGRAM_CHAT_ID,

                text:
                  chunk
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
    }

    return {
      sent: true,

      chunks:
        chunks.length
    };
  } catch (error) {
    return {
      sent: false,

      error:
        error.message
    };
  }
}


function buildTelegramMessage(
  mtf
) {
  const entry =
    mtf.ENTRY_CONFIRMATION ||
    {};

  const levels =
    mtf.TRADE_LEVELS ||
    null;

  const price =
    entry.currentPrice ??
    mtf.importantLevels
      ?.currentPrice ??
    "N/A";

  let message =
    `XAUUSD MTF ALERT\n\n` +

    `Price: ${price}\n` +

    `Status: ${
      entry.status ||
      "Waiting"
    }\n` +

    `Direction: ${
      entry.direction ||
      "None"
    }\n` +

    `Grade: ${
      entry.confirmationGrade ||
      "NONE"
    }\n\n` +

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

    `Bull Score: ${
      entry.bullishScore ??
      0
    }\n` +

    `Bear Score: ${
      entry.bearishScore ??
      0
    }\n\n` +

    `BOS / CHoCH / MSS\n` +

    `1H BOS: ${
      mtf.MTF_CONFIRMATION
        ?.HTF_BOS ||
      "None"
    }\n` +

    `15M CHoCH: ${
      mtf.MTF_CONFIRMATION
        ?.["15M_CHoCH"] ||
      "None"
    }\n` +

    `5M BOS: ${
      mtf.MTF_CONFIRMATION
        ?.LTF_BOS ||
      "None"
    }\n` +

    `5M CHoCH: ${
      mtf.MTF_CONFIRMATION
        ?.["5M_CHoCH"] ||
      "None"
    }\n`;

  if (
    entry.bullishReasons
      ?.length
  ) {
    message +=
      `\nBullish Reasons:\n` +

      entry.bullishReasons
        .slice(0, 8)
        .map(
          x =>
            `• ${x}`
        )
        .join("\n") +

      "\n";
  }

  if (
    entry.bearishReasons
      ?.length
  ) {
    message +=
      `\nBearish Reasons:\n` +

      entry.bearishReasons
        .slice(0, 8)
        .map(
          x =>
            `• ${x}`
        )
        .join("\n") +

      "\n";
  }

  if (
    entry.potentialSetup
  ) {
    message +=
      `\nPotential Setup: YES\n`;
  }

  if (
    entry.status ===
    "WAITING"
  ) {
    message +=
      `\nWaiting Reason:\n${
        entry.rejectionReason ||
        "Confirmation incomplete"
      }\n`;
  }

  if (levels) {
    message +=
      `\nTRADE LEVELS\n` +

      `Entry: ${
        levels.entry
      }\n` +

      `SL: ${
        levels.stopLoss
      }\n` +

      `TP1: ${
        levels.takeProfit
          .TP1_1R
      }\n` +

      `TP2: ${
        levels.takeProfit
          .TP2_1_5R
      }\n` +

      `TP3: ${
        levels.takeProfit
          .TP3_2R
      }\n`;
  }

  return message;
}


/* =========================================================
   INDICATORS
========================================================= */

function ema(
  values,
  period
) {
  if (
    values.length <
    period
  ) {
    return null;
  }

  const k =
    2 /
    (period + 1);

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
    2 /
    (period + 1);

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

    result[i] =
      e;
  }

  return result;
}


function rsi(
  values,
  period = 14
) {
  if (
    values.length <=
    period
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

    if (
      diff >= 0
    ) {
      gains +=
        diff;
    } else {
      losses +=
        Math.abs(diff);
    }
  }

  let avgGain =
    gains /
    period;

  let avgLoss =
    losses /
    period;

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
      ) /
      period;

    avgLoss =
      (
        avgLoss *
          (period - 1) +
        loss
      ) /
      period;
  }

  if (
    avgLoss === 0
  ) {
    return 100;
  }

  const rs =
    avgGain /
    avgLoss;

  return (
    100 -
    100 /
      (1 + rs)
  );
}


function atr(
  candles,
  period = 14
) {
  if (
    candles.length <=
    period
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
        c.high -
          c.low,

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
    trs.slice(
      -period
    )
  );
}


function macd(
  values
) {
  if (
    values.length <
    35
  ) {
    return null;
  }

  const e12 =
    ema(
      values,
      12
    );

  const e26 =
    ema(
      values,
      26
    );

  if (
    !Number.isFinite(
      e12
    ) ||
    !Number.isFinite(
      e26
    )
  ) {
    return null;
  }

  const s12 =
    emaSeries(
      values,
      12
    );

  const s26 =
    emaSeries(
      values,
      26
    );

  const series = [];

  for (
    let i = 0;
    i < values.length;
    i++
  ) {
    if (
      Number.isFinite(
        s12[i]
      ) &&
      Number.isFinite(
        s26[i]
      )
    ) {
      series.push(
        s12[i] -
        s26[i]
      );
    }
  }

  const signal =
    ema(
      series,
      9
    );

  const line =
    e12 - e26;

  if (
    !Number.isFinite(
      signal
    )
  ) {
    return {
      line,

      signal:
        null,

      histogram:
        null,

      bias:
        "Unknown"
    };
  }

  const histogram =
    line -
    signal;

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
    i <
      candles.length -
        right;
    i++
  ) {
    let highPivot =
      true;

    let lowPivot =
      true;

    for (
      let j =
        i - left;
      j <=
        i + right;
      j++
    ) {
      if (
        j === i
      ) {
        continue;
      }

      if (
        candles[j].high >=
        candles[i].high
      ) {
        highPivot =
          false;
      }

      if (
        candles[j].low <=
        candles[i].low
      ) {
        lowPivot =
          false;
      }
    }

    if (
      highPivot
    ) {
      highs.push({
        index:
          i,

        price:
          candles[i].high,

        time:
          candles[i].time
      });
    }

    if (
      lowPivot
    ) {
      lows.push({
        index:
          i,

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

  if (
    HH &&
    HL
  ) {
    structure =
      "Bullish Structure";
  } else if (
    LH &&
    LL
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

  if (
    !current ||
    !prev
  ) {
    return {
      BOS:
        "None",

      CHoCH:
        "None",

      MSS:
        "None",

      brokenLevel:
        null,

      direction:
        "None"
    };
  }

  const atrValue =
    atr(
      candles,
      14
    ) ||
    0;

  const buffer =
    atrValue *
    0.03;

  const brokeHigh =
    structure.latestSwingHigh &&
    current.close >
      structure
        .latestSwingHigh
        .price +
      buffer &&
    prev.close <=
      structure
        .latestSwingHigh
        .price +
      buffer;

  const brokeLow =
    structure.latestSwingLow &&
    current.close <
      structure
        .latestSwingLow
        .price -
      buffer &&
    prev.close >=
      structure
        .latestSwingLow
        .price -
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
      ? body /
        range
      : 0;

  const displacement =
    atrValue > 0 &&
    range >=
      atrValue *
        0.85 &&
    bodyRatio >=
      0.50;

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
    BOS:
      "None",

    CHoCH:
      "None",

    MSS:
      "None",

    brokenLevel:
      null,

    direction:
      "None"
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

  if (!c) {
    return null;
  }

  const range =
    c.high -
    c.low;

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
    ) -
    c.low;

  const bodyRatio =
    range > 0
      ? body /
        range
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
    bodyRatio >=
    0.70
  ) {
    strength =
      "Strong";
  } else if (
    bodyRatio >=
    0.45
  ) {
    strength =
      "Medium";
  }

  const patterns = [];

  if (
    bodyRatio <=
    0.15
  ) {
    patterns.push(
      "Doji-like"
    );
  }

  if (
    p &&
    bullish &&
    p.close <
      p.open &&
    c.open <=
      p.close &&
    c.close >=
      p.open
  ) {
    patterns.push(
      "Bullish Engulfing"
    );
  }

  if (
    p &&
    bearish &&
    p.close >
      p.open &&
    c.open >=
      p.close &&
    c.close <=
      p.open
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
    atr(
      candles,
      14
    );

  let displacement =
    "None";

  if (
    atrValue &&
    range >=
      atrValue *
        1.2 &&
    bodyRatio >=
      0.65
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
      round(
        body,
        5
      ),

    range:
      round(
        range,
        5
      ),

    bodyRatio:
      round(
        bodyRatio,
        3
      ),

    upperWick:
      round(
        upperWick,
        5
      ),

    lowerWick:
      round(
        lowerWick,
        5
      ),

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
    [
      ...values
    ].sort(
      (a, b) =>
        a - b
    );

  const clusters = [];

  for (
    const value of sorted
  ) {
    const existing =
      clusters.find(
        c =>
          Math.abs(
            c.price -
            value
          ) <=
          tolerance
      );

    if (
      existing
    ) {
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
        price:
          value,

        values: [
          value
        ],

        count:
          1
      });
    }
  }

  return clusters
    .filter(
      x =>
        x.count >=
        2
    )
    .sort(
      (a, b) =>
        b.count -
        a.count
    )
    .slice(
      0,
      10
    )
    .map(
      x => ({
        price:
          round(
            x.price,
            5
          ),

        count:
          x.count
      })
    );
}


function liquidityAnalysis(
  candles
) {
  const atrValue =
    atr(
      candles,
      14
    ) ||
    1;

  const tolerance =
    atrValue *
    0.08;

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
    candles.slice(
      -8
    );

  for (
    const c of recent
  ) {
    const sweptHigh =
      equalHighs.some(
        x =>
          c.high >
            x.price +
            tolerance *
              0.25 &&
          c.close <
            x.price
      );

    const sweptLow =
      equalLows.some(
        x =>
          c.low <
            x.price -
            tolerance *
              0.25 &&
          c.close >
            x.price
      );

    if (
      sweptHigh
    ) {
      latestSweep =
        "Bearish Liquidity Sweep";
    }

    if (
      sweptLow
    ) {
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
      candles[
        i - 2
      ];

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

        index:
          i,

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

        index:
          i,

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
    i <
      candles.length - 1;
    i++
  ) {
    const prev =
      candles[
        i - 1
      ];

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

    if (
      !strongMove
    ) {
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
        (a, b) =>
          b - a
      );

  const above =
    resistances
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
    i <
      candles.length - 1;
    i++
  ) {
    const a =
      candles[
        i - 1
      ];

    const b =
      candles[i];

    const range =
      b.high -
      b.low;

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
        x =>
          x.volume
      )
      .filter(
        Number.isFinite
      );

  if (
    volumes.length <
    20
  ) {
    return {
      available:
        false,

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
    available:
      true,

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
        average *
          1.5
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
      x =>
        x.close
    );

  const EMA9 =
    ema(
      closes,
      9
    );

  const EMA21 =
    ema(
      closes,
      21
    );

  const EMA50 =
    ema(
      closes,
      50
    );

  const RSI14 =
    rsi(
      closes,
      14
    );

  const ATR14 =
    atr(
      candles,
      14
    );

  const MACD =
    macd(
      closes
    );

  let trend =
    "Neutral";

  if (
    EMA9 >
      EMA21 &&
    EMA21 >
      EMA50
  ) {
    trend =
      "Strong Bullish";
  } else if (
    EMA9 <
      EMA21 &&
    EMA21 <
      EMA50
  ) {
    trend =
      "Strong Bearish";
  } else if (
    EMA9 >
    EMA21
  ) {
    trend =
      "Bullish";
  } else if (
    EMA9 <
    EMA21
  ) {
    trend =
      "Bearish";
  }

  let momentum =
    "Neutral Momentum";

  if (
    RSI14 >=
    55
  ) {
    momentum =
      "Bullish Momentum";
  } else if (
    RSI14 <=
    45
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
    price >=
      zone.low &&
    price <=
      zone.high
  );
}


function relevantZones(
  candles,
  fvg,
  ob,
  sd
) {
  const price =
    last(candles)
      .close;

  const atrValue =
    atr(
      candles,
      14
    ) ||
    10;

  const maxDistance =
    atrValue *
    4;

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
   TIMEFRAME ANALYSIS
========================================================= */

function analyzeTimeframe(
  candles,
  label
) {
  if (
    !Array.isArray(candles) ||
    candles.length < 60
  ) {
    throw new Error(
      `${label}: insufficient candles`
    );
  }

  /*
    Closed candles only.
    The current forming candle is excluded
    whenever the data source marks it as open.
  */

  const closed =
    candles.filter(
      x => x && x.time
    );

  const current =
    last(closed);

  const structure =
    structureAnalysis(
      closed
    );

  const breakAnalysis =
    structureBreakAnalysis(
      closed,
      structure
    );

  const indicators =
    indicatorAnalysis(
      closed
    );

  const candle =
    candleAnalysis(
      closed
    );

  const liquidity =
    liquidityAnalysis(
      closed
    );

  const fvg =
    findFVG(
      closed
    );

  const orderBlocks =
    findOrderBlocks(
      closed
    );

  const supplyDemand =
    findSupplyDemand(
      closed
    );

  const volume =
    volumeAnalysis(
      closed
    );

  const levels =
    supportResistance(
      closed,
      structure
    );

  const zones =
    relevantZones(
      closed,
      fvg,
      orderBlocks,
      supplyDemand
    );

  return {
    timeframe:
      label,

    candles:
      closed.length,

    currentPrice:
      round(
        current.close,
        5
      ),

    trend:
      indicators.trend,

    structure,

    BOS:
      breakAnalysis.BOS,

    CHoCH:
      breakAnalysis.CHoCH,

    MSS:
      breakAnalysis.MSS,

    breakDirection:
      breakAnalysis.direction,

    brokenLevel:
      breakAnalysis.brokenLevel,

    indicators,

    candle,

    liquidity,

    volume,

    levels,

    FVG:
      fvg,

    ORDER_BLOCKS:
      orderBlocks,

    SUPPLY_DEMAND:
      supplyDemand,

    zones
  };
}


/* =========================================================
   MTF STRUCTURE
========================================================= */

function buildMTFStructure(
  a1,
  a15,
  a5
) {
  const structures = {
    "1H":
      a1.structure
        ?.structure ||
      "Unknown",

    "15M":
      a15.structure
        ?.structure ||
      "Unknown",

    "5M":
      a5.structure
        ?.structure ||
      "Unknown"
  };

  const bullishCount =
    Object.values(
      structures
    ).filter(
      x =>
        x ===
        "Bullish Structure"
    ).length;

  const bearishCount =
    Object.values(
      structures
    ).filter(
      x =>
        x ===
        "Bearish Structure"
    ).length;

  let structureBias =
    "Mixed";

  if (
    bullishCount >= 2 &&
    bearishCount === 0
  ) {
    structureBias =
      "Bullish";
  } else if (
    bearishCount >= 2 &&
    bullishCount === 0
  ) {
    structureBias =
      "Bearish";
  }

  const bullishReversal =
    [
      a1.CHoCH,
      a15.CHoCH,
      a5.CHoCH
    ].some(
      x =>
        x ===
        "Bullish CHoCH"
    );

  const bearishReversal =
    [
      a1.CHoCH,
      a15.CHoCH,
      a5.CHoCH
    ].some(
      x =>
        x ===
        "Bearish CHoCH"
    );

  let reversalState =
    "No Confirmed Reversal";

  if (
    bullishReversal &&
    !bearishReversal
  ) {
    reversalState =
      "Bullish Reversal Signal";
  } else if (
    bearishReversal &&
    !bullishReversal
  ) {
    reversalState =
      "Bearish Reversal Signal";
  } else if (
    bullishReversal &&
    bearishReversal
  ) {
    reversalState =
      "Conflicting Reversal Signals";
  }

  return {
    "1H":
      structures["1H"],

    "15M":
      structures["15M"],

    "5M":
      structures["5M"],

    structureBias,

    reversalState
  };
}


/* =========================================================
   MTF DIRECTION
========================================================= */

function buildMTFDirection(
  a1,
  a15,
  a5
) {
  const directions = {
    "1H":
      a1.trend ||
      "Neutral",

    "15M":
      a15.trend ||
      "Neutral",

    "5M":
      a5.trend ||
      "Neutral"
  };

  const bullish =
    Object.values(
      directions
    ).filter(
      x =>
        x ===
          "Bullish" ||
        x ===
          "Strong Bullish"
    ).length;

  const bearish =
    Object.values(
      directions
    ).filter(
      x =>
        x ===
          "Bearish" ||
        x ===
          "Strong Bearish"
    ).length;

  let alignment =
    "Mixed MTF Alignment";

  if (
    bullish === 3
  ) {
    alignment =
      "Full MTF Bullish Alignment";
  } else if (
    bearish === 3
  ) {
    alignment =
      "Full MTF Bearish Alignment";
  } else if (
    bullish >= 2 &&
    bearish === 0
  ) {
    alignment =
      "Bullish MTF Alignment";
  } else if (
    bearish >= 2 &&
    bullish === 0
  ) {
    alignment =
      "Bearish MTF Alignment";
  }

  return {
    "1H":
      directions["1H"],

    "15M":
      directions["15M"],

    "5M":
      directions["5M"],

    alignment
  };
}


/* =========================================================
   MTF CONFIRMATION
========================================================= */

function buildMTFConfirmation(
  a1,
  a15,
  a5
) {
  const htfBos =
    a1.BOS !==
      "None"
      ? a1.BOS
      : "None";

  const m15Bos =
    a15.BOS !==
      "None"
      ? a15.BOS
      : "None";

  const ltfBos =
    a5.BOS !==
      "None"
      ? a5.BOS
      : "None";

  const m15Choch =
    a15.CHoCH !==
      "None"
      ? a15.CHoCH
      : "None";

  const m5Choch =
    a5.CHoCH !==
      "None"
      ? a5.CHoCH
      : "None";

  const m5Mss =
    a5.MSS !==
      "None"
      ? a5.MSS
      : "None";

  const bullishBreak =
    [
      a1.breakDirection,
      a15.breakDirection,
      a5.breakDirection
    ].filter(
      x =>
        x ===
        "Bullish"
    ).length;

  const bearishBreak =
    [
      a1.breakDirection,
      a15.breakDirection,
      a5.breakDirection
    ].filter(
      x =>
        x ===
        "Bearish"
    ).length;

  return {
    HTF_BOS:
      htfBos,

    "15M_BOS":
      m15Bos,

    LTF_BOS:
      ltfBos,

    "15M_CHoCH":
      m15Choch,

    "5M_CHoCH":
      m5Choch,

    "5M_MSS":
      m5Mss,

    bullishBreakCount:
      bullishBreak,

    bearishBreakCount:
      bearishBreak,

    bullishConfirmed:
      bullishBreak >= 2,

    bearishConfirmed:
      bearishBreak >= 2
  };
}


/* =========================================================
   RETEST ZONES
========================================================= */

function buildRetestZones(
  a1,
  a15,
  a5
) {
  const price =
    a5.currentPrice;

  const atrValue =
    a5.indicators
      ?.ATR14 ||
    a15.indicators
      ?.ATR14 ||
    a1.indicators
      ?.ATR14 ||
    1;

  const zoneWidth =
    atrValue *
    0.08;

  const bullishCandidates = [];
  const bearishCandidates = [];

  /*
    Bullish FVG
  */

  for (
    const z of
      a5.FVG?.bullish ||
      []
  ) {
    bullishCandidates.push({
      low:
        z.low,

      high:
        z.high,

      source:
        "5M Bullish FVG"
    });
  }

  /*
    Bullish Order Block
  */

  for (
    const z of
      a5.ORDER_BLOCKS
        ?.bullish ||
      []
  ) {
    bullishCandidates.push({
      low:
        z.low,

      high:
        z.high,

      source:
        "5M Bullish Order Block"
    });
  }

  /*
    Bearish FVG
  */

  for (
    const z of
      a5.FVG?.bearish ||
      []
  ) {
    bearishCandidates.push({
      low:
        z.low,

      high:
        z.high,

      source:
        "5M Bearish FVG"
    });
  }

  /*
    Bearish Order Block
  */

  for (
    const z of
      a5.ORDER_BLOCKS
        ?.bearish ||
      []
  ) {
    bearishCandidates.push({
      low:
        z.low,

      high:
        z.high,

      source:
        "5M Bearish Order Block"
    });
  }

  /*
    Add nearby structural levels
  */

  if (
    Number.isFinite(
      a5.levels?.support
    )
  ) {
    bullishCandidates.push({
      low:
        a5.levels.support -
        zoneWidth,

      high:
        a5.levels.support +
        zoneWidth,

      source:
        "5M Support"
    });
  }

  if (
    Number.isFinite(
      a5.levels?.resistance
    )
  ) {
    bearishCandidates.push({
      low:
        a5.levels.resistance -
        zoneWidth,

      high:
        a5.levels.resistance +
        zoneWidth,

      source:
        "5M Resistance"
    });
  }

  function nearest(
    zones,
    direction
  ) {
    const filtered =
      zones
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
              price <
                z.low
                ? z.low -
                  price
                : price >
                    z.high
                  ? price -
                    z.high
                  : 0
          })
        )
        .filter(
          z =>
            z.distance <=
            atrValue * 2
        )
        .sort(
          (a, b) =>
            a.distance -
            b.distance
        );

    if (
      !filtered.length
    ) {
      return null;
    }

    return filtered[0];
  }

  const bullishZone =
    nearest(
      bullishCandidates,
      "bullish"
    );

  const bearishZone =
    nearest(
      bearishCandidates,
      "bearish"
    );

  return {
    bullishZone,

    bearishZone,

    price,

    priceInBullishZone:
      !!(
        bullishZone &&
        zoneContains(
          bullishZone,
          price
        )
      ),

    priceInBearishZone:
      !!(
        bearishZone &&
        zoneContains(
          bearishZone,
          price
        )
      )
  };
}


/* =========================================================
   INVALIDATION
========================================================= */

function buildInvalidation(
  a1,
  a15,
  a5
) {
  const current =
    a5.currentPrice;

  const atrValue =
    a5.indicators
      ?.ATR14 ||
    a15.indicators
      ?.ATR14 ||
    1;

  const support =
    a5.levels
      ?.support;

  const nextSupport =
    a5.levels
      ?.nextSupport;

  const resistance =
    a5.levels
      ?.resistance;

  const nextResistance =
    a5.levels
      ?.nextResistance;

  const buyPrimary =
    Number.isFinite(
      support
    )
      ? support
      : current -
        atrValue;

  const buySecondary =
    Number.isFinite(
      nextSupport
    )
      ? nextSupport
      : buyPrimary -
        atrValue *
          0.5;

  const sellPrimary =
    Number.isFinite(
      resistance
    )
      ? resistance
      : current +
        atrValue;

  const sellSecondary =
    Number.isFinite(
      nextResistance
    )
      ? nextResistance
      : sellPrimary +
        atrValue *
          0.5;

  return {
    BUY: {
      primary:
        round(
          buyPrimary,
          5
        ),

      secondary:
        round(
          buySecondary,
          5
        )
    },

    SELL: {
      primary:
        round(
          sellPrimary,
          5
        ),

      secondary:
        round(
          sellSecondary,
          5
        )
    }
  };
}


/* =========================================================
   TRADE LEVELS
========================================================= */

function buildTradeLevels(
  entryConfirmation,
  a1,
  a15,
  a5
) {
  if (
    !entryConfirmation ||
    ![
      "BUY CONFIRMED",
      "SELL CONFIRMED"
    ].includes(
      entryConfirmation.status
    )
  ) {
    return null;
  }

  const direction =
    entryConfirmation.direction;

  const entry =
    a5.currentPrice;

  const atrValue =
    a5.indicators
      ?.ATR14 ||
    a15.indicators
      ?.ATR14 ||
    a1.indicators
      ?.ATR14;

  if (
    !Number.isFinite(
      entry
    ) ||
    !Number.isFinite(
      atrValue
    )
  ) {
    return null;
  }

  /*
    Structural SL first.
    ATR fallback only when structural level
    is unavailable.
  */

  const invalidation =
    direction ===
    "BUY"
      ? a5.levels
          ?.support
      : a5.levels
          ?.resistance;

  let stopLoss;

  if (
    direction ===
    "BUY"
  ) {
    stopLoss =
      Number.isFinite(
        invalidation
      )
        ? invalidation -
          atrValue *
            0.10
        : entry -
          atrValue;
  } else {
    stopLoss =
      Number.isFinite(
        invalidation
      )
        ? invalidation +
          atrValue *
            0.10
        : entry +
          atrValue;
  }

  const risk =
    Math.abs(
      entry -
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

  const tp1 =
    direction ===
    "BUY"
      ? entry +
        risk
      : entry -
        risk;

  const tp2 =
    direction ===
    "BUY"
      ? entry +
        risk *
          1.5
      : entry -
        risk *
          1.5;

  const tp3 =
    direction ===
    "BUY"
      ? entry +
        risk * 2
      : entry -
        risk * 2;

  return {
    direction,

    entry:
      round(
        entry,
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

    confirmationGrade:
      entryConfirmation
        .confirmationGrade
  };
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
  let bullishScore =
    0;

  let bearishScore =
    0;

  const bullishReasons =
    [];

  const bearishReasons =
    [];

  const bullishStructureBreak =
    a5.breakDirection ===
    "Bullish";

  const bearishStructureBreak =
    a5.breakDirection ===
    "Bearish";

  const bullishTechnical =
    a5.indicators?.RSI14 >
      50 &&
    a5.indicators?.MACD?.bias ===
      "Bullish";

  const bearishTechnical =
    a5.indicators?.RSI14 <
      50 &&
    a5.indicators?.MACD?.bias ===
      "Bearish";

  const bullishHTF =
    a1.structure.structure !==
    "Bearish Structure";

  const bearishHTF =
    a1.structure.structure !==
    "Bullish Structure";

  const bullish15M =
    a15.structure.structure ===
    "Bullish Structure";

  const bearish15M =
    a15.structure.structure ===
    "Bearish Structure";

  const bullishLiquidity =
    a5.liquidity?.latestSweep ===
    "Bullish Liquidity Sweep";

  const bearishLiquidity =
    a5.liquidity?.latestSweep ===
    "Bearish Liquidity Sweep";

  const bullishCandle =
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
    );

  const bearishCandle =
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
    );

  /* =========================
     BULLISH SCORE
  ========================= */

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
    bullish15M
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
    bullishLiquidity
  ) {
    bullishScore += 2;

    bullishReasons.push(
      "Bullish liquidity sweep"
    );
  }

  if (
    bullishCandle
  ) {
    bullishScore += 1;

    bullishReasons.push(
      "Bullish candle confirmation"
    );
  }

  /* =========================
     BEARISH SCORE
  ========================= */

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
    bearish15M
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
    bearishLiquidity
  ) {
    bearishScore += 2;

    bearishReasons.push(
      "Bearish liquidity sweep"
    );
  }

  if (
    bearishCandle
  ) {
    bearishScore += 1;

    bearishReasons.push(
      "Bearish candle confirmation"
    );
  }

  /* =========================
     A+ STRICT SETUP
  ========================= */

  const bullishAPlus =
    bullishStructureBreak &&
    bullishTechnical &&
    bullishHTF &&
    bullishScore >= 7 &&
    bullishScore >
      bearishScore + 2;

  const bearishAPlus =
    bearishStructureBreak &&
    bearishTechnical &&
    bearishHTF &&
    bearishScore >= 7 &&
    bearishScore >
      bullishScore + 2;

  /* =========================
     A-GRADE INTRADAY SETUP
  ========================= */

  const bullishPriceActionConfirmations =
    Number(
      bullishLiquidity
    ) +
    Number(
      bullishCandle
    ) +
    Number(
      a15.breakDirection ===
      "Bullish"
    );

  const bearishPriceActionConfirmations =
    Number(
      bearishLiquidity
    ) +
    Number(
      bearishCandle
    ) +
    Number(
      a15.breakDirection ===
      "Bearish"
    );

  const bullishA =
    !bullishAPlus &&
    bullishHTF &&
    bullish15M &&
    bullishTechnical &&
    bullishScore >= 6 &&
    bullishScore >
      bearishScore + 2 &&
    bullishPriceActionConfirmations >= 2 &&
    !bearishStructureBreak;

  const bearishA =
    !bearishAPlus &&
    bearishHTF &&
    bearish15M &&
    bearishTechnical &&
    bearishScore >= 6 &&
    bearishScore >
      bullishScore + 2 &&
    bearishPriceActionConfirmations >= 2 &&
    !bullishStructureBreak;

  let status =
    "WAITING";

  let direction =
    "None";

  let confirmationGrade =
    "NONE";

  if (
    bullishAPlus
  ) {
    status =
      "BUY CONFIRMED";

    direction =
      "BUY";

    confirmationGrade =
      "A+";
  } else if (
    bearishAPlus
  ) {
    status =
      "SELL CONFIRMED";

    direction =
      "SELL";

    confirmationGrade =
      "A+";
  } else if (
    bullishA
  ) {
    status =
      "BUY CONFIRMED";

    direction =
      "BUY";

    confirmationGrade =
      "A";

    bullishReasons.push(
      "A-grade intraday confirmation"
    );
  } else if (
    bearishA
  ) {
    status =
      "SELL CONFIRMED";

    direction =
      "SELL";

    confirmationGrade =
      "A";

    bearishReasons.push(
      "A-grade intraday confirmation"
    );
  }

  /* =========================
     WAITING DIAGNOSTIC
  ========================= */

  let rejectionReason =
    "No valid A/A+ setup yet";

  if (
    status ===
    "WAITING"
  ) {
    const reasons =
      [];

    if (
      !bullishStructureBreak &&
      !bearishStructureBreak
    ) {
      reasons.push(
        "5M structure break not confirmed"
      );
    }

    if (
      !bullishTechnical &&
      !bearishTechnical
    ) {
      reasons.push(
        "5M RSI/MACD technical alignment missing"
      );
    }

    if (
      bullishScore <=
        bearishScore + 2 &&
      bearishScore <=
        bullishScore + 2
    ) {
      reasons.push(
        "Bullish/Bearish score difference is too small"
      );
    }

    if (
      bullishPriceActionConfirmations <
        2 &&
      bearishPriceActionConfirmations <
        2
    ) {
      reasons.push(
        "Not enough price-action/liquidity confirmation"
      );
    }

    if (
      retest &&
      retest.priceInBullishZone ===
        false &&
      retest.priceInBearishZone ===
        false
    ) {
      reasons.push(
        "Price is outside current retest zones"
      );
    }

    if (
      reasons.length
    ) {
      rejectionReason =
        reasons.join(
          "; "
        );
    }
  }

  const potentialSetup =
    status ===
      "WAITING" &&
    (
      (
        bullishHTF &&
        bullishTechnical &&
        bullishScore >= 5
      ) ||
      (
        bearishHTF &&
        bearishTechnical &&
        bearishScore >= 5
      )
    );

  return {
    status,

    direction,

    confirmationGrade,

    potentialSetup,

    rejectionReason,

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

    bullishPriceActionConfirmations,

    bearishPriceActionConfirmations,

    retestConfirmed:
      direction ===
        "BUY"
        ? !!retest?.priceInBullishZone
        : direction ===
            "SELL"
          ? !!retest?.priceInBearishZone
          : false
  };
}


/* =========================================================
   COMPACT OPENROUTER AI ANALYSIS
========================================================= */

async function openRouterAnalysis(
  mtf
) {
  if (
    !OPENROUTER_API_KEY
  ) {
    return {
      available:
        false,

      provider:
        "OpenRouter",

      message:
        "OPENROUTER_API_KEY not configured"
    };
  }

  const entry =
    mtf.ENTRY_CONFIRMATION ||
    {};

  const structure =
    mtf.MTF_STRUCTURE ||
    {};

  const confirmation =
    mtf.MTF_CONFIRMATION ||
    {};

  const analysis =
    mtf.analysis ||
    {};

  const a1 =
    analysis["1H"] ||
    {};

  const a15 =
    analysis["15M"] ||
    {};

  const a5 =
    analysis["5M"] ||
    {};

  /*
    Only relevant information is sent to AI.
    The complete MTF object is NOT sent.
  */

  const aiInput = {
    instrument:
      mtf.instrument,

    currentPrice:
      mtf.importantLevels
        ?.currentPrice,

    MTF:
      mtf.MTF,

    structure,

    confirmation,

    entry: {
      status:
        entry.status,

      direction:
        entry.direction,

      grade:
        entry.confirmationGrade,

      bullishScore:
        entry.bullishScore,

      bearishScore:
        entry.bearishScore,

      bullishReasons:
        entry.bullishReasons,

      bearishReasons:
        entry.bearishReasons,

      potentialSetup:
        entry.potentialSetup,

      rejectionReason:
        entry.rejectionReason,

      bullishTechnical:
        entry.bullishTechnical,

      bearishTechnical:
        entry.bearishTechnical,

      bullishHTF:
        entry.bullishHTF,

      bearishHTF:
        entry.bearishHTF,

      bullishStructureBreak:
        entry.bullishStructureBreak,

      bearishStructureBreak:
        entry.bearishStructureBreak
    },

    retest:
      mtf.RETEST,

    invalidation:
      mtf.INVALIDATION,

    importantLevels:
      mtf.importantLevels,

    timeframes: {
      "1H": {
        trend:
          a1.trend,

        structure:
          a1.structure
            ?.structure,

        BOS:
          a1.BOS,

        CHoCH:
          a1.CHoCH,

        MSS:
          a1.MSS,

        RSI14:
          a1.indicators
            ?.RSI14,

        MACD:
          a1.indicators
            ?.MACD
            ?.bias,

        latestSweep:
          a1.liquidity
            ?.latestSweep,

        candle:
          a1.candle
            ?.direction,

        displacement:
          a1.candle
            ?.displacement
      },

      "15M": {
        trend:
          a15.trend,

        structure:
          a15.structure
            ?.structure,

        BOS:
          a15.BOS,

        CHoCH:
          a15.CHoCH,

        MSS:
          a15.MSS,

        RSI14:
          a15.indicators
            ?.RSI14,

        MACD:
          a15.indicators
            ?.MACD
            ?.bias,

        latestSweep:
          a15.liquidity
            ?.latestSweep,

        candle:
          a15.candle
            ?.direction,

        displacement:
          a15.candle
            ?.displacement
      },

      "5M": {
        trend:
          a5.trend,

        structure:
          a5.structure
            ?.structure,

        BOS:
          a5.BOS,

        CHoCH:
          a5.CHoCH,

        MSS:
          a5.MSS,

        RSI14:
          a5.indicators
            ?.RSI14,

        MACD:
          a5.indicators
            ?.MACD
            ?.bias,

        latestSweep:
          a5.liquidity
            ?.latestSweep,

        candle:
          a5.candle
            ?.direction,

        displacement:
          a5.candle
            ?.displacement
      }
    }
  };

  const prompt = `
You are a concise XAUUSD market-analysis assistant.

Use ONLY the supplied technical engine data.

Do NOT invent prices, indicators,
BOS, CHoCH, MSS, liquidity events
or trade signals.

Give a short decision-oriented analysis:

1. MTF bias
2. Market structure
3. BOS / CHoCH / MSS
4. Liquidity and candle confirmation
5. Entry status and confirmation grade
6. If WAITING, state exactly what confirmation is missing
7. Important invalidation and levels

If status is WAITING,
do not create a trade signal.

Do not promise profit.
Do not claim certainty.

Keep the response under 500 words.

DATA:
${JSON.stringify(
  aiInput
)}
`;

  try {
    const response =
      await fetch(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method:
            "POST",

          headers: {
            Authorization:
              `Bearer ${OPENROUTER_API_KEY}`,

            "Content-Type":
              "application/json",

            "HTTP-Referer":
              "https://xau-ai-bot-1.onrender.com",

            "X-Title":
              "XAU AI Strong Market Analysis Engine"
          },

          body:
            JSON.stringify({
              model:
                OPENROUTER_MODEL,

              models: [
                OPENROUTER_MODEL,

                OPENROUTER_FALLBACK_MODEL
              ],

              messages: [
                {
                  role:
                    "user",

                  content:
                    prompt
                }
              ],

              temperature:
                0.1,

              max_tokens:
                750
            })
        }
      );

    const json =
      await response.json();

    if (
      !response.ok
    ) {
      return {
        available:
          false,

        provider:
          "OpenRouter",

        error:
          json.error
            ?.message ||
          "OpenRouter request failed"
      };
    }

    const text =
      json.choices
        ?.[0]
        ?.message
        ?.content ||
      "";

    if (
      !text
    ) {
      return {
        available:
          false,

        provider:
          "OpenRouter",

        error:
          "OpenRouter returned an empty response"
      };
    }

    return {
      available:
        true,

      provider:
        "OpenRouter",

      model:
        json.model ||
        OPENROUTER_MODEL,

      usage:
        json.usage ||
        null,

      text
    };
  } catch (
    error
  ) {
    return {
      available:
        false,

      provider:
        "OpenRouter",

      error:
        error.message
    };
  }
}


/* =========================================================
   GEMINI AI ANALYSIS
========================================================= */

async function geminiAnalysis(
  mtf
) {
  if (
    !GEMINI_API_KEY
  ) {
    return {
      available:
        false,

      provider:
        "Gemini",

      message:
        "GEMINI_API_KEY not configured"
    };
  }

  const compact =
    {
      instrument:
        mtf.instrument,

      MTF:
        mtf.MTF,

      MTF_STRUCTURE:
        mtf.MTF_STRUCTURE,

      MTF_CONFIRMATION:
        mtf.MTF_CONFIRMATION,

      ENTRY_CONFIRMATION:
        mtf.ENTRY_CONFIRMATION,

      RETEST:
        mtf.RETEST,

      INVALIDATION:
        mtf.INVALIDATION,

      importantLevels:
        mtf.importantLevels,

      TRADE_LEVELS:
        mtf.TRADE_LEVELS
    };

  const prompt = `
Analyze the supplied XAUUSD technical engine output.

Use only the supplied data.
Do not invent data.
Do not create a BUY or SELL signal when ENTRY_CONFIRMATION is WAITING.

Return:
- MTF bias
- structure
- BOS/CHoCH/MSS
- liquidity/confirmation
- entry status
- missing confirmation if waiting
- key levels

Be concise.

DATA:
${JSON.stringify(
  compact
)}
`;

  try {
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/` +
      `gemini-2.5-flash:generateContent?key=` +
      `${encodeURIComponent(
        GEMINI_API_KEY
      )}`;

    const response =
      await fetch(
        url,
        {
          method:
            "POST",

          headers: {
            "Content-Type":
              "application/json"
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
              ],

              generationConfig: {
                temperature:
                  0.1,

                maxOutputTokens:
                  700
              }
            })
        }
      );

    const json =
      await response.json();

    if (
      !response.ok
    ) {
      return {
        available:
          false,

        provider:
          "Gemini",

        error:
          json.error
            ?.message ||
          "Gemini request failed"
      };
    }

    const text =
      json.candidates
        ?.[0]
        ?.content
        ?.parts
        ?.map(
          x =>
            x.text ||
            ""
        )
        .join("")
        .trim();

    if (
      !text
    ) {
      return {
        available:
          false,

        provider:
          "Gemini",

        error:
          "Gemini returned an empty response"
      };
    }

    return {
      available:
        true,

      provider:
        "Gemini",

      text
    };
  } catch (
    error
  ) {
    return {
      available:
        false,

      provider:
        "Gemini",

      error:
        error.message
    };
  }
}


/* =========================================================
   AI ANALYSIS SELECTOR
========================================================= */

async function runAIAnalysis(
  mtf
) {
  /*
    OpenRouter is primary.
    Gemini remains a secondary fallback.

    AI failure must NEVER break
    the technical analysis engine.
  */

  const openRouter =
    await openRouterAnalysis(
      mtf
    );

  if (
    openRouter.available
  ) {
    return {
      available:
        true,

      provider:
        openRouter.provider,

      model:
        openRouter.model,

      usage:
        openRouter.usage,

      text:
        openRouter.text,

      fallbackUsed:
        openRouter.model &&
        openRouter.model !==
          OPENROUTER_MODEL
    };
  }

  const gemini =
    await geminiAnalysis(
      mtf
    );

  if (
    gemini.available
  ) {
    return {
      available:
        true,

      provider:
        gemini.provider,

      text:
        gemini.text,

      fallbackUsed:
        true,

      openRouterError:
        openRouter.error ||
        openRouter.message ||
        null
    };
  }

  return {
    available:
      false,

    provider:
      "None",

    text:
      null,

    openRouterError:
      openRouter.error ||
      openRouter.message ||
      null,

    geminiError:
      gemini.error ||
      gemini.message ||
      null
  };
}


/* =========================================================
   FULL MARKET ANALYSIS
========================================================= */

async function buildFullAnalysis() {
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

  const MTF =
    buildMTFDirection(
      a1,
      a15,
      a5
    );

  const MTF_STRUCTURE =
    buildMTFStructure(
      a1,
      a15,
      a5
    );

  const MTF_CONFIRMATION =
    buildMTFConfirmation(
      a1,
      a15,
      a5
    );

  const RETEST =
    buildRetestZones(
      a1,
      a15,
      a5
    );

  const ENTRY_CONFIRMATION =
    entryConfirmation(
      a1,
      a15,
      a5,
      RETEST
    );

  const INVALIDATION =
    buildInvalidation(
      a1,
      a15,
      a5
    );

  const TRADE_LEVELS =
    buildTradeLevels(
      ENTRY_CONFIRMATION,
      a1,
      a15,
      a5
    );

  const importantLevels =
    a5.levels;

  const result = {
    success:
      true,

    instrument:
      OUTPUT_SYMBOL,

    generatedAt:
      new Date().toISOString(),

    MTF,

    MTF_STRUCTURE,

    MTF_CONFIRMATION,

    ENTRY_CONFIRMATION,

    RETEST,

    INVALIDATION,

    importantLevels,

    TRADE_LEVELS,

    analysis: {
      "1H":
        a1,

      "15M":
        a15,

      "5M":
        a5
    }
  };

  /*
    AI analysis is deliberately executed
    AFTER technical analysis is complete.

    Therefore OpenRouter/Gemini failure
    cannot remove or damage the technical result.
  */

  const AI_ANALYSIS =
    await runAIAnalysis(
      result
    );

  result.AI_ANALYSIS =
    AI_ANALYSIS;

  return result;
}


/* =========================================================
   API ROUTES
========================================================= */

app.get(
  "/",
  async (
    req,
    res
  ) => {
    res.json({
      success:
        true,

      service:
        "XAU AI Strong Market Analysis Engine",

      instrument:
        OUTPUT_SYMBOL,

      status:
        "online",

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


app.get(
  "/gold-data",
  async (
    req,
    res
  ) => {
    try {
      const candles =
        await getCandles(
          TF["5M"],
          100
        );

      const current =
        last(candles);

      res.json({
        success:
          true,

        instrument:
          OUTPUT_SYMBOL,

        currentPrice:
          current?.close ??
          null,

        candles:
          candles.length,

        latestCandle:
          current ||
          null
      });
    } catch (
      error
    ) {
      res.status(
        500
      ).json({
        success:
          false,

        error:
          error.message
      });
    }
  }
);


app.get(
  "/technical-analysis",
  async (
    req,
    res
  ) => {
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
        success:
          true,

        instrument:
          OUTPUT_SYMBOL,

        analysis
      });
    } catch (
      error
    ) {
      res.status(
        500
      ).json({
        success:
          false,

        error:
          error.message
      });
    }
  }
);


app.get(
  "/mtf-analysis",
  async (
    req,
    res
  ) => {
    try {
      const result =
        await buildFullAnalysis();

      res.json({
        success:
          result.success,

        instrument:
          result.instrument,

        generatedAt:
          result.generatedAt,

        MTF:
          result.MTF,

        MTF_STRUCTURE:
          result.MTF_STRUCTURE,

        MTF_CONFIRMATION:
          result.MTF_CONFIRMATION,

        ENTRY_CONFIRMATION:
          result.ENTRY_CONFIRMATION,

        RETEST:
          result.RETEST,

        INVALIDATION:
          result.INVALIDATION,

        importantLevels:
          result.importantLevels,

        TRADE_LEVELS:
          result.TRADE_LEVELS,

        AI_ANALYSIS:
          result.AI_ANALYSIS
      });
    } catch (
      error
    ) {
      res.status(
        500
      ).json({
        success:
          false,

        error:
          error.message
      });
    }
  }
);


app.get(
  "/analyze",
  async (
    req,
    res
  ) => {
    try {
      const result =
        await buildFullAnalysis();

      res.json(
        result
      );
    } catch (
      error
    ) {
      res.status(
        500
      ).json({
        success:
          false,

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
  async (
    req,
    res
  ) => {
    try {
      const result =
        await buildFullAnalysis();

      const ai =
        await geminiAnalysis(
          result
        );

      res.json({
        success:
          ai.available,

        telegram:
          false,

        AI_ANALYSIS:
          ai
      });
    } catch (
      error
    ) {
      res.status(
        500
      ).json({
        success:
          false,

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
  async (
    req,
    res
  ) => {
    try {
      const result =
        await buildFullAnalysis();

      const message =
        buildTelegramMessage(
          result
        );

      const telegram =
        await sendTelegramMessage(
          message
        );

      res.json({
        success:
          true,

        telegram
      });
    } catch (
      error
    ) {
      res.status(
        500
      ).json({
        success:
          false,

        error:
          error.message
      });
    }
  }
);


/* =========================================================
   HOURLY TELEGRAM MONITOR
========================================================= */

let lastTelegramStatus =
  null;

let lastTradeAlertKey =
  null;

async function hourlyTelegramCheck() {
  try {
    const result =
      await buildFullAnalysis();

    const entry =
      result.ENTRY_CONFIRMATION ||
      {};

    const tradeKey =
      [
        entry.direction,

        entry.confirmationGrade,

        result.importantLevels
          ?.currentPrice
      ].join(
        "|"
      );

    /*
      Send trade alert only when a
      newly confirmed setup appears.
    */

    if (
      (
        entry.status ===
          "BUY CONFIRMED" ||
        entry.status ===
          "SELL CONFIRMED"
      ) &&
      tradeKey !==
        lastTradeAlertKey
    ) {
      const message =
        buildTelegramMessage(
          result
        );

      const telegram =
        await sendTelegramMessage(
          `🚨 TRADE CONFIRMED\n\n${message}`
        );

      if (
        telegram.sent
      ) {
        lastTradeAlertKey =
          tradeKey;
      }
    }

    /*
      Hourly status.
      WAITING is allowed and will clearly
      show why the engine is waiting.
    */

    const statusKey =
      [
        entry.status,

        entry.direction,

        entry.confirmationGrade,

        entry.bullishScore,

        entry.bearishScore,

        entry.rejectionReason
      ].join(
        "|"
      );

    if (
      statusKey !==
      lastTelegramStatus
    ) {
      const message =
        buildTelegramMessage(
          result
        );

      const telegram =
        await sendTelegramMessage(
          `📊 XAUUSD ENGINE STATUS\n\n${message}`
        );

      if (
        telegram.sent
      ) {
        lastTelegramStatus =
          statusKey;
      }
    }
  } catch (
    error
  ) {
    console.error(
      "Hourly Telegram check error:",
      error.message
    );
  }
}


/* =========================================================
   START SERVER
========================================================= */

app.listen(
  PORT,
  () => {
    console.log(
      `XAU AI BOT running on port ${PORT}`
    );

    console.log(
      `Instrument: ${OUTPUT_SYMBOL}`
    );

    console.log(
      `OpenRouter primary: ${OPENROUTER_MODEL}`
    );

    console.log(
      `OpenRouter fallback: ${OPENROUTER_FALLBACK_MODEL}`
    );

    /*
      First check after startup.
    */

    setTimeout(
      () => {
        hourlyTelegramCheck();
      },
      15000
    );

    /*
      Hourly monitoring.
    */

    setInterval(
      () => {
        hourlyTelegramCheck();
      },
      60 * 60 * 1000
    );
  }
);

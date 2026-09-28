import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;

const SYMBOL = "XAU/USD";

// ======================================================
// BASIC HELPERS
// ======================================================

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round(v, d = 5) {
  return v == null ? null : Number(Number(v).toFixed(d));
}

function avg(arr) {
  const a = arr.filter(Number.isFinite);
  if (!a.length) return null;
  return a.reduce((x, y) => x + y, 0) / a.length;
}

function last(arr) {
  return arr[arr.length - 1];
}

function previous(arr) {
  return arr[arr.length - 2];
}

function safeArray(v) {
  return Array.isArray(v) ? v : [];
}

// ======================================================
// TWELVE DATA
// ======================================================

async function getGoldCandles(interval = "5min", outputsize = 300) {
  if (!TWELVE_DATA_API_KEY) {
    throw new Error("TWELVE_DATA_API_KEY is missing");
  }

  const url =
    `https://api.twelvedata.com/time_series` +
    `?symbol=${encodeURIComponent(SYMBOL)}` +
    `&interval=${interval}` +
    `&outputsize=${outputsize}` +
    `&apikey=${TWELVE_DATA_API_KEY}` +
    `&format=JSON`;

  const response = await fetch(url);
  const data = await response.json();

  if (!response.ok || data.status === "error" || !data.values) {
    throw new Error(
      data.message || `Twelve Data error for ${interval}`
    );
  }

  return data.values
    .map(c => ({
      datetime: c.datetime,
      open: num(c.open),
      high: num(c.high),
      low: num(c.low),
      close: num(c.close),
      volume: num(c.volume)
    }))
    .filter(
      c =>
        c.open != null &&
        c.high != null &&
        c.low != null &&
        c.close != null
    )
    .reverse();
}

// ======================================================
// EMA
// ======================================================

function ema(values, period) {
  if (!values || values.length < period) return null;

  const k = 2 / (period + 1);

  let result = avg(values.slice(0, period));

  for (let i = period; i < values.length; i++) {
    result = values[i] * k + result * (1 - k);
  }

  return result;
}

function emaArray(values, period) {
  if (!values || values.length < period) return [];

  const k = 2 / (period + 1);
  const result = new Array(values.length).fill(null);

  let e = avg(values.slice(0, period));
  result[period - 1] = e;

  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    result[i] = e;
  }

  return result;
}

// ======================================================
// RSI
// ======================================================

function rsi(values, period = 14) {
  if (!values || values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    if (change >= 0) gains += change;
    else losses += Math.abs(change);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);

    avgGain = ((avgGain * (period - 1)) + gain) / period;
    avgLoss = ((avgLoss * (period - 1)) + loss) / period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;

  return 100 - 100 / (1 + rs);
}

// ======================================================
// ATR
// ======================================================

function atr(candles, period = 14) {
  if (!candles || candles.length <= period) return null;

  const trs = [];

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];

    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close)
    );

    trs.push(tr);
  }

  if (trs.length < period) return null;

  let value = avg(trs.slice(0, period));

  for (let i = period; i < trs.length; i++) {
    value = ((value * (period - 1)) + trs[i]) / period;
  }

  return value;
}

// ======================================================
// MACD
// ======================================================

function macd(values) {
  if (!values || values.length < 35) {
    return {
      line: null,
      signal: null,
      histogram: null,
      bias: "Unavailable"
    };
  }

  const ema12 = emaArray(values, 12);
  const ema26 = emaArray(values, 26);

  const macdValues = [];

  for (let i = 0; i < values.length; i++) {
    if (ema12[i] != null && ema26[i] != null) {
      macdValues.push(ema12[i] - ema26[i]);
    }
  }

  if (macdValues.length < 9) {
    return {
      line: null,
      signal: null,
      histogram: null,
      bias: "Unavailable"
    };
  }

  const signal = ema(macdValues, 9);
  const line = last(macdValues);

  const histogram = line - signal;

  return {
    line: round(line),
    signal: round(signal),
    histogram: round(histogram),
    bias:
      histogram > 0
        ? "Bullish"
        : histogram < 0
        ? "Bearish"
        : "Neutral"
  };
}

// ======================================================
// SWINGS
// ======================================================

function detectSwings(candles, left = 2, right = 2) {
  const highs = [];
  const lows = [];

  for (
    let i = left;
    i < candles.length - right;
    i++
  ) {
    let high = true;
    let low = true;

    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;

      if (candles[j].high >= candles[i].high) {
        high = false;
      }

      if (candles[j].low <= candles[i].low) {
        low = false;
      }
    }

    if (high) {
      highs.push({
        index: i,
        price: candles[i].high,
        time: candles[i].datetime
      });
    }

    if (low) {
      lows.push({
        index: i,
        price: candles[i].low,
        time: candles[i].datetime
      });
    }
  }

  return { highs, lows };
}

// ======================================================
// STRUCTURE
// ======================================================

function structureAnalysis(swings) {
  const highs = swings.highs;
  const lows = swings.lows;

  if (highs.length < 2 || lows.length < 2) {
    return {
      structure: "Insufficient Data",
      HH: false,
      HL: false,
      LH: false,
      LL: false
    };
  }

  const h1 = highs[highs.length - 1];
  const h2 = highs[highs.length - 2];

  const l1 = lows[lows.length - 1];
  const l2 = lows[lows.length - 2];

  const HH = h1.price > h2.price;
  const LH = h1.price < h2.price;

  const HL = l1.price > l2.price;
  const LL = l1.price < l2.price;

  let structure = "Mixed Structure";

  if (HH && HL) {
    structure = "Bullish Structure";
  } else if (LH && LL) {
    structure = "Bearish Structure";
  }

  return {
    structure,
    HH,
    HL,
    LH,
    LL,
    latestSwingHigh: h1,
    previousSwingHigh: h2,
    latestSwingLow: l1,
    previousSwingLow: l2
  };
}

// ======================================================
// BOS / CHOCH / MSS
// ======================================================

function structureBreak(candles, swings, structure) {
  const c = last(candles);

  const latestHigh =
    swings.highs.length
      ? last(swings.highs)
      : null;

  const latestLow =
    swings.lows.length
      ? last(swings.lows)
      : null;

  let BOS = "None";
  let CHOCH = "None";
  let MSS = "None";

  if (
    latestLow &&
    c.close < latestLow.price
  ) {
    BOS = "Bearish BOS";

    if (structure.structure === "Bullish Structure") {
      CHOCH = "Bearish CHoCH";
      MSS = "Bearish MSS";
    }
  }

  if (
    latestHigh &&
    c.close > latestHigh.price
  ) {
    BOS = "Bullish BOS";

    if (structure.structure === "Bearish Structure") {
      CHOCH = "Bullish CHoCH";
      MSS = "Bullish MSS";
    }
  }

  return {
    BOS,
    CHOCH,
    MSS,
    brokenLevel:
      BOS === "Bearish BOS"
        ? latestLow?.price
        : BOS === "Bullish BOS"
        ? latestHigh?.price
        : null
  };
}

// ======================================================
// LIQUIDITY / SWEEP
// ======================================================

function clusterLevels(levels, tolerance = 1.5) {
  const sorted = [...levels]
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  const clusters = [];

  for (const price of sorted) {
    const existing = clusters.find(
      c => Math.abs(c.price - price) <= tolerance
    );

    if (existing) {
      existing.count++;
      existing.values.push(price);

      existing.price =
        existing.values.reduce((a, b) => a + b, 0) /
        existing.values.length;
    } else {
      clusters.push({
        price,
        count: 1,
        values: [price]
      });
    }
  }

  return clusters
    .sort((a, b) => b.count - a.count)
    .map(c => ({
      price: round(c.price),
      count: c.count
    }));
}

function liquidityAnalysis(candles) {
  const recent = candles.slice(-80);

  const highs = recent.map(c => c.high);
  const lows = recent.map(c => c.low);

  const equalHighs = clusterLevels(highs, 1.0)
    .filter(x => x.count >= 2)
    .slice(0, 8);

  const equalLows = clusterLevels(lows, 1.0)
    .filter(x => x.count >= 2)
    .slice(0, 8);

  const c = last(candles);
  const prev = previous(candles);

  let sweep = "None";

  if (prev && c) {
    if (
      c.high > prev.high &&
      c.close < prev.high
    ) {
      sweep = "Buy-side Liquidity Sweep";
    }

    if (
      c.low < prev.low &&
      c.close > prev.low
    ) {
      sweep = "Sell-side Liquidity Sweep";
    }
  }

  return {
    equalHighs,
    equalLows,
    latestSweep: sweep
  };
}

// ======================================================
// CANDLESTICK
// ======================================================

function candleAnalysis(c) {
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;

  const upperWick =
    c.high - Math.max(c.open, c.close);

  const lowerWick =
    Math.min(c.open, c.close) - c.low;

  const bodyRatio =
    range > 0 ? body / range : 0;

  let direction = "Neutral";

  if (c.close > c.open) direction = "Bullish";
  if (c.close < c.open) direction = "Bearish";

  let strength = "Weak";

  if (bodyRatio >= 0.65) strength = "Strong";
  else if (bodyRatio >= 0.4) strength = "Moderate";

  const patterns = [];

  if (
    lowerWick > body * 2 &&
    upperWick < body
  ) {
    patterns.push("Hammer");
  }

  if (
    upperWick > body * 2 &&
    lowerWick < body
  ) {
    patterns.push("Shooting Star");
  }

  if (bodyRatio < 0.15) {
    patterns.push("Doji");
  }

  return {
    direction,
    strength,
    body: round(body),
    range: round(range),
    bodyRatio: round(bodyRatio, 3),
    upperWick: round(upperWick),
    lowerWick: round(lowerWick),
    patterns
  };
}

// ======================================================
// DISPLACEMENT
// ======================================================

function displacement(candle, atrValue) {
  if (!candle || !atrValue || atrValue <= 0) {
    return "None";
  }

  const range = candle.high - candle.low;
  const body = Math.abs(candle.close - candle.open);

  const bodyRatio =
    range > 0 ? body / range : 0;

  // Strong displacement only
  if (
    range >= atrValue * 1.2 &&
    bodyRatio >= 0.65
  ) {
    if (candle.close > candle.open) {
      return "Bullish Displacement";
    }

    if (candle.close < candle.open) {
      return "Bearish Displacement";
    }
  }

  return "None";
}

// ======================================================
// FVG
// ======================================================

function findFVG(candles) {
  const bullish = [];
  const bearish = [];

  for (let i = 2; i < candles.length; i++) {
    const a = candles[i - 2];
    const b = candles[i - 1];
    const c = candles[i];

    // Bullish FVG
    if (c.low > a.high) {
      bullish.push({
        low: round(a.high),
        high: round(c.low),
        index: i,
        time: c.datetime
      });
    }

    // Bearish FVG
    if (c.high < a.low) {
      bearish.push({
        low: round(c.high),
        high: round(a.low),
        index: i,
        time: c.datetime
      });
    }
  }

  return {
    bullish: bullish.slice(-8),
    bearish: bearish.slice(-8)
  };
}

// ======================================================
// ORDER BLOCK
// ======================================================

function findOrderBlocks(candles) {
  const bullish = [];
  const bearish = [];

  for (let i = 1; i < candles.length - 1; i++) {
    const prev = candles[i - 1];
    const current = candles[i];
    const next = candles[i + 1];

    // Bullish OB:
    // bearish candle followed by bullish expansion
    if (
      prev.close < prev.open &&
      current.close > current.open &&
      next.close > current.high
    ) {
      bullish.push({
        low: round(prev.low),
        high: round(prev.high),
        index: i - 1,
        time: prev.datetime
      });
    }

    // Bearish OB:
    // bullish candle followed by bearish expansion
    if (
      prev.close > prev.open &&
      current.close < current.open &&
      next.close < current.low
    ) {
      bearish.push({
        low: round(prev.low),
        high: round(prev.high),
        index: i - 1,
        time: prev.datetime
      });
    }
  }

  return {
    bullish: bullish.slice(-8),
    bearish: bearish.slice(-8)
  };
}

// ======================================================
// SUPPLY / DEMAND
// ======================================================

function supplyDemand(candles) {
  const supply = [];
  const demand = [];

  for (let i = 1; i < candles.length - 1; i++) {
    const p = candles[i - 1];
    const c = candles[i];
    const n = candles[i + 1];

    // Demand
    if (
      c.close > c.open &&
      c.close > p.high &&
      c.close > n.close
    ) {
      demand.push({
        low: round(c.low),
        high: round(c.high),
        time: c.datetime
      });
    }

    // Supply
    if (
      c.close < c.open &&
      c.close < p.low &&
      c.close < n.close
    ) {
      supply.push({
        low: round(c.low),
        high: round(c.high),
        time: c.datetime
      });
    }
  }

  return {
    demand: demand.slice(-8),
    supply: supply.slice(-8)
  };
}

// ======================================================
// SUPPORT / RESISTANCE
// ======================================================

function supportResistance(candles, swings) {
  const price = last(candles).close;

  const supports = swings.lows
    .map(x => x.price)
    .filter(x => x < price)
    .sort((a, b) => b - a);

  const resistances = swings.highs
    .map(x => x.price)
    .filter(x => x > price)
    .sort((a, b) => a - b);

  return {
    currentPrice: round(price),

    support:
      supports.length
        ? round(supports[0])
        : null,

    nextSupport:
      supports.length > 1
        ? round(supports[1])
        : null,

    resistance:
      resistances.length
        ? round(resistances[0])
        : null,

    nextResistance:
      resistances.length > 1
        ? round(resistances[1])
        : null
  };
}

// ======================================================
// VOLUME
// ======================================================

function volumeAnalysis(candles) {
  const volumes = candles
    .map(c => c.volume)
    .filter(v => v != null);

  if (volumes.length < 20) {
    return {
      available: false,
      message: "Volume unavailable from data source"
    };
  }

  const current = last(volumes);

  const average =
    avg(volumes.slice(-20));

  return {
    available: true,
    current: round(current),
    average20: round(average),
    ratio:
      average
        ? round(current / average, 2)
        : null,
    condition:
      current > average * 1.5
        ? "High Volume"
        : current < average * 0.7
        ? "Low Volume"
        : "Normal Volume"
  };
}

// ======================================================
// TIMEFRAME ANALYSIS
// ======================================================

function analyzeTimeframe(candles, timeframe) {
  if (!candles || candles.length < 80) {
    throw new Error(
      `${timeframe}: insufficient candle data`
    );
  }

  // Last candle = closed candle from API
  // We keep it as confirmed data.
  const currentClosedCandle = last(candles);

  // Separate a live/next context only when API provides it.
  const formingCandle = candles.length >= 2
    ? {
        ...last(candles),
        note: "Latest candle returned by data source"
      }
    : null;

  const closes = candles.map(c => c.close);

  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);

  const RSI = rsi(closes, 14);
  const ATR = atr(candles, 14);
  const MACD = macd(closes);

  const swings = detectSwings(candles);
  const structure = structureAnalysis(swings);
  const breaks = structureBreak(
    candles,
    swings,
    structure
  );

  const liquidity = liquidityAnalysis(candles);
  const candle = candleAnalysis(
    currentClosedCandle
  );

  const displacementResult =
    displacement(
      currentClosedCandle,
      ATR
    );

  const fvg = findFVG(candles);
  const orderBlocks =
    findOrderBlocks(candles);

  const zones =
    supplyDemand(candles);

  const levels =
    supportResistance(
      candles,
      swings
    );

  const volume =
    volumeAnalysis(candles);

  let trend = "Neutral";

  if (
    ema9 != null &&
    ema21 != null &&
    ema50 != null
  ) {
    if (
      ema9 > ema21 &&
      ema21 > ema50
    ) {
      trend = "Strong Bullish";
    } else if (
      ema9 < ema21 &&
      ema21 < ema50
    ) {
      trend = "Strong Bearish";
    } else if (
      ema9 > ema21
    ) {
      trend = "Bullish";
    } else if (
      ema9 < ema21
    ) {
      trend = "Bearish";
    }
  }

  let momentum = "Neutral";

  if (RSI != null) {
    if (RSI >= 70) {
      momentum = "Overbought";
    } else if (RSI <= 30) {
      momentum = "Oversold";
    } else if (RSI > 50) {
      momentum = "Bullish Momentum";
    } else if (RSI < 50) {
      momentum = "Bearish Momentum";
    }
  }

  // ====================================================
  // SMC SCORE
  // ====================================================

  let bullishScore = 0;
  let bearishScore = 0;

  if (
    structure.structure === "Bullish Structure"
  ) {
    bullishScore++;
  }

  if (
    structure.structure === "Bearish Structure"
  ) {
    bearishScore++;
  }

  if (
    breaks.BOS === "Bullish BOS" ||
    breaks.CHOCH === "Bullish CHoCH"
  ) {
    bullishScore += 2;
  }

  if (
    breaks.BOS === "Bearish BOS" ||
    breaks.CHOCH === "Bearish CHoCH"
  ) {
    bearishScore += 2;
  }

  if (
    liquidity.latestSweep ===
    "Sell-side Liquidity Sweep"
  ) {
    bullishScore++;
  }

  if (
    liquidity.latestSweep ===
    "Buy-side Liquidity Sweep"
  ) {
    bearishScore++;
  }

  if (
    displacementResult ===
    "Bullish Displacement"
  ) {
    bullishScore++;
  }

  if (
    displacementResult ===
    "Bearish Displacement"
  ) {
    bearishScore++;
  }

  return {
    timeframe,

    currentClosedCandle: {
      time: currentClosedCandle.datetime,
      open: round(currentClosedCandle.open),
      high: round(currentClosedCandle.high),
      low: round(currentClosedCandle.low),
      close: round(currentClosedCandle.close)
    },

    formingCandle,

    structure,

    BOS: breaks.BOS,
    CHoCH: breaks.CHOCH,
    MSS: breaks.MSS,
    brokenLevel: round(breaks.brokenLevel),

    liquidity,

    candle,

    displacement: displacementResult,

    indicators: {
      EMA9: round(ema9),
      EMA21: round(ema21),
      EMA50: round(ema50),
      RSI14: round(RSI, 2),
      ATR14: round(ATR),
      MACD
    },

    trend,
    momentum,

    supportResistance: levels,

    FVG: fvg,

    orderBlocks,

    supplyDemand: zones,

    volume,

    SMC: {
      bullishScore,
      bearishScore
    }
  };
}

// ======================================================
// MTF ANALYSIS
// ======================================================

function mtfAnalysis(tf1H, tf15M, tf5M) {
  const oneH = tf1H;
  const fifteen = tf15M;
  const five = tf5M;

  // ----------------------------------------------------
  // HTF TREND
  // ----------------------------------------------------

  const oneHBull =
    oneH.trend.includes("Bullish") &&
    oneH.structure.structure ===
      "Bullish Structure";

  const oneHBear =
    oneH.trend.includes("Bearish") &&
    oneH.structure.structure ===
      "Bearish Structure";

  const fifteenBull =
    fifteen.trend.includes("Bullish") &&
    fifteen.structure.structure ===
      "Bullish Structure";

  const fifteenBear =
    fifteen.trend.includes("Bearish") &&
    fifteen.structure.structure ===
      "Bearish Structure";

  let structureBias = "Neutral";

  if (oneHBear && fifteenBear) {
    structureBias = "Bearish";
  } else if (oneHBull && fifteenBull) {
    structureBias = "Bullish";
  } else if (
    oneHBear ||
    fifteenBear
  ) {
    structureBias = "Bearish";
  } else if (
    oneHBull ||
    fifteenBull
  ) {
    structureBias = "Bullish";
  }

  // ----------------------------------------------------
  // MTF TREND
  // ----------------------------------------------------

  let mtfTrend = "Mixed";

  if (
    oneH.trend.includes("Bearish") &&
    fifteen.trend.includes("Bearish") &&
    five.trend.includes("Bearish")
  ) {
    mtfTrend = "Strong Bearish";
  } else if (
    oneH.trend.includes("Bullish") &&
    fifteen.trend.includes("Bullish") &&
    five.trend.includes("Bullish")
  ) {
    mtfTrend = "Strong Bullish";
  } else if (
    structureBias === "Bearish"
  ) {
    mtfTrend = "Bearish";
  } else if (
    structureBias === "Bullish"
  ) {
    mtfTrend = "Bullish";
  }

  // ----------------------------------------------------
  // HTF BOS
  // ----------------------------------------------------

  const htfBearBOS =
    oneH.BOS === "Bearish BOS" ||
    fifteen.BOS === "Bearish BOS";

  const htfBullBOS =
    oneH.BOS === "Bullish BOS" ||
    fifteen.BOS === "Bullish BOS";

  const ltfBearBOS =
    five.BOS === "Bearish BOS";

  const ltfBullBOS =
    five.BOS === "Bullish BOS";

  // ----------------------------------------------------
  // 5M CONFIRMATION COMPONENTS
  // ----------------------------------------------------

  const fiveBearStructure =
    five.structure.structure ===
    "Bearish Structure";

  const fiveBullStructure =
    five.structure.structure ===
    "Bullish Structure";

  const fiveBearEMA =
    five.indicators.EMA9 != null &&
    five.indicators.EMA21 != null &&
    five.indicators.EMA50 != null &&
    five.indicators.EMA9 <
      five.indicators.EMA21 &&
    five.indicators.EMA21 <
      five.indicators.EMA50;

  const fiveBullEMA =
    five.indicators.EMA9 != null &&
    five.indicators.EMA21 != null &&
    five.indicators.EMA50 != null &&
    five.indicators.EMA9 >
      five.indicators.EMA21 &&
    five.indicators.EMA21 >
      five.indicators.EMA50;

  const fiveBearRSI =
    five.indicators.RSI14 != null &&
    five.indicators.RSI14 < 50;

  const fiveBullRSI =
    five.indicators.RSI14 != null &&
    five.indicators.RSI14 > 50;

  const fiveBearMACD =
    five.indicators.MACD.bias === "Bearish";

  const fiveBullMACD =
    five.indicators.MACD.bias === "Bullish";

  const bearishSweep =
    five.liquidity.latestSweep ===
    "Buy-side Liquidity Sweep";

  const bullishSweep =
    five.liquidity.latestSweep ===
    "Sell-side Liquidity Sweep";

  const bearishDisplacement =
    five.displacement ===
    "Bearish Displacement";

  const bullishDisplacement =
    five.displacement ===
    "Bullish Displacement";

  const bearishCHoCH =
    five.CHოCH === "Bearish CHoCH";

  // ----------------------------------------------------
  // FIXED TYPO-SAFE CHOCH CHECK
  // ----------------------------------------------------

  const bearChoch =
    five.CHoCH === "Bearish CHoCH";

  const bullChoch =
    five.CHoCH === "Bullish CHoCH";

  // ----------------------------------------------------
  // BEARISH SCORE
  // ----------------------------------------------------

  let bearishEntryScore = 0;
  const bearishReasons = [];

  if (structureBias === "Bearish") {
    bearishEntryScore++;
    bearishReasons.push(
      "1H/15M structure bias bearish"
    );
  }

  if (fiveBearStructure) {
    bearishEntryScore++;
    bearishReasons.push(
      "5M bearish structure"
    );
  }

  if (fiveBearEMA) {
    bearishEntryScore++;
    bearishReasons.push(
      "5M EMA9 < EMA21 < EMA50"
    );
  }

  if (fiveBearRSI) {
    bearishEntryScore++;
    bearishReasons.push(
      "5M RSI below 50"
    );
  }

  if (fiveBearMACD) {
    bearishEntryScore++;
    bearishReasons.push(
      "5M MACD bearish"
    );
  }

  if (ltfBearBOS) {
    bearishEntryScore += 2;
    bearishReasons.push(
      "5M bearish BOS confirmed"
    );
  }

  if (bearChoch) {
    bearishEntryScore += 2;
    bearishReasons.push(
      "5M bearish CHoCH"
    );
  }

  if (bearishSweep) {
    bearishEntryScore++;
    bearishReasons.push(
      "Buy-side liquidity swept"
    );
  }

  if (bearishDisplacement) {
    bearishEntryScore++;
    bearishReasons.push(
      "Bearish displacement"
    );
  }

  if (htfBearBOS) {
    bearishEntryScore++;
    bearishReasons.push(
      "HTF bearish BOS"
    );
  }

  // ----------------------------------------------------
  // BULLISH SCORE
  // ----------------------------------------------------

  let bullishEntryScore = 0;
  const bullishReasons = [];

  if (structureBias === "Bullish") {
    bullishEntryScore++;
    bullishReasons.push(
      "1H/15M structure bias bullish"
    );
  }

  if (fiveBullStructure) {
    bullishEntryScore++;
    bullishReasons.push(
      "5M bullish structure"
    );
  }

  if (fiveBullEMA) {
    bullishEntryScore++;
    bullishReasons.push(
      "5M EMA9 > EMA21 > EMA50"
    );
  }

  if (fiveBullRSI) {
    bullishEntryScore++;
    bullishReasons.push(
      "5M RSI above 50"
    );
  }

  if (fiveBullMACD) {
    bullishEntryScore++;
    bullishReasons.push(
      "5M MACD bullish"
    );
  }

  if (ltfBullBOS) {
    bullishEntryScore += 2;
    bullishReasons.push(
      "5M bullish BOS confirmed"
    );
  }

  if (bullChoch) {
    bullishEntryScore += 2;
    bullishReasons.push(
      "5M bullish CHoCH"
    );
  }

  if (bullishSweep) {
    bullishEntryScore++;
    bullishReasons.push(
      "Sell-side liquidity swept"
    );
  }

  if (bullishDisplacement) {
    bullishEntryScore++;
    bullishReasons.push(
      "Bullish displacement"
    );
  }

  if (htfBullBOS) {
    bullishEntryScore++;
    bullishReasons.push(
      "HTF bullish BOS"
    );
  }

  // ----------------------------------------------------
  // ENTRY CONFIRMATION
  // ----------------------------------------------------

  let entryStatus = "Waiting";
  let entryDirection = "None";
  let entryReason = [];

  /*
   * Strong confirmation:
   *
   * 1H/15M bias
   * +
   * 5M BOS/CHoCH
   * +
   * at least one technical confirmation
   */

  const bearishStructureBreak =
    ltfBearBOS || bearChoch;

  const bullishStructureBreak =
    ltfBullBOS || bullChoch;

  if (
    structureBias === "Bearish" &&
    bearishStructureBreak &&
    (
      fiveBearEMA ||
      fiveBearRSI ||
      fiveBearMACD ||
      bearishSweep ||
      bearishDisplacement
    )
  ) {
    entryStatus = "Confirmed";
    entryDirection = "SELL";
    entryReason = bearishReasons;
  }

  if (
    structureBias === "Bullish" &&
    bullishStructureBreak &&
    (
      fiveBullEMA ||
      fiveBullRSI ||
      fiveBullMACD ||
      bullishSweep ||
      bullishDisplacement
    )
  ) {
    entryStatus = "Confirmed";
    entryDirection = "BUY";
    entryReason = bullishReasons;
  }

  // ----------------------------------------------------
  // INVALID CONDITIONS
  // ----------------------------------------------------

  const invalidation = {
    SELL:
      five.supportResistance.resistance ||
      fifteen.supportResistance.resistance ||
      null,

    BUY:
      five.supportResistance.support ||
      fifteen.supportResistance.support ||
      null
  };

  // ----------------------------------------------------
  // IMPORTANT LEVELS
  // ----------------------------------------------------

  const currentPrice =
    five.supportResistance.currentPrice;

  const supports = [
    five.supportResistance.support,
    five.supportResistance.nextSupport,
    fifteen.supportResistance.support,
    oneH.supportResistance.support
  ]
    .filter(v => v != null && v < currentPrice)
    .sort((a, b) => b - a);

  const resistances = [
    five.supportResistance.resistance,
    five.supportResistance.nextResistance,
    fifteen.supportResistance.resistance,
    fifteen.supportResistance.nextResistance,
    oneH.supportResistance.resistance,
    oneH.supportResistance.nextResistance
  ]
    .filter(v => v != null && v > currentPrice)
    .sort((a, b) => a - b);

  return {
    trend: mtfTrend,

    alignment:
      mtfTrend === "Strong Bullish"
        ? "Bullish MTF Alignment"
        : mtfTrend === "Strong Bearish"
        ? "Bearish MTF Alignment"
        : "Mixed MTF Alignment",

    structureBias,

    HTF_CONFIRMATION: {
      HTF_BOS:
        htfBearBOS
          ? "Bearish BOS"
          : htfBullBOS
          ? "Bullish BOS"
          : "None",

      LTF_BOS:
        ltfBearBOS
          ? "Bearish BOS"
          : ltfBullBOS
          ? "Bullish BOS"
          : "None"
    },

    ENTRY_CONFIRMATION: {
      status: entryStatus,
      direction: entryDirection,

      bearishScore: bearishEntryScore,
      bullishScore: bullishEntryScore,

      bearishReasons,
      bullishReasons,

      entryReason,

      confirmationRules: {
        HTFAlignmentRequired: true,
        LTFStructureBreakRequired: true,
        TechnicalConfirmationRequired: true
      }
    },

    INVALIDATION: invalidation,

    IMPORTANT_LEVELS: {
      currentPrice: round(currentPrice),

      support:
        supports.length
          ? round(supports[0])
          : null,

      nextSupport:
        supports.length > 1
          ? round(supports[1])
          : null,

      resistance:
        resistances.length
          ? round(resistances[0])
          : null,

      nextResistance:
        resistances.length > 1
          ? round(resistances[1])
          : null
    }
  };
}

// ======================================================
// HOME
// ======================================================

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "XAU AI BOT IS ONLINE",
    instrument: "XAUUSD",
    endpoints: [
      "/gold-data",
      "/technical-analysis",
      "/mtf-analysis",
      "/gemini-test",
      "/analyze"
    ]
  });
});

// ======================================================
// GOLD DATA
// ======================================================

app.get("/gold-data", async (req, res) => {
  try {
    const candles =
      await getGoldCandles("5min", 100);

    res.json({
      success: true,
      instrument: "XAUUSD",
      interval: "5min",
      candles
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ======================================================
// TECHNICAL ANALYSIS
// ======================================================

app.get("/technical-analysis", async (req, res) => {
  try {
    const candles =
      await getGoldCandles("5min", 300);

    const analysis =
      analyzeTimeframe(
        candles,
        "5M"
      );

    res.json({
      success: true,
      instrument: "XAUUSD",
      analysis
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ======================================================
// MTF ANALYSIS
// ======================================================

app.get("/mtf-analysis", async (req, res) => {
  try {
    const [
      candles1H,
      candles15M,
      candles5M
    ] = await Promise.all([
      getGoldCandles("1h", 300),
      getGoldCandles("15min", 300),
      getGoldCandles("5min", 300)
    ]);

    const analysis1H =
      analyzeTimeframe(
        candles1H,
        "1H"
      );

    const analysis15M =
      analyzeTimeframe(
        candles15M,
        "15M"
      );

    const analysis5M =
      analyzeTimeframe(
        candles5M,
        "5M"
      );

    const mtf =
      mtfAnalysis(
        analysis1H,
        analysis15M,
        analysis5M
      );

    res.json({
      success: true,

      instrument: "XAUUSD",

      MTF: {
        "1H": analysis1H.trend,
        "15M": analysis15M.trend,
        "5M": analysis5M.trend,
        alignment: mtf.alignment
      },

      MTF_STRUCTURE: {
        "1H":
          analysis1H.structure.structure,

        "15M":
          analysis15M.structure.structure,

        "5M":
          analysis5M.structure.structure,

        structureBias:
          mtf.structureBias
      },

      MTF_CONFIRMATION:
        mtf.HTF_CONFIRMATION,

      ENTRY_CONFIRMATION:
        mtf.ENTRY_CONFIRMATION,

      INVALIDATION:
        mtf.INVALIDATION,

      importantLevels:
        mtf.IMPORTANT_LEVELS,

      timeframes: {
        "1H": analysis1H,
        "15M": analysis15M,
        "5M": analysis5M
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ======================================================
// GEMINI TEST
// ======================================================

app.get("/gemini-test", async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({
        success: false,
        error: "GEMINI_API_KEY is missing"
      });
    }

    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=" +
        encodeURIComponent(GEMINI_API_KEY),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text:
                    "Reply with exactly: XAU AI GEMINI ONLINE"
                }
              ]
            }
          ]
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        success: false,
        error: data
      });
    }

    res.json({
      success: true,
      gemini: data
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ======================================================
// AI ANALYSIS
// ======================================================

app.get("/analyze", async (req, res) => {
  try {
    const [
      candles1H,
      candles15M,
      candles5M
    ] = await Promise.all([
      getGoldCandles("1h", 250),
      getGoldCandles("15min", 250),
      getGoldCandles("5min", 250)
    ]);

    const oneH =
      analyzeTimeframe(
        candles1H,
        "1H"
      );

    const fifteen =
      analyzeTimeframe(
        candles15M,
        "15M"
      );

    const five =
      analyzeTimeframe(
        candles5M,
        "5M"
      );

    const mtf =
      mtfAnalysis(
        oneH,
        fifteen,
        five
      );

    // --------------------------------------------------
    // LOCAL ANALYSIS
    // --------------------------------------------------

    const localAnalysis = {
      instrument: "XAUUSD",

      currentPrice:
        five.supportResistance.currentPrice,

      marketBias:
        mtf.trend,

      structureBias:
        mtf.structureBias,

      entryConfirmation:
        mtf.ENTRY_CONFIRMATION,

      importantLevels:
        mtf.IMPORTANT_LEVELS,

      invalidation:
        mtf.INVALIDATION,

      summary: {
        "1H": {
          trend: oneH.trend,
          structure:
            oneH.structure.structure,
          BOS: oneH.BOS,
          RSI:
            oneH.indicators.RSI14,
          MACD:
            oneH.indicators.MACD.bias
        },

        "15M": {
          trend: fifteen.trend,
          structure:
            fifteen.structure.structure,
          BOS: fifteen.BOS,
          RSI:
            fifteen.indicators.RSI14,
          MACD:
            fifteen.indicators.MACD.bias
        },

        "5M": {
          trend: five.trend,
          structure:
            five.structure.structure,
          BOS: five.BOS,
          CHoCH: five.CHoCH,
          RSI:
            five.indicators.RSI14,
          MACD:
            five.indicators.MACD.bias,
          displacement:
            five.displacement
        }
      }
    };

    // --------------------------------------------------
    // GEMINI OPTIONAL
    // --------------------------------------------------

    if (!GEMINI_API_KEY) {
      return res.json({
        success: true,
        aiAvailable: false,
        message:
          "Gemini unavailable. Local technical engine is active.",
        analysis: localAnalysis
      });
    }

    const prompt = `
You are an XAUUSD market analysis assistant.

Analyze the following technical data.

Do NOT invent data.

Explain:
1. 1H trend and structure
2. 15M trend and structure
3. 5M trend and structure
4. BOS / CHoCH / MSS
5. Liquidity
6. FVG
7. Order blocks
8. EMA
9. RSI
10. MACD
11. MTF alignment
12. Entry confirmation status
13. Invalidation level
14. Important support/resistance

If entry is not confirmed, clearly say WAITING.
Do not treat a forming candle as confirmed structure.

DATA:

${JSON.stringify(
  {
    oneH,
    fifteen,
    five,
    mtf
  },
  null,
  2
)}
`;

    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=" +
        encodeURIComponent(GEMINI_API_KEY),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: prompt
                }
              ]
            }
          ]
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.json({
        success: true,
        aiAvailable: false,
        geminiError: data,
        analysis: localAnalysis
      });
    }

    const aiText =
      data?.candidates?.[0]?.content?.parts
        ?.map(p => p.text)
        .filter(Boolean)
        .join("\n") || null;

    res.json({
      success: true,
      aiAvailable: true,

      localAnalysis,

      AI_ANALYSIS: aiText
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ======================================================
// SERVER
// ======================================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `XAU AI BOT running on port ${PORT}`
  );
});

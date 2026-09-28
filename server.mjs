import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const SYMBOL = "XAU/USD";
const OUTPUT_SYMBOL = "XAUUSD";

const TF = {
  "5M": "5min",
  "15M": "15min",
  "1H": "1h"
};

// ============================================================
// BASIC HELPERS
// ============================================================

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round(v, d = 2) {
  if (!Number.isFinite(v)) return null;
  return Number(v.toFixed(d));
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function avg(arr) {
  const a = arr.filter(Number.isFinite);
  if (!a.length) return null;
  return a.reduce((s, x) => s + x, 0) / a.length;
}

function last(arr) {
  return arr[arr.length - 1];
}

function previous(arr) {
  return arr[arr.length - 2];
}

function distance(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Infinity;
  return Math.abs(a - b);
}

function pctDistance(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) {
    return Infinity;
  }
  return Math.abs(a - b) / Math.abs(b);
}

// ============================================================
// TWELVE DATA
// ============================================================

async function getCandles(interval, outputsize = 350) {
  if (!TWELVE_DATA_API_KEY) {
    throw new Error("TWELVE_DATA_API_KEY is missing");
  }

  const url =
    `https://api.twelvedata.com/time_series` +
    `?symbol=${encodeURIComponent(SYMBOL)}` +
    `&interval=${encodeURIComponent(interval)}` +
    `&outputsize=${outputsize}` +
    `&apikey=${encodeURIComponent(TWELVE_DATA_API_KEY)}`;

  const response = await fetch(url);
  const data = await response.json();

  if (!response.ok || data.status === "error" || !data.values) {
    throw new Error(
      data.message || `Twelve Data error for ${interval}`
    );
  }

  const candles = data.values
    .map(x => ({
      time: x.datetime,
      open: num(x.open),
      high: num(x.high),
      low: num(x.low),
      close: num(x.close),
      volume: num(x.volume)
    }))
    .filter(x =>
      Number.isFinite(x.open) &&
      Number.isFinite(x.high) &&
      Number.isFinite(x.low) &&
      Number.isFinite(x.close)
    )
    .reverse();

  return candles;
}

// ============================================================
// INDICATORS
// ============================================================

function ema(values, period) {
  if (values.length < period) return [];

  const result = [];
  const multiplier = 2 / (period + 1);

  let prev = avg(values.slice(0, period));

  for (let i = 0; i < period - 1; i++) {
    result.push(null);
  }

  result.push(prev);

  for (let i = period; i < values.length; i++) {
    prev =
      (values[i] - prev) * multiplier +
      prev;

    result.push(prev);
  }

  return result;
}

function rsi(values, period = 14) {
  if (values.length <= period) return [];

  const result = new Array(values.length).fill(null);

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    if (change >= 0) gain += change;
    else loss += Math.abs(change);
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;

  function calc() {
    if (avgLoss === 0) return 100;

    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  result[period] = calc();

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    const currentGain = change > 0 ? change : 0;
    const currentLoss = change < 0 ? Math.abs(change) : 0;

    avgGain =
      ((avgGain * (period - 1)) + currentGain) / period;

    avgLoss =
      ((avgLoss * (period - 1)) + currentLoss) / period;

    result[i] = calc();
  }

  return result;
}

function atr(candles, period = 14) {
  if (candles.length <= period) return [];

  const tr = [];

  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      tr.push(candles[i].high - candles[i].low);
      continue;
    }

    const prevClose = candles[i - 1].close;

    tr.push(
      Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - prevClose),
        Math.abs(candles[i].low - prevClose)
      )
    );
  }

  const result = new Array(candles.length).fill(null);

  let value = avg(tr.slice(0, period));

  result[period - 1] = value;

  for (let i = period; i < tr.length; i++) {
    value =
      ((value * (period - 1)) + tr[i]) / period;

    result[i] = value;
  }

  return result;
}

function macd(values) {
  const e12 = ema(values, 12);
  const e26 = ema(values, 26);

  const line = values.map((_, i) => {
    if (
      !Number.isFinite(e12[i]) ||
      !Number.isFinite(e26[i])
    ) return null;

    return e12[i] - e26[i];
  });

  const valid = line.filter(Number.isFinite);
  const signalRaw = ema(valid, 9);

  const signal = new Array(values.length).fill(null);

  let j = 0;

  for (let i = 0; i < line.length; i++) {
    if (Number.isFinite(line[i])) {
      signal[i] = signalRaw[j] ?? null;
      j++;
    }
  }

  const histogram = line.map((x, i) => {
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(signal[i])
    ) return null;

    return x - signal[i];
  });

  return {
    line,
    signal,
    histogram
  };
}

// ============================================================
// SWINGS
// ============================================================

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

    for (let j = 1; j <= left; j++) {
      if (candles[i].high <= candles[i - j].high) {
        high = false;
      }

      if (candles[i].low >= candles[i - j].low) {
        low = false;
      }
    }

    for (let j = 1; j <= right; j++) {
      if (candles[i].high < candles[i + j].high) {
        high = false;
      }

      if (candles[i].low > candles[i + j].low) {
        low = false;
      }
    }

    if (high) {
      highs.push({
        index: i,
        price: candles[i].high,
        time: candles[i].time
      });
    }

    if (low) {
      lows.push({
        index: i,
        price: candles[i].low,
        time: candles[i].time
      });
    }
  }

  return { highs, lows };
}

// ============================================================
// STRUCTURE ENGINE
// ============================================================

function structureAnalysis(candles) {
  const swings = detectSwings(candles);

  const highs = swings.highs;
  const lows = swings.lows;

  const latestHigh = last(highs);
  const previousHigh = highs.length > 1
    ? highs[highs.length - 2]
    : null;

  const latestLow = last(lows);
  const previousLow = lows.length > 1
    ? lows[lows.length - 2]
    : null;

  const HH =
    !!latestHigh &&
    !!previousHigh &&
    latestHigh.price > previousHigh.price;

  const LH =
    !!latestHigh &&
    !!previousHigh &&
    latestHigh.price < previousHigh.price;

  const HL =
    !!latestLow &&
    !!previousLow &&
    latestLow.price > previousLow.price;

  const LL =
    !!latestLow &&
    !!previousLow &&
    latestLow.price < previousLow.price;

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
    latestSwingHigh: latestHigh || null,
    previousSwingHigh: previousHigh || null,
    latestSwingLow: latestLow || null,
    previousSwingLow: previousLow || null,
    highs,
    lows
  };
}

// ============================================================
// STATE-BASED BOS / CHOCH / MSS
// ============================================================

function structureBreakAnalysis(candles, structure) {
  const current = last(candles);

  let BOS = "None";
  let CHoCH = "None";
  let MSS = "None";
  let brokenLevel = null;

  const bullishBreak =
    structure.latestSwingHigh &&
    current.close > structure.latestSwingHigh.price;

  const bearishBreak =
    structure.latestSwingLow &&
    current.close < structure.latestSwingLow.price;

  if (bullishBreak) {
    brokenLevel = structure.latestSwingHigh.price;

    if (structure.structure === "Bearish Structure") {
      CHoCH = "Bullish CHoCH";
      MSS = "Bullish MSS";
    } else {
      BOS = "Bullish BOS";
    }
  }

  if (bearishBreak) {
    brokenLevel = structure.latestSwingLow.price;

    if (structure.structure === "Bullish Structure") {
      CHoCH = "Bearish CHoCH";
      MSS = "Bearish MSS";
    } else {
      BOS = "Bearish BOS";
    }
  }

  return {
    BOS,
    CHoCH,
    MSS,
    brokenLevel
  };
}

// ============================================================
// CANDLE ANALYSIS
// ============================================================

function candleAnalysis(candles, atrValue) {
  const c = last(candles);

  const range = c.high - c.low;
  const body = Math.abs(c.close - c.open);

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

  if (bodyRatio >= 0.70) strength = "Strong";
  else if (bodyRatio >= 0.45) strength = "Moderate";

  const patterns = [];

  // Doji
  if (bodyRatio <= 0.10) {
    patterns.push("Doji");
  }

  // Bullish engulfing
  if (candles.length >= 2) {
    const p = candles[candles.length - 2];

    if (
      p.close < p.open &&
      c.close > c.open &&
      c.open <= p.close &&
      c.close >= p.open
    ) {
      patterns.push("Bullish Engulfing");
    }

    if (
      p.close > p.open &&
      c.close < c.open &&
      c.open >= p.close &&
      c.close <= p.open
    ) {
      patterns.push("Bearish Engulfing");
    }
  }

  if (
    lowerWick > body * 2 &&
    upperWick < body
  ) {
    patterns.push(
      direction === "Bullish"
        ? "Bullish Rejection"
        : "Hammer-like Rejection"
    );
  }

  if (
    upperWick > body * 2 &&
    lowerWick < body
  ) {
    patterns.push(
      direction === "Bearish"
        ? "Bearish Rejection"
        : "Shooting-Star-like Rejection"
    );
  }

  const displacement =
    Number.isFinite(atrValue) &&
    range >= atrValue * 1.2 &&
    bodyRatio >= 0.65;

  return {
    direction,
    strength,
    body: round(body, 5),
    range: round(range, 5),
    bodyRatio: round(bodyRatio, 3),
    upperWick: round(upperWick, 5),
    lowerWick: round(lowerWick, 5),
    patterns,
    displacement: displacement
      ? direction === "Bullish"
        ? "Bullish Displacement"
        : "Bearish Displacement"
      : "None"
  };
}

// ============================================================
// LIQUIDITY
// ============================================================

function clusterLevels(values, tolerance) {
  const clusters = [];

  for (const value of values) {
    let found = null;

    for (const c of clusters) {
      if (Math.abs(c.price - value) <= tolerance) {
        found = c;
        break;
      }
    }

    if (found) {
      found.values.push(value);

      found.price =
        found.values.reduce((a, b) => a + b, 0) /
        found.values.length;

      found.count++;
    } else {
      clusters.push({
        price: value,
        count: 1,
        values: [value]
      });
    }
  }

  return clusters
    .filter(x => x.count >= 3)
    .sort((a, b) => b.count - a.count)
    .map(x => ({
      price: round(x.price, 5),
      count: x.count
    }))
    .slice(0, 10);
}

function liquidityAnalysis(candles, atrValue) {
  const tolerance =
    Number.isFinite(atrValue)
      ? atrValue * 0.10
      : 0.5;

  const highs = candles.map(x => x.high);
  const lows = candles.map(x => x.low);

  const equalHighs =
    clusterLevels(highs, tolerance);

  const equalLows =
    clusterLevels(lows, tolerance);

  const current = last(candles);

  let latestSweep = "None";

  // Check last few candles for sweep
  for (
    let i = Math.max(2, candles.length - 5);
    i < candles.length;
    i++
  ) {
    const c = candles[i];

    const priorHighs = candles
      .slice(Math.max(0, i - 20), i)
      .map(x => x.high);

    const priorLows = candles
      .slice(Math.max(0, i - 20), i)
      .map(x => x.low);

    const maxHigh = Math.max(...priorHighs);
    const minLow = Math.min(...priorLows);

    if (
      c.high > maxHigh &&
      c.close < maxHigh
    ) {
      latestSweep = "Bearish Liquidity Sweep";
    }

    if (
      c.low < minLow &&
      c.close > minLow
    ) {
      latestSweep = "Bullish Liquidity Sweep";
    }
  }

  return {
    equalHighs,
    equalLows,
    latestSweep
  };
}

// ============================================================
// FVG
// ============================================================

function findFVG(candles) {
  const bullish = [];
  const bearish = [];

  for (let i = 2; i < candles.length; i++) {
    const a = candles[i - 2];
    const c = candles[i];

    // Bullish FVG
    if (c.low > a.high) {
      bullish.push({
        low: round(a.high, 5),
        high: round(c.low, 5),
        index: i,
        time: candles[i].time
      });
    }

    // Bearish FVG
    if (c.high < a.low) {
      bearish.push({
        low: round(c.high, 5),
        high: round(a.low, 5),
        index: i,
        time: candles[i].time
      });
    }
  }

  return {
    bullish: bullish.slice(-12),
    bearish: bearish.slice(-12)
  };
}

// ============================================================
// ORDER BLOCKS
// ============================================================

function findOrderBlocks(candles) {
  const bullish = [];
  const bearish = [];

  for (let i = 2; i < candles.length; i++) {
    const c = candles[i];
    const next = candles[i + 1];

    if (!next) continue;

    // Previous bearish candle before bullish expansion
    if (
      c.close < c.open &&
      next.close > next.open &&
      next.close > c.high
    ) {
      bullish.push({
        low: round(c.low, 5),
        high: round(c.high, 5),
        index: i,
        time: c.time
      });
    }

    // Previous bullish candle before bearish expansion
    if (
      c.close > c.open &&
      next.close < next.open &&
      next.close < c.low
    ) {
      bearish.push({
        low: round(c.low, 5),
        high: round(c.high, 5),
        index: i,
        time: c.time
      });
    }
  }

  return {
    bullish: bullish.slice(-12),
    bearish: bearish.slice(-12)
  };
}

// ============================================================
// SUPPLY / DEMAND
// ============================================================

function findSupplyDemand(candles) {
  const supply = [];
  const demand = [];

  for (let i = 2; i < candles.length - 1; i++) {
    const c = candles[i];
    const next = candles[i + 1];

    const range = c.high - c.low;

    if (range <= 0) continue;

    const nextMove = next.close - c.close;

    if (
      nextMove > range * 0.8
    ) {
      demand.push({
        low: round(c.low, 5),
        high: round(c.high, 5),
        time: c.time
      });
    }

    if (
      nextMove < -range * 0.8
    ) {
      supply.push({
        low: round(c.low, 5),
        high: round(c.high, 5),
        time: c.time
      });
    }
  }

  return {
    demand: demand.slice(-10),
    supply: supply.slice(-10)
  };
}

// ============================================================
// SUPPORT / RESISTANCE
// ============================================================

function supportResistance(candles, structure) {
  const price = last(candles).close;

  const supports = [];
  const resistances = [];

  for (const x of structure.lows) {
    if (x.price < price) {
      supports.push(x.price);
    }
  }

  for (const x of structure.highs) {
    if (x.price > price) {
      resistances.push(x.price);
    }
  }

  supports.sort((a, b) => b - a);
  resistances.sort((a, b) => a - b);

  return {
    currentPrice: round(price, 5),
    support: supports[0] ?? null,
    nextSupport: supports[1] ?? null,
    resistance: resistances[0] ?? null,
    nextResistance: resistances[1] ?? null
  };
}

// ============================================================
// VOLUME
// ============================================================

function volumeAnalysis(candles) {
  const volumes = candles
    .map(x => x.volume)
    .filter(Number.isFinite);

  if (volumes.length < 20) {
    return {
      available: false,
      message: "Volume unavailable from data source"
    };
  }

  const current = last(volumes);
  const baseline = avg(volumes.slice(-20));

  let state = "Normal";

  if (current > baseline * 1.5) {
    state = "High Volume";
  } else if (current < baseline * 0.6) {
    state = "Low Volume";
  }

  return {
    available: true,
    current: round(current, 2),
    average20: round(baseline, 2),
    state
  };
}

// ============================================================
// INDICATOR / TREND
// ============================================================

function indicatorAnalysis(candles) {
  const closes = candles.map(x => x.close);

  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);

  const r = rsi(closes, 14);
  const a = atr(candles, 14);
  const m = macd(closes);

  const EMA9 = last(e9);
  const EMA21 = last(e21);
  const EMA50 = last(e50);

  const RSI14 = last(r);
  const ATR14 = last(a);

  const MACDLine = last(m.line);
  const MACDSignal = last(m.signal);
  const MACDHist = last(m.histogram);

  let trend = "Neutral";

  if (
    EMA9 > EMA21 &&
    EMA21 > EMA50
  ) {
    trend = "Strong Bullish";
  } else if (
    EMA9 < EMA21 &&
    EMA21 < EMA50
  ) {
    trend = "Strong Bearish";
  } else if (
    EMA9 > EMA21
  ) {
    trend = "Bullish";
  } else if (
    EMA9 < EMA21
  ) {
    trend = "Bearish";
  }

  let momentum = "Neutral Momentum";

  if (RSI14 >= 55) {
    momentum = "Bullish Momentum";
  } else if (RSI14 <= 45) {
    momentum = "Bearish Momentum";
  }

  let macdBias = "Neutral";

  if (
    MACDHist > 0 &&
    MACDLine > MACDSignal
  ) {
    macdBias = "Bullish";
  } else if (
    MACDHist < 0 &&
    MACDLine < MACDSignal
  ) {
    macdBias = "Bearish";
  }

  return {
    EMA9: round(EMA9, 5),
    EMA21: round(EMA21, 5),
    EMA50: round(EMA50, 5),
    RSI14: round(RSI14, 2),
    ATR14: round(ATR14, 5),
    MACD: {
      line: round(MACDLine, 5),
      signal: round(MACDSignal, 5),
      histogram: round(MACDHist, 5),
      bias: macdBias
    },
    trend,
    momentum
  };
}

// ============================================================
// ZONE HELPERS
// ============================================================

function priceInsideZone(price, zone) {
  if (!zone) return false;

  return (
    price >= zone.low &&
    price <= zone.high
  );
}

function nearestZone(price, zones, direction = "any") {
  const valid = zones.filter(Boolean);

  const filtered = valid.filter(z => {
    if (direction === "below") {
      return z.high <= price;
    }

    if (direction === "above") {
      return z.low >= price;
    }

    return true;
  });

  filtered.sort(
    (a, b) =>
      Math.abs(((a.low + a.high) / 2) - price) -
      Math.abs(((b.low + b.high) / 2) - price)
  );

  return filtered[0] || null;
}

// ============================================================
// SMC SCORING
// ============================================================

function smcScore({
  structure,
  breaks,
  liquidity,
  candle,
  price,
  fvg,
  orderBlocks
}) {
  let bullishScore = 0;
  let bearishScore = 0;

  const bullishReasons = [];
  const bearishReasons = [];

  if (structure.structure === "Bullish Structure") {
    bullishScore++;
    bullishReasons.push("Bullish market structure");
  }

  if (structure.structure === "Bearish Structure") {
    bearishScore++;
    bearishReasons.push("Bearish market structure");
  }

  if (breaks.BOS === "Bullish BOS") {
    bullishScore += 2;
    bullishReasons.push("Bullish BOS");
  }

  if (breaks.BOS === "Bearish BOS") {
    bearishScore += 2;
    bearishReasons.push("Bearish BOS");
  }

  if (breaks.CHoCH === "Bullish CHoCH") {
    bullishScore += 2;
    bullishReasons.push("Bullish CHoCH");
  }

  if (breaks.CHoCH === "Bearish CHoCH") {
    bearishScore += 2;
    bearishReasons.push("Bearish CHoCH");
  }

  if (breaks.MSS === "Bullish MSS") {
    bullishScore += 2;
    bullishReasons.push("Bullish MSS");
  }

  if (breaks.MSS === "Bearish MSS") {
    bearishScore += 2;
    bearishReasons.push("Bearish MSS");
  }

  if (
    liquidity.latestSweep ===
    "Bullish Liquidity Sweep"
  ) {
    bullishScore += 2;
    bullishReasons.push("Bullish liquidity sweep");
  }

  if (
    liquidity.latestSweep ===
    "Bearish Liquidity Sweep"
  ) {
    bearishScore += 2;
    bearishReasons.push("Bearish liquidity sweep");
  }

  if (candle.direction === "Bullish") {
    bullishScore++;
  }

  if (candle.direction === "Bearish") {
    bearishScore++;
  }

  const bullishFVG =
    fvg.bullish.some(x =>
      priceInsideZone(price, x)
    );

  const bearishFVG =
    fvg.bearish.some(x =>
      priceInsideZone(price, x)
    );

  if (bullishFVG) {
    bullishScore++;
    bullishReasons.push("Price inside bullish FVG");
  }

  if (bearishFVG) {
    bearishScore++;
    bearishReasons.push("Price inside bearish FVG");
  }

  const bullishOB =
    orderBlocks.bullish.some(x =>
      priceInsideZone(price, x)
    );

  const bearishOB =
    orderBlocks.bearish.some(x =>
      priceInsideZone(price, x)
    );

  if (bullishOB) {
    bullishScore++;
    bullishReasons.push("Price inside bullish OB");
  }

  if (bearishOB) {
    bearishScore++;
    bearishReasons.push("Price inside bearish OB");
  }

  return {
    bullishScore,
    bearishScore,
    bullishReasons,
    bearishReasons
  };
}

// ============================================================
// TIMEFRAME ANALYSIS
// ============================================================

function analyzeTimeframe(candles, timeframe) {
  if (!candles || candles.length < 80) {
    throw new Error(
      `${timeframe}: insufficient candle data`
    );
  }

  const currentClosedCandle = last(candles);

  const indicators =
    indicatorAnalysis(candles);

  const structure =
    structureAnalysis(candles);

  const breaks =
    structureBreakAnalysis(
      candles,
      structure
    );

  const candle =
    candleAnalysis(
      candles,
      indicators.ATR14
    );

  const liquidity =
    liquidityAnalysis(
      candles,
      indicators.ATR14
    );

  const fvg =
    findFVG(candles);

  const orderBlocks =
    findOrderBlocks(candles);

  const supplyDemand =
    findSupplyDemand(candles);

  const supportResistanceData =
    supportResistance(
      candles,
      structure
    );

  const volume =
    volumeAnalysis(candles);

  const smc =
    smcScore({
      structure,
      breaks,
      liquidity,
      candle,
      price: currentClosedCandle.close,
      fvg,
      orderBlocks
    });

  // IMPORTANT:
  // Current data source returns completed candles.
  // Therefore we DO NOT falsely label the last candle
  // as a live forming candle.
  const formingCandle = null;

  return {
    timeframe,

    currentClosedCandle: {
      time: currentClosedCandle.time,
      open: round(currentClosedCandle.open, 5),
      high: round(currentClosedCandle.high, 5),
      low: round(currentClosedCandle.low, 5),
      close: round(currentClosedCandle.close, 5)
    },

    formingCandle: null,

    candleDataNote:
      "Twelve Data time_series response is treated as closed-candle data. Live forming candle is not used for confirmation.",

    structure: {
      structure: structure.structure,
      HH: structure.HH,
      HL: structure.HL,
      LH: structure.LH,
      LL: structure.LL,
      latestSwingHigh: structure.latestSwingHigh,
      previousSwingHigh: structure.previousSwingHigh,
      latestSwingLow: structure.latestSwingLow,
      previousSwingLow: structure.previousSwingLow
    },

    BOS: breaks.BOS,
    CHoCH: breaks.CHoCH,
    MSS: breaks.MSS,
    brokenLevel: breaks.brokenLevel,

    liquidity,

    candle,

    displacement: candle.displacement,

    indicators,

    trend:
      indicators.trend,

    momentum:
      indicators.momentum,

    supportResistance:
      supportResistanceData,

    FVG: fvg,

    orderBlocks,

    supplyDemand,

    volume,

    SMC: smc
  };
}

// ============================================================
// MTF BIAS
// ============================================================

function structureBias(oneH, fifteenM, fiveM) {
  let bullish = 0;
  let bearish = 0;

  for (const x of [oneH, fifteenM, fiveM]) {
    if (
      x.structure.structure ===
      "Bullish Structure"
    ) bullish++;

    if (
      x.structure.structure ===
      "Bearish Structure"
    ) bearish++;
  }

  if (bullish >= 2 && bullish > bearish) {
    return "Bullish";
  }

  if (bearish >= 2 && bearish > bullish) {
    return "Bearish";
  }

  return "Mixed";
}

// ============================================================
// REVERSAL STATE
// ============================================================

function reversalState(htf, mid, ltf) {
  const bullish15 =
    mid.CHoCH === "Bullish CHoCH" ||
    mid.MSS === "Bullish MSS" ||
    mid.BOS === "Bullish BOS";

  const bearish15 =
    mid.CHoCH === "Bearish CHoCH" ||
    mid.MSS === "Bearish MSS" ||
    mid.BOS === "Bearish BOS";

  const bullish5 =
    ltf.BOS === "Bullish BOS" ||
    ltf.CHoCH === "Bullish CHoCH" ||
    ltf.MSS === "Bullish MSS";

  const bearish5 =
    ltf.BOS === "Bearish BOS" ||
    ltf.CHoCH === "Bearish CHoCH" ||
    ltf.MSS === "Bearish MSS";

  if (
    htf.structure.structure === "Bearish Structure" &&
    bullish15 &&
    bullish5
  ) {
    return "Bullish Reversal Attempt";
  }

  if (
    htf.structure.structure === "Bullish Structure" &&
    bearish15 &&
    bearish5
  ) {
    return "Bearish Reversal Attempt";
  }

  return "No Confirmed Reversal";
}

// ============================================================
// ENTRY CONFIRMATION
// ============================================================

function entryConfirmation(oneH, fifteenM, fiveM) {
  let bullishScore = 0;
  let bearishScore = 0;

  const bullishReasons = [];
  const bearishReasons = [];

  // ----------------------------------------------------------
  // 1H DIRECTION
  // ----------------------------------------------------------

  if (
    oneH.structure.structure ===
    "Bullish Structure"
  ) {
    bullishScore += 2;
    bullishReasons.push(
      "1H bullish structure"
    );
  }

  if (
    oneH.structure.structure ===
    "Bearish Structure"
  ) {
    bearishScore += 2;
    bearishReasons.push(
      "1H bearish structure"
    );
  }

  // ----------------------------------------------------------
  // 15M STRUCTURE
  // ----------------------------------------------------------

  if (
    fifteenM.structure.structure ===
    "Bullish Structure"
  ) {
    bullishScore += 2;
    bullishReasons.push(
      "15M bullish structure"
    );
  }

  if (
    fifteenM.structure.structure ===
    "Bearish Structure"
  ) {
    bearishScore += 2;
    bearishReasons.push(
      "15M bearish structure"
    );
  }

  // ----------------------------------------------------------
  // 15M CHOCH / MSS
  // ----------------------------------------------------------

  if (
    fifteenM.CHoCH === "Bullish CHoCH" ||
    fifteenM.MSS === "Bullish MSS"
  ) {
    bullishScore += 2;

    bullishReasons.push(
      "15M bullish CHoCH/MSS"
    );
  }

  if (
    fifteenM.CHoCH === "Bearish CHoCH" ||
    fifteenM.MSS === "Bearish MSS"
  ) {
    bearishScore += 2;

    bearishReasons.push(
      "15M bearish CHoCH/MSS"
    );
  }

  // ----------------------------------------------------------
  // 5M STRUCTURE BREAK
  // ----------------------------------------------------------

  const bullish5Break =
    fiveM.BOS === "Bullish BOS" ||
    fiveM.CHoCH === "Bullish CHoCH" ||
    fiveM.MSS === "Bullish MSS";

  const bearish5Break =
    fiveM.BOS === "Bearish BOS" ||
    fiveM.CHoCH === "Bearish CHoCH" ||
    fiveM.MSS === "Bearish MSS";

  if (bullish5Break) {
    bullishScore += 2;
    bullishReasons.push(
      "5M bullish structure break"
    );
  }

  if (bearish5Break) {
    bearishScore += 2;
    bearishReasons.push(
      "5M bearish structure break"
    );
  }

  // ----------------------------------------------------------
  // 5M INDICATORS
  // ----------------------------------------------------------

  if (
    fiveM.indicators.RSI14 >= 50
  ) {
    bullishScore++;
    bullishReasons.push(
      "5M RSI above 50"
    );
  }

  if (
    fiveM.indicators.RSI14 < 50
  ) {
    bearishScore++;
    bearishReasons.push(
      "5M RSI below 50"
    );
  }

  if (
    fiveM.indicators.MACD.bias ===
    "Bullish"
  ) {
    bullishScore++;
    bullishReasons.push(
      "5M MACD bullish"
    );
  }

  if (
    fiveM.indicators.MACD.bias ===
    "Bearish"
  ) {
    bearishScore++;
    bearishReasons.push(
      "5M MACD bearish"
    );
  }

  // ----------------------------------------------------------
  // LIQUIDITY SWEEP
  // ----------------------------------------------------------

  if (
    fiveM.liquidity.latestSweep ===
    "Bullish Liquidity Sweep"
  ) {
    bullishScore += 2;
    bullishReasons.push(
      "5M bullish liquidity sweep"
    );
  }

  if (
    fiveM.liquidity.latestSweep ===
    "Bearish Liquidity Sweep"
  ) {
    bearishScore += 2;
    bearishReasons.push(
      "5M bearish liquidity sweep"
    );
  }

  // ----------------------------------------------------------
  // CANDLE
  // ----------------------------------------------------------

  if (
    fiveM.candle.direction === "Bullish" &&
    fiveM.candle.strength === "Strong"
  ) {
    bullishScore++;
    bullishReasons.push(
      "5M strong bullish candle"
    );
  }

  if (
    fiveM.candle.direction === "Bearish" &&
    fiveM.candle.strength === "Strong"
  ) {
    bearishScore++;
    bearishReasons.push(
      "5M strong bearish candle"
    );
  }

  // ----------------------------------------------------------
  // MTF ALIGNMENT
  // ----------------------------------------------------------

  const htfBull =
    oneH.structure.structure ===
    "Bullish Structure";

  const htfBear =
    oneH.structure.structure ===
    "Bearish Structure";

  const midBull =
    fifteenM.structure.structure ===
    "Bullish Structure";

  const midBear =
    fifteenM.structure.structure ===
    "Bearish Structure";

  const ltfBull =
    fiveM.indicators.trend === "Bullish" ||
    fiveM.indicators.trend === "Strong Bullish";

  const ltfBear =
    fiveM.indicators.trend === "Bearish" ||
    fiveM.indicators.trend === "Strong Bearish";

  const bullishAlignment =
    htfBull && midBull && ltfBull;

  const bearishAlignment =
    htfBear && midBear && ltfBear;

  if (bullishAlignment) {
    bullishScore += 3;
    bullishReasons.push(
      "1H/15M/5M bullish alignment"
    );
  }

  if (bearishAlignment) {
    bearishScore += 3;
    bearishReasons.push(
      "1H/15M/5M bearish alignment"
    );
  }

  // ----------------------------------------------------------
  // FINAL STATE
  // ----------------------------------------------------------

  const currentPrice =
    fiveM.currentClosedCandle.close;

  let direction = "None";
  let status = "Waiting";

  const entryReason = [];

  /*
    BUY confirmation requires:
    - Bullish HTF/mid context OR valid bullish reversal
    - 5M structure break
    - Technical confirmation
  */

  const bullishTechnical =
    fiveM.indicators.RSI14 >= 50 &&
    fiveM.indicators.MACD.bias === "Bullish";

  const bearishTechnical =
    fiveM.indicators.RSI14 < 50 &&
    fiveM.indicators.MACD.bias === "Bearish";

  const bullishMidBreak =
    fifteenM.BOS === "Bullish BOS" ||
    fifteenM.CHoCH === "Bullish CHoCH" ||
    fifteenM.MSS === "Bullish MSS";

  const bearishMidBreak =
    fifteenM.BOS === "Bearish BOS" ||
    fifteenM.CHoCH === "Bearish CHoCH" ||
    fifteenM.MSS === "Bearish MSS";

  /*
    We don't call a trade confirmed only because
    indicators agree. Structure confirmation is required.
  */

  const bullishStructureConfirmed =
    bullish5Break &&
    (
      bullishMidBreak ||
      htfBull
    );

  const bearishStructureConfirmed =
    bearish5Break &&
    (
      bearishMidBreak ||
      htfBear
    );

  if (
    bullishStructureConfirmed &&
    bullishTechnical &&
    bullishScore >= 7 &&
    bullishScore > bearishScore + 2
  ) {
    direction = "BUY";
    status = "Confirmed";

    entryReason.push(
      "Bullish MTF/structure confirmation"
    );

    entryReason.push(
      "5M structure break confirmed"
    );

    entryReason.push(
      "5M technical confirmation"
    );
  } else if (
    bearishStructureConfirmed &&
    bearishTechnical &&
    bearishScore >= 7 &&
    bearishScore > bullishScore + 2
  ) {
    direction = "SELL";
    status = "Confirmed";

    entryReason.push(
      "Bearish MTF/structure confirmation"
    );

    entryReason.push(
      "5M structure break confirmed"
    );

    entryReason.push(
      "5M technical confirmation"
    );
  } else {
    status = "Waiting";
  }

  /*
    Invalid state:
    Strongly conflicting structure and no valid break.
  */

  if (
    htfBear &&
    bullishMidBreak &&
    !bullish5Break
  ) {
    status = "Waiting";

    entryReason.push(
      "15M bullish reversal attempt but 5M confirmation missing"
    );
  }

  if (
    htfBull &&
    bearishMidBreak &&
    !bearish5Break
  ) {
    status = "Waiting";

    entryReason.push(
      "15M bearish reversal attempt but 5M confirmation missing"
    );
  }

  return {
    status,
    direction,
    bullishScore,
    bearishScore,
    bullishReasons,
    bearishReasons,
    entryReason,

    confirmationRules: {
      HTFAlignmentRequired: true,
      LTFStructureBreakRequired: true,
      TechnicalConfirmationRequired: true,
      RetestPreferred: true,
      LiquiditySweepPreferred: true
    },

    currentPrice: round(currentPrice, 5)
  };
}

// ============================================================
// RETEST ENGINE
// ============================================================

function retestAnalysis(fiveM) {
  const price =
    fiveM.currentClosedCandle.close;

  const bullishZones = [
    ...fiveM.FVG.bullish,
    ...fiveM.orderBlocks.bullish
  ];

  const bearishZones = [
    ...fiveM.FVG.bearish,
    ...fiveM.orderBlocks.bearish
  ];

  const bullishZone =
    nearestZone(
      price,
      bullishZones,
      "below"
    );

  const bearishZone =
    nearestZone(
      price,
      bearishZones,
      "above"
    );

  return {
    bullishRetestZone: bullishZone,
    bearishRetestZone: bearishZone,

    priceInBullishZone:
      bullishZones.some(z =>
        priceInsideZone(price, z)
      ),

    priceInBearishZone:
      bearishZones.some(z =>
        priceInsideZone(price, z)
      )
  };
}

// ============================================================
// TRADE LEVELS
// ============================================================

function tradeLevels(direction, fiveM, fifteenM) {
  const price =
    fiveM.currentClosedCandle.close;

  const atrValue =
    fiveM.indicators.ATR14;

  if (!Number.isFinite(price)) {
    return null;
  }

  /*
    ATR based stop.
    Uses structure where possible.
  */

  let sl = null;

  if (direction === "BUY") {
    const structuralLow =
      fiveM.structure.latestSwingLow?.price ??
      fifteenM.structure.latestSwingLow?.price;

    const atrSL =
      price - atrValue * 1.5;

    sl =
      Number.isFinite(structuralLow)
        ? Math.min(
            structuralLow - atrValue * 0.15,
            atrSL
          )
        : atrSL;
  }

  if (direction === "SELL") {
    const structuralHigh =
      fiveM.structure.latestSwingHigh?.price ??
      fifteenM.structure.latestSwingHigh?.price;

    const atrSL =
      price + atrValue * 1.5;

    sl =
      Number.isFinite(structuralHigh)
        ? Math.max(
            structuralHigh + atrValue * 0.15,
            atrSL
          )
        : atrSL;
  }

  if (!Number.isFinite(sl)) {
    return null;
  }

  const risk =
    Math.abs(price - sl);

  if (risk <= 0) {
    return null;
  }

  const tp1 =
    direction === "BUY"
      ? price + risk * 1
      : price - risk * 1;

  const tp2 =
    direction === "BUY"
      ? price + risk * 1.5
      : price - risk * 1.5;

  const tp3 =
    direction === "BUY"
      ? price + risk * 2
      : price - risk * 2;

  return {
    direction,
    entry: round(price, 5),
    stopLoss: round(sl, 5),
    risk: round(risk, 5),
    TP1_1R: round(tp1, 5),
    TP2_1_5R: round(tp2, 5),
    TP3_2R: round(tp3, 5)
  };
}

// ============================================================
// MTF ANALYSIS
// ============================================================

async function mtfAnalysis() {
  const [oneHCandles, fifteenCandles, fiveCandles] =
    await Promise.all([
      getCandles(TF["1H"], 350),
      getCandles(TF["15M"], 350),
      getCandles(TF["5M"], 350)
    ]);

  const oneH =
    analyzeTimeframe(oneHCandles, "1H");

  const fifteen =
    analyzeTimeframe(
      fifteenCandles,
      "15M"
    );

  const five =
    analyzeTimeframe(
      fiveCandles,
      "5M"
    );

  const bias =
    structureBias(
      oneH,
      fifteen,
      five
    );

  const reversal =
    reversalState(
      oneH,
      fifteen,
      five
    );

  const confirmation =
    entryConfirmation(
      oneH,
      fifteen,
      five
    );

  const retest =
    retestAnalysis(five);

  let levels = null;

  if (
    confirmation.status === "Confirmed"
  ) {
    levels =
      tradeLevels(
        confirmation.direction,
        five,
        fifteen
      );
  }

  // ----------------------------------------------------------
  // MTF confirmation labels
  // ----------------------------------------------------------

  let HTF_BOS = "None";
  let LTF_BOS = "None";

  if (
    oneH.BOS !== "None"
  ) {
    HTF_BOS = oneH.BOS;
  } else if (
    fifteen.BOS !== "None"
  ) {
    HTF_BOS = fifteen.BOS;
  }

  if (
    five.BOS !== "None"
  ) {
    LTF_BOS = five.BOS;
  }

  // ----------------------------------------------------------
  // Important levels
  // ----------------------------------------------------------

  const currentPrice =
    five.currentClosedCandle.close;

  const support =
    five.supportResistance.support;

  const nextSupport =
    five.supportResistance.nextSupport;

  const resistance =
    five.supportResistance.resistance;

  const nextResistance =
    five.supportResistance.nextResistance;

  return {
    success: true,

    instrument: OUTPUT_SYMBOL,

    generatedAt:
      new Date().toISOString(),

    MTF: {
      "1H": oneH.trend,
      "15M": fifteen.trend,
      "5M": five.trend,

      alignment:
        oneH.trend.includes("Bullish") &&
        fifteen.trend.includes("Bullish") &&
        five.trend.includes("Bullish")
          ? "Bullish MTF Alignment"
          : oneH.trend.includes("Bearish") &&
            fifteen.trend.includes("Bearish") &&
            five.trend.includes("Bearish")
              ? "Bearish MTF Alignment"
              : "Mixed MTF Alignment"
    },

    MTF_STRUCTURE: {
      "1H":
        oneH.structure.structure,

      "15M":
        fifteen.structure.structure,

      "5M":
        five.structure.structure,

      structureBias: bias,

      reversalState: reversal
    },

    MTF_CONFIRMATION: {
      HTF_BOS,
      LTF_BOS,

      "1H_CHoCH":
        oneH.CHoCH,

      "15M_CHoCH":
        fifteen.CHoCH,

      "5M_CHoCH":
        five.CHoCH,

      "1H_MSS":
        oneH.MSS,

      "15M_MSS":
        fifteen.MSS,

      "5M_MSS":
        five.MSS
    },

    ENTRY_CONFIRMATION: confirmation,

    RETEST: retest,

    TRADE_LEVELS: levels,

    INVALIDATION: {
      SELL:
        resistance,

      BUY:
        support
    },

    importantLevels: {
      currentPrice,

      support,

      nextSupport,

      resistance,

      nextResistance
    },

    analysis: {
      "1H": oneH,
      "15M": fifteen,
      "5M": five
    }
  };
}

// ============================================================
// GEMINI OPTIONAL
// ============================================================

async function geminiAnalyze(prompt) {
  if (!GEMINI_API_KEY) {
    return {
      success: false,
      message: "GEMINI_API_KEY not configured"
    };
  }

  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" +
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
      return {
        success: false,
        error:
          data.error?.message ||
          "Gemini request failed"
      };
    }

    const text =
      data.candidates?.[0]?.content?.parts?.[0]?.text ||
      "";

    return {
      success: true,
      text
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

// ============================================================
// ROUTES
// ============================================================

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "XAU AI BOT IS ONLINE",
    instrument: OUTPUT_SYMBOL,
    endpoints: [
      "/gold-data",
      "/technical-analysis",
      "/mtf-analysis",
      "/analyze",
      "/gemini-test"
    ]
  });
});

// ------------------------------------------------------------
// GOLD DATA
// ------------------------------------------------------------

app.get("/gold-data", async (req, res) => {
  try {
    const candles =
      await getCandles(TF["5M"], 100);

    res.json({
      success: true,
      instrument: OUTPUT_SYMBOL,
      timeframe: "5M",
      count: candles.length,
      candles
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ------------------------------------------------------------
// TECHNICAL ANALYSIS
// ------------------------------------------------------------

app.get("/technical-analysis", async (req, res) => {
  try {
    const candles =
      await getCandles(TF["5M"], 350);

    const analysis =
      analyzeTimeframe(
        candles,
        "5M"
      );

    res.json({
      success: true,
      instrument: OUTPUT_SYMBOL,
      analysis
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ------------------------------------------------------------
// MTF ANALYSIS
// ------------------------------------------------------------

app.get("/mtf-analysis", async (req, res) => {
  try {
    const result =
      await mtfAnalysis();

    res.json(result);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ------------------------------------------------------------
// ANALYZE
// ------------------------------------------------------------

app.get("/analyze", async (req, res) => {
  try {
    const result =
      await mtfAnalysis();

    const prompt = `
You are a technical market analysis assistant.

Instrument: XAUUSD

Analyze the following machine-generated MTF data.

Do NOT invent prices or data.

Explain:
1. 1H structure
2. 15M structure
3. 5M structure
4. BOS/CHoCH/MSS
5. Liquidity
6. FVG
7. Order blocks
8. Momentum
9. MTF alignment
10. Entry confirmation
11. Invalidation
12. Important support/resistance
13. What confirmation is still missing

If ENTRY_CONFIRMATION status is Waiting,
do not convert it into a confirmed trade.

DATA:

${JSON.stringify(result, null, 2)}
`;

    const ai =
      await geminiAnalyze(prompt);

    res.json({
      success: true,
      instrument: OUTPUT_SYMBOL,

      technicalAnalysis:
        result,

      AI:
        ai
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ------------------------------------------------------------
// GEMINI TEST
// ------------------------------------------------------------

app.get("/gemini-test", async (req, res) => {
  const result =
    await geminiAnalyze(
      "Reply with exactly: GEMINI OK"
    );

  res.json(result);
});

// ============================================================
// ERROR HANDLER
// ============================================================

app.use((err, req, res, next) => {
  console.error(err);

  res.status(500).json({
    success: false,
    error:
      err.message ||
      "Internal server error"
  });
});

// ============================================================
// SERVER
// ============================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `XAU AI BOT running on port ${PORT}`
    );
  }
);

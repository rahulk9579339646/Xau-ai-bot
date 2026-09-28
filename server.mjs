import express from "express";

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;

const SYMBOL = "XAU/USD";


// ============================================================
// BASIC
// ============================================================

app.get("/", (req, res) => {
  res.send("XAU AI BOT IS ONLINE");
});


// ============================================================
// TWELVE DATA - GOLD CANDLES
// ============================================================

async function getGoldCandles(interval = "5min", outputsize = 200) {

  const url =
    `https://api.twelvedata.com/time_series` +
    `?symbol=${encodeURIComponent(SYMBOL)}` +
    `&interval=${interval}` +
    `&outputsize=${outputsize}` +
    `&apikey=${TWELVE_DATA_API_KEY}`;

  const response = await fetch(url);

  const data = await response.json();

  if (!response.ok || data.status === "error") {
    throw new Error(
      `Twelve Data error: ${JSON.stringify(data)}`
    );
  }

  if (!data.values || !Array.isArray(data.values)) {
    throw new Error("No candle data returned from Twelve Data");
  }

  return data.values
    .map(c => ({
      time: c.datetime,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume:
        c.volume !== undefined
          ? Number(c.volume)
          : null
    }))
    .reverse();
}


// ============================================================
// MATH HELPERS
// ============================================================

function calculateEMA(values, period) {

  if (values.length < period) {
    return null;
  }

  const multiplier = 2 / (period + 1);

  let ema =
    values
      .slice(0, period)
      .reduce((sum, value) => sum + value, 0) /
    period;

  for (let i = period; i < values.length; i++) {

    ema =
      (values[i] - ema) * multiplier +
      ema;
  }

  return ema;
}


function calculateEMAArray(values, period) {

  if (values.length < period) {
    return [];
  }

  const multiplier = 2 / (period + 1);

  let ema =
    values
      .slice(0, period)
      .reduce((sum, value) => sum + value, 0) /
    period;

  const result = [];

  for (let i = 0; i < period - 1; i++) {
    result.push(null);
  }

  result.push(ema);

  for (let i = period; i < values.length; i++) {

    ema =
      (values[i] - ema) * multiplier +
      ema;

    result.push(ema);
  }

  return result;
}


function calculateRSI(values, period = 14) {

  if (values.length <= period) {
    return null;
  }

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {

    const change =
      values[i] - values[i - 1];

    if (change > 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  let averageGain = gains / period;
  let averageLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {

    const change =
      values[i] - values[i - 1];

    const gain =
      change > 0 ? change : 0;

    const loss =
      change < 0 ? Math.abs(change) : 0;

    averageGain =
      (
        averageGain * (period - 1) +
        gain
      ) / period;

    averageLoss =
      (
        averageLoss * (period - 1) +
        loss
      ) / period;
  }

  if (averageLoss === 0) {
    return 100;
  }

  const rs =
    averageGain / averageLoss;

  return 100 - (100 / (1 + rs));
}


function calculateATR(candles, period = 14) {

  if (candles.length <= period) {
    return null;
  }

  const trueRanges = [];

  for (let i = 1; i < candles.length; i++) {

    const current = candles[i];
    const previous = candles[i - 1];

    const tr = Math.max(
      current.high - current.low,
      Math.abs(
        current.high - previous.close
      ),
      Math.abs(
        current.low - previous.close
      )
    );

    trueRanges.push(tr);
  }

  if (trueRanges.length < period) {
    return null;
  }

  let atr =
    trueRanges
      .slice(0, period)
      .reduce((a, b) => a + b, 0) /
    period;

  for (
    let i = period;
    i < trueRanges.length;
    i++
  ) {

    atr =
      (
        atr * (period - 1) +
        trueRanges[i]
      ) / period;
  }

  return atr;
}


// ============================================================
// MACD
// ============================================================

function calculateMACD(values) {

  const ema12 =
    calculateEMAArray(values, 12);

  const ema26 =
    calculateEMAArray(values, 26);

  const macdLine = [];

  for (let i = 0; i < values.length; i++) {

    if (
      ema12[i] !== null &&
      ema26[i] !== null
    ) {
      macdLine.push(
        ema12[i] - ema26[i]
      );
    }
  }

  if (macdLine.length < 9) {

    return {
      line: null,
      signal: null,
      histogram: null
    };
  }

  const signalArray =
    calculateEMAArray(macdLine, 9);

  const line =
    macdLine[macdLine.length - 1];

  const signal =
    signalArray[signalArray.length - 1];

  const histogram =
    line !== null &&
    signal !== null
      ? line - signal
      : null;

  return {
    line,
    signal,
    histogram
  };
}


// ============================================================
// SWING DETECTION
// ============================================================

function findSwingHighs(candles) {

  const swings = [];

  for (
    let i = 2;
    i < candles.length - 2;
    i++
  ) {

    const c = candles[i];

    if (
      c.high > candles[i - 1].high &&
      c.high > candles[i - 2].high &&
      c.high > candles[i + 1].high &&
      c.high > candles[i + 2].high
    ) {

      swings.push({
        index: i,
        time: c.time,
        price: c.high
      });
    }
  }

  return swings;
}


function findSwingLows(candles) {

  const swings = [];

  for (
    let i = 2;
    i < candles.length - 2;
    i++
  ) {

    const c = candles[i];

    if (
      c.low < candles[i - 1].low &&
      c.low < candles[i - 2].low &&
      c.low < candles[i + 1].low &&
      c.low < candles[i + 2].low
    ) {

      swings.push({
        index: i,
        time: c.time,
        price: c.low
      });
    }
  }

  return swings;
}


// ============================================================
// STRUCTURE
// ============================================================

function getStructure(
  swingHighs,
  swingLows
) {

  if (
    swingHighs.length < 2 ||
    swingLows.length < 2
  ) {

    return {
      structure: "Insufficient data",
      HH: false,
      HL: false,
      LH: false,
      LL: false
    };
  }

  const h1 =
    swingHighs[swingHighs.length - 2];

  const h2 =
    swingHighs[swingHighs.length - 1];

  const l1 =
    swingLows[swingLows.length - 2];

  const l2 =
    swingLows[swingLows.length - 1];

  const HH = h2.price > h1.price;
  const LH = h2.price < h1.price;

  const HL = l2.price > l1.price;
  const LL = l2.price < l1.price;

  let structure = "Neutral";

  if (HH && HL) {
    structure = "Bullish Structure";
  }

  else if (LH && LL) {
    structure = "Bearish Structure";
  }

  return {
    structure,
    HH,
    HL,
    LH,
    LL
  };
}


// ============================================================
// BOS / CHoCH / MSS
// ============================================================

function detectStructureBreak(
  closedCandle,
  swingHighs,
  swingLows,
  structure
) {

  let BOS = "None";
  let BOSReason = "";

  let CHoCH = "None";
  let CHoCHReason = "";

  let MSS = "None";
  let MSSReason = "";

  const latestHigh =
    swingHighs[swingHighs.length - 1];

  const latestLow =
    swingLows[swingLows.length - 1];

  if (
    latestHigh &&
    closedCandle.close > latestHigh.price
  ) {

    BOS = "Bullish BOS";

    BOSReason =
      `Closed candle ${closedCandle.close.toFixed(2)} ` +
      `closed above swing high ${latestHigh.price.toFixed(2)}`;
  }

  else if (
    latestLow &&
    closedCandle.close < latestLow.price
  ) {

    BOS = "Bearish BOS";

    BOSReason =
      `Closed candle ${closedCandle.close.toFixed(2)} ` +
      `closed below swing low ${latestLow.price.toFixed(2)}`;
  }


  if (
    structure.structure === "Bearish Structure" &&
    latestHigh &&
    closedCandle.close > latestHigh.price
  ) {

    CHoCH = "Bullish CHoCH";

    CHoCHReason =
      "Bearish structure was broken upward by a closed candle.";

    MSS = "Bullish MSS";

    MSSReason =
      "Momentum shifted from bearish structure toward bullish structure.";
  }


  if (
    structure.structure === "Bullish Structure" &&
    latestLow &&
    closedCandle.close < latestLow.price
  ) {

    CHoCH = "Bearish CHoCH";

    CHoCHReason =
      "Bullish structure was broken downward by a closed candle.";

    MSS = "Bearish MSS";

    MSSReason =
      "Momentum shifted from bullish structure toward bearish structure.";
  }

  return {
    BOS,
    BOSReason,
    CHoCH,
    CHoCHReason,
    MSS,
    MSSReason
  };
}


// ============================================================
// LIQUIDITY
// ============================================================

function detectLiquidity(
  closedCandle,
  swingHighs,
  swingLows,
  atr
) {

  let buySideSweep = null;
  let sellSideSweep = null;

  const tolerance =
    atr
      ? atr * 0.15
      : 0.5;


  const previousHigh =
    swingHighs[swingHighs.length - 1];

  const previousLow =
    swingLows[swingLows.length - 1];


  if (
    previousHigh &&
    closedCandle.high >
      previousHigh.price &&
    closedCandle.close <
      previousHigh.price
  ) {

    buySideSweep = {
      type: "Buy-side liquidity sweep",
      level: previousHigh.price,
      reason:
        "Price traded above the swing high and closed back below it."
    };
  }


  if (
    previousLow &&
    closedCandle.low <
      previousLow.price &&
    closedCandle.close >
      previousLow.price
  ) {

    sellSideSweep = {
      type: "Sell-side liquidity sweep",
      level: previousLow.price,
      reason:
        "Price traded below the swing low and closed back above it."
    };
  }


  function clusterLevels(items) {

    const levels = [];

    for (const item of items) {

      const existing =
        levels.find(
          level =>
            Math.abs(
              level.price - item.price
            ) <= tolerance
        );

      if (existing) {
        existing.count++;
      } else {
        levels.push({
          price: item.price,
          count: 1
        });
      }
    }

    return levels
      .filter(x => x.count >= 2)
      .slice(-10);
  }


  const equalHighs =
    clusterLevels(
      swingHighs.slice(-20)
    );

  const equalLows =
    clusterLevels(
      swingLows.slice(-20)
    );


  return {
    equalHighs,
    equalLows,
    latestSweep:
      buySideSweep ||
      sellSideSweep ||
      null
  };
}


// ============================================================
// CANDLESTICK
// ============================================================

function detectCandlestick(candle) {

  const range =
    candle.high - candle.low;

  const body =
    Math.abs(
      candle.close - candle.open
    );

  const upperWick =
    candle.high -
    Math.max(
      candle.open,
      candle.close
    );

  const lowerWick =
    Math.min(
      candle.open,
      candle.close
    ) -
    candle.low;

  if (range <= 0) {

    return {
      patterns: [],
      strength: "Invalid"
    };
  }

  const bodyRatio =
    body / range;

  const upperRatio =
    upperWick / range;

  const lowerRatio =
    lowerWick / range;

  const patterns = [];


  if (bodyRatio < 0.15) {
    patterns.push("Doji");
  }


  if (
    lowerRatio >= 0.55 &&
    upperRatio <= 0.20
  ) {

    patterns.push("Bullish Pin Bar");
  }


  if (
    upperRatio >= 0.55 &&
    lowerRatio <= 0.20
  ) {

    patterns.push("Bearish Pin Bar");
  }


  if (
    candle.close > candle.open &&
    bodyRatio >= 0.70
  ) {

    patterns.push("Bullish Strong Body");
  }


  if (
    candle.close < candle.open &&
    bodyRatio >= 0.70
  ) {

    patterns.push("Bearish Strong Body");
  }


  let strength = "Weak / Indecision";

  if (bodyRatio >= 0.70) {
    strength = "Strong";
  }

  else if (bodyRatio >= 0.50) {
    strength = "Moderate";
  }


  return {
    patterns,
    strength,
    body,
    range,
    upperWick,
    lowerWick
  };
}


// ============================================================
// DISPLACEMENT
// ============================================================

function detectDisplacement(
  candles,
  closedIndex,
  atr
) {

  if (
    closedIndex < 3 ||
    !atr
  ) {

    return {
      type: "None",
      reason: "Insufficient data"
    };
  }

  const candle =
    candles[closedIndex];

  const range =
    candle.high - candle.low;

  const body =
    Math.abs(
      candle.close - candle.open
    );

  const bodyRatio =
    range > 0
      ? body / range
      : 0;

  const direction =
    candle.close > candle.open
      ? "Bullish"
      : candle.close < candle.open
        ? "Bearish"
        : "Neutral";


  // True displacement requires:
  // 1. reasonably large range
  // 2. strong body
  // 3. direction
  if (
    range >= atr * 1.2 &&
    bodyRatio >= 0.65
  ) {

    return {
      type:
        direction === "Bullish"
          ? "Bullish Displacement"
          : "Bearish Displacement",

      reason:
        `${direction} candle range (${range.toFixed(2)}) ` +
        `is >= 1.2 ATR (${atr.toFixed(2)}) ` +
        `with ${(bodyRatio * 100).toFixed(1)}% body ratio.`
    };
  }


  return {
    type: "None",
    reason:
      "Candle does not meet ATR and body-ratio displacement requirements."
  };
}


// ============================================================
// FVG
// ============================================================

function detectFVG(candles) {

  const bullish = [];
  const bearish = [];

  for (
    let i = 2;
    i < candles.length;
    i++
  ) {

    const first =
      candles[i - 2];

    const third =
      candles[i];


    if (
      third.low > first.high
    ) {

      bullish.push({
        time: third.time,
        type: "Bullish FVG",
        lower: first.high,
        upper: third.low
      });
    }


    if (
      third.high < first.low
    ) {

      bearish.push({
        time: third.time,
        type: "Bearish FVG",
        lower: third.high,
        upper: first.low
      });
    }
  }

  return {
    bullish: bullish.slice(-10),
    bearish: bearish.slice(-10)
  };
}


// ============================================================
// ORDER BLOCK
// ============================================================

function detectOrderBlocks(candles) {

  const bullish = [];
  const bearish = [];

  for (
    let i = 1;
    i < candles.length;
    i++
  ) {

    const previous =
      candles[i - 1];

    const current =
      candles[i];


    if (
      previous.close < previous.open &&
      current.close > current.open &&
      current.close > previous.high
    ) {

      bullish.push({
        time: previous.time,
        type: "Bullish Order Block",
        high: previous.high,
        low: previous.low
      });
    }


    if (
      previous.close > previous.open &&
      current.close < current.open &&
      current.close < previous.low
    ) {

      bearish.push({
        time: previous.time,
        type: "Bearish Order Block",
        high: previous.high,
        low: previous.low
      });
    }
  }

  return {
    bullish: bullish.slice(-10),
    bearish: bearish.slice(-10)
  };
}


// ============================================================
// SUPPLY / DEMAND
// ============================================================

function detectSupplyDemand(
  candles,
  swingHighs,
  swingLows
) {

  const supply = [];
  const demand = [];


  for (
    const swing of swingHighs.slice(-10)
  ) {

    const candle =
      candles[swing.index];

    if (!candle) continue;

    supply.push({
      time: candle.time,
      high: candle.high,
      low: candle.low
    });
  }


  for (
    const swing of swingLows.slice(-10)
  ) {

    const candle =
      candles[swing.index];

    if (!candle) continue;

    demand.push({
      time: candle.time,
      high: candle.high,
      low: candle.low
    });
  }


  return {
    supply,
    demand
  };
}


// ============================================================
// SUPPORT / RESISTANCE
// ============================================================

function calculateLevels(
  currentPrice,
  swingHighs,
  swingLows
) {

  const supports =
    swingLows
      .map(x => x.price)
      .filter(
        price => price < currentPrice
      )
      .sort((a, b) => b - a);


  const resistances =
    swingHighs
      .map(x => x.price)
      .filter(
        price => price > currentPrice
      )
      .sort((a, b) => a - b);


  return {

    nearestSupport:
      supports[0] ?? null,

    nextSupport:
      supports[1] ?? null,

    nearestResistance:
      resistances[0] ?? null,

    nextResistance:
      resistances[1] ?? null,

    allSupports:
      supports.slice(0, 5),

    allResistances:
      resistances.slice(0, 5)
  };
}


// ============================================================
// VOLUME
// ============================================================

function analyzeVolume(candles) {

  const available =
    candles.some(
      c =>
        c.volume !== null &&
        Number.isFinite(c.volume)
    );

  if (!available) {

    return {
      available: false,
      status: "Volume unavailable from data source"
    };
  }


  const volumes =
    candles
      .map(c => c.volume)
      .filter(
        v =>
          v !== null &&
          Number.isFinite(v)
      );


  if (volumes.length < 20) {

    return {
      available: true,
      status: "Insufficient volume history"
    };
  }


  const current =
    volumes[volumes.length - 1];

  const previous20 =
    volumes.slice(-21, -1);

  const average =
    previous20.reduce(
      (a, b) => a + b,
      0
    ) / previous20.length;


  return {
    available: true,
    current,
    average,
    ratio:
      average > 0
        ? current / average
        : null
  };
}


// ============================================================
// SINGLE TIMEFRAME ANALYSIS
// ============================================================

function analyzeTimeframe(
  candles,
  timeframe
) {

  if (candles.length < 60) {

    throw new Error(
      `${timeframe}: insufficient candles`
    );
  }


  /*
    Twelve Data normally returns latest candle first.
    We reverse it in getGoldCandles().
    
    The final candle may still be forming.
    Therefore:
    
    candles[candles.length - 1] = forming/latest
    candles[candles.length - 2] = latest closed
  */

  const formingCandle =
    candles[candles.length - 1];

  const closedIndex =
    candles.length - 2;

  const closedCandle =
    candles[closedIndex];


  const closedCandles =
    candles.slice(0, candles.length - 1);


  const closes =
    closedCandles.map(
      c => c.close
    );


  const swingHighs =
    findSwingHighs(closedCandles);

  const swingLows =
    findSwingLows(closedCandles);


  const structure =
    getStructure(
      swingHighs,
      swingLows
    );


  const EMA9 =
    calculateEMA(closes, 9);

  const EMA21 =
    calculateEMA(closes, 21);

  const EMA50 =
    calculateEMA(closes, 50);


  const RSI14 =
    calculateRSI(closes, 14);


  const MACD =
    calculateMACD(closes);


  const ATR14 =
    calculateATR(
      closedCandles,
      14
    );


  const structureBreak =
    detectStructureBreak(
      closedCandle,
      swingHighs,
      swingLows,
      structure
    );


  const liquidity =
    detectLiquidity(
      closedCandle,
      swingHighs,
      swingLows,
      ATR14
    );


  const candle =
    detectCandlestick(
      closedCandle
    );


  const displacement =
    detectDisplacement(
      closedCandles,
      closedIndex,
      ATR14
    );


  const fvg =
    detectFVG(
      closedCandles
    );


  const orderBlocks =
    detectOrderBlocks(
      closedCandles
    );


  const supplyDemand =
    detectSupplyDemand(
      closedCandles,
      swingHighs,
      swingLows
    );


  const levels =
    calculateLevels(
      closedCandle.close,
      swingHighs,
      swingLows
    );


  const volume =
    analyzeVolume(
      closedCandles
    );


  // ----------------------------------------------------------
  // TREND
  // ----------------------------------------------------------

  let trend = "Neutral";

  if (
    EMA9 !== null &&
    EMA21 !== null &&
    EMA50 !== null
  ) {

    if (
      EMA9 > EMA21 &&
      EMA21 > EMA50 &&
      closedCandle.close > EMA9
    ) {

      trend = "Strong Bullish";
    }

    else if (
      EMA9 < EMA21 &&
      EMA21 < EMA50 &&
      closedCandle.close < EMA9
    ) {

      trend = "Strong Bearish";
    }

    else if (
      EMA9 > EMA21
    ) {

      trend = "Bullish";
    }

    else if (
      EMA9 < EMA21
    ) {

      trend = "Bearish";
    }
  }


  // ----------------------------------------------------------
  // MOMENTUM
  // ----------------------------------------------------------

  let momentum = "Neutral";

  if (RSI14 !== null) {

    if (RSI14 >= 70) {
      momentum = "Overbought";
    }

    else if (RSI14 <= 30) {
      momentum = "Oversold";
    }

    else if (RSI14 > 55) {
      momentum = "Bullish Momentum";
    }

    else if (RSI14 < 45) {
      momentum = "Bearish Momentum";
    }
  }


  // ----------------------------------------------------------
  // MACD BIAS
  // ----------------------------------------------------------

  let macdBias = "Neutral";

  if (
    MACD.line !== null &&
    MACD.signal !== null
  ) {

    if (
      MACD.line > MACD.signal &&
      MACD.histogram > 0
    ) {

      macdBias = "Bullish";
    }

    else if (
      MACD.line < MACD.signal &&
      MACD.histogram < 0
    ) {

      macdBias = "Bearish";
    }
  }


  // ----------------------------------------------------------
  // SMC SCORE
  // ----------------------------------------------------------

  let bullishScore = 0;
  let bearishScore = 0;


  if (
    structure.structure ===
    "Bullish Structure"
  ) {
    bullishScore++;
  }

  if (
    structure.structure ===
    "Bearish Structure"
  ) {
    bearishScore++;
  }


  if (
    structureBreak.BOS ===
    "Bullish BOS"
  ) {
    bullishScore++;
  }

  if (
    structureBreak.BOS ===
    "Bearish BOS"
  ) {
    bearishScore++;
  }


  if (
    structureBreak.CHoCH ===
    "Bullish CHoCH"
  ) {
    bullishScore++;
  }

  if (
    structureBreak.CHoCH ===
    "Bearish CHoCH"
  ) {
    bearishScore++;
  }


  if (
    liquidity.latestSweep?.type ===
    "Sell-side liquidity sweep"
  ) {
    bullishScore++;
  }

  if (
    liquidity.latestSweep?.type ===
    "Buy-side liquidity sweep"
  ) {
    bearishScore++;
  }


  if (
    displacement.type ===
    "Bullish Displacement"
  ) {
    bullishScore++;
  }

  if (
    displacement.type ===
    "Bearish Displacement"
  ) {
    bearishScore++;
  }


  if (
    fvg.bullish.length > 0
  ) {
    bullishScore++;
  }

  if (
    fvg.bearish.length > 0
  ) {
    bearishScore++;
  }


  return {

    timeframe,

    currentClosedCandle: closedCandle,

    formingCandle,

    current: closedCandle,

    marketStructure: {

      structure:
        structure.structure,

      HH:
        structure.HH,

      HL:
        structure.HL,

      LH:
        structure.LH,

      LL:
        structure.LL,

      latestSwingHigh:
        swingHighs[swingHighs.length - 1] ||
        null,

      previousSwingHigh:
        swingHighs[swingHighs.length - 2] ||
        null,

      latestSwingLow:
        swingLows[swingLows.length - 1] ||
        null,

      previousSwingLow:
        swingLows[swingLows.length - 2] ||
        null
    },


    BOS:
      structureBreak.BOS,

    BOSReason:
      structureBreak.BOSReason,


    CHoCH:
      structureBreak.CHoCH,

    CHoCHReason:
      structureBreak.CHoCHReason,


    MSS:
      structureBreak.MSS,

    MSSReason:
      structureBreak.MSSReason,


    liquidity,


    candle: {

      direction:
        closedCandle.close >
        closedCandle.open
          ? "Bullish"
          : closedCandle.close <
            closedCandle.open
            ? "Bearish"
            : "Doji",

      ...candle
    },


    displacement,


    EMA: {

      EMA9,

      EMA21,

      EMA50
    },


    RSI14,

    MACD,

    ATR14,

    trend,

    momentum,

    macdBias,


    supportResistance:
      levels,


    supplyDemand,


    FVG:
      fvg,


    orderBlocks,


    volume,


    SMC: {

      bullishScore,

      bearishScore
    },


    swingHighs:
      swingHighs.slice(-10),

    swingLows:
      swingLows.slice(-10)
  };
}


// ============================================================
// TECHNICAL ANALYSIS
// ============================================================

app.get(
  "/technical-analysis",
  async (req, res) => {

    try {

      const candles =
        await getGoldCandles(
          "5min",
          200
        );


      const analysis =
        analyzeTimeframe(
          candles,
          "5M"
        );


      res.json({

        success: true,

        instrument:
          "XAUUSD",

        timeframe:
          "5min",

        analysis

      });

    }

    catch (error) {

      res.status(500).json({

        success: false,

        error:
          error.message
      });
    }
  }
);


// ============================================================
// MTF ANALYSIS
// ============================================================

app.get(
  "/mtf-analysis",
  async (req, res) => {

    try {

      const [
        candles1H,
        candles15M,
        candles5M
      ] = await Promise.all([

        getGoldCandles(
          "1h",
          200
        ),

        getGoldCandles(
          "15min",
          200
        ),

        getGoldCandles(
          "5min",
          200
        )
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


      const trend1H =
        analysis1H.trend;

      const trend15M =
        analysis15M.trend;

      const trend5M =
        analysis5M.trend;


      let alignment =
        "Mixed MTF";

      if (
        trend1H.includes("Bullish") &&
        trend15M.includes("Bullish") &&
        trend5M.includes("Bullish")
      ) {

        alignment =
          "Bullish MTF Alignment";
      }

      else if (
        trend1H.includes("Bearish") &&
        trend15M.includes("Bearish") &&
        trend5M.includes("Bearish")
      ) {

        alignment =
          "Bearish MTF Alignment";
      }


      // --------------------------------------------------------
      // MTF STRUCTURE SUMMARY
      // --------------------------------------------------------

      const bullishStructureCount =
        [
          analysis1H,
          analysis15M,
          analysis5M
        ]
          .filter(
            a =>
              a.marketStructure.structure ===
              "Bullish Structure"
          )
          .length;


      const bearishStructureCount =
        [
          analysis1H,
          analysis15M,
          analysis5M
        ]
          .filter(
            a =>
              a.marketStructure.structure ===
              "Bearish Structure"
          )
          .length;


      let structureBias =
        "Neutral";

      if (
        bearishStructureCount >= 2
      ) {

        structureBias =
          "Bearish";
      }

      else if (
        bullishStructureCount >= 2
      ) {

        structureBias =
          "Bullish";
      }


      // --------------------------------------------------------
      // HTF BOS
      // --------------------------------------------------------

      const HTFBOS =
        analysis1H.BOS !== "None"
          ? analysis1H.BOS
          : analysis15M.BOS !== "None"
            ? analysis15M.BOS
            : "None";


      // --------------------------------------------------------
      // LTF CONFIRMATION
      // --------------------------------------------------------

      const LTFBOS =
        analysis5M.BOS;


      let entryConfirmation =
        "Waiting";


      if (
        alignment ===
          "Bullish MTF Alignment" &&
        LTFBOS ===
          "Bullish BOS"
      ) {

        entryConfirmation =
          "Bullish structure confirmation";
      }


      else if (
        alignment ===
          "Bearish MTF Alignment" &&
        LTFBOS ===
          "Bearish BOS"
      ) {

        entryConfirmation =
          "Bearish structure confirmation";
      }


      // --------------------------------------------------------
      // MTF SUMMARY
      // --------------------------------------------------------

      const latest5M =
        analysis5M.currentClosedCandle;


      const support =
        analysis5M
          .supportResistance
          .nearestSupport;


      const resistance =
        analysis5M
          .supportResistance
          .nearestResistance;


      res.json({

        success: true,

        instrument:
          "XAUUSD",


        MTF: {

          "1H":
            trend1H,

          "15M":
            trend15M,

          "5M":
            trend5M,

          alignment
        },


        MTF_STRUCTURE: {

          "1H":
            analysis1H
              .marketStructure
              .structure,

          "15M":
            analysis15M
              .marketStructure
              .structure,

          "5M":
            analysis5M
              .marketStructure
              .structure,

          structureBias
        },


        MTF_CONFIRMATION: {

          HTF_BOS:
            HTFBOS,

          LTF_BOS:
            LTFBOS,

          entryConfirmation
        },


        importantLevels: {

          currentPrice:
            latest5M.close,

          support,

          nextSupport:
            analysis5M
              .supportResistance
              .nextSupport,

          resistance,

          nextResistance:
            analysis5M
              .supportResistance
              .nextResistance
        },


        analysis: {

          "1H":
            analysis1H,

          "15M":
            analysis15M,

          "5M":
            analysis5M
        }

      });

    }

    catch (error) {

      res.status(500).json({

        success: false,

        error:
          error.message
      });
    }
  }
);


// ============================================================
// GOLD RAW DATA
// ============================================================

app.get(
  "/gold-data",
  async (req, res) => {

    try {

      const candles =
        await getGoldCandles(
          "5min",
          50
        );


      res.json({

        success: true,

        instrument:
          "XAUUSD",

        interval:
          "5min",

        candles
      });

    }

    catch (error) {

      res.status(500).json({

        success: false,

        error:
          error.message
      });
    }
  }
);


// ============================================================
// GEMINI TEST
// ============================================================

app.get(
  "/gemini-test",
  async (req, res) => {

    try {

      if (!GEMINI_API_KEY) {

        return res.status(500).json({

          success: false,

          error:
            "GEMINI_API_KEY is not configured"
        });
      }


      const response =
        await fetch(
          "https://generativelanguage.googleapis.com/v1beta/interactions",
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

                model:
                  "gemini-3.8-flash",

                input:
                  "Reply with exactly: GEMINI CONNECTION OK"
              })
          }
        );


      const data =
        await response.json();


      if (!response.ok) {

        return res.status(502).json(
          data
        );
      }


      const answer =
        data.steps
          ?.find(
            s =>
              s.type ===
              "model_output"
          )
          ?.content
          ?.find(
            c =>
              c.type ===
              "text"
          )
          ?.text ||
        "No output returned";


      res.json({

        success: true,

        answer
      });

    }

    catch (error) {

      res.status(500).json({

        success: false,

        error:
          error.message
      });
    }
  }
);


// ============================================================
// GEMINI AI ANALYSIS
// ============================================================

app.get(
  "/analyze",
  async (req, res) => {

    try {

      if (!GEMINI_API_KEY) {

        return res.status(500).json({

          success: false,

          error:
            "GEMINI_API_KEY is not configured"
        });
      }


      const candles =
        await getGoldCandles(
          "5min",
          100
        );


      const candleText =
        candles
          .map(
            c =>
              `${c.time} | ` +
              `O:${c.open} ` +
              `H:${c.high} ` +
              `L:${c.low} ` +
              `C:${c.close}`
          )
          .join("\n");


      const prompt = `

You are an advanced XAUUSD Gold market analysis AI.

Analyze ONLY the supplied OHLC data.

Do not invent:
- prices
- indicators
- volume
- liquidity
- patterns
- structure
- news

Instrument: XAUUSD
Timeframe: 5 minutes

Analyze:

1. Market Bias
2. HH / HL / LH / LL
3. Market Structure
4. BOS
5. CHoCH
6. MSS
7. Liquidity
8. Equal Highs / Equal Lows
9. Liquidity Sweeps
10. Support
11. Resistance
12. Supply
13. Demand
14. Order Blocks
15. Fair Value Gaps
16. Displacement
17. Price Action
18. Candlestick Patterns
19. EMA trend
20. RSI momentum
21. MACD
22. ATR
23. Volume only if available
24. Key Levels
25. Bullish Scenario
26. Bearish Scenario
27. Possible Entry Zone
28. Stop Loss Zone
29. Take Profit Zones
30. Invalidation
31. Risk Warning

Important:

- Clearly separate confirmed observations from interpretations.
- If data is insufficient, say "Insufficient data".
- Do not claim a trade is guaranteed.
- Do not treat a forming candle as a confirmed BOS.
- Prefer closed candle confirmation.
- Explain why each BOS/CHoCH/MSS/sweep is identified.

Return:

Market Bias:
Market Structure:
BOS:
CHoCH:
MSS:
Liquidity:
Support:
Resistance:
Supply/Demand:
Order Block:
FVG:
Displacement:
Price Action:
Candlestick:
EMA:
RSI:
MACD:
ATR:
Volume:
Key Levels:

Bullish Scenario:
Bearish Scenario:

Possible Entry Zone:
Stop Loss:
Take Profit:
Invalidation:

Risk Warning:

GOLD OHLC DATA:

${candleText}
`;


      const response =
        await fetch(
          "https://generativelanguage.googleapis.com/v1beta/interactions",
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

                model:
                  "gemini-3.8-flash",

                input:
                  prompt
              })
          }
        );


      const data =
        await response.json();


      if (!response.ok) {

        return res.status(502).json(
          data
        );
      }


      const answer =
        data.steps
          ?.find(
            s =>
              s.type ===
              "model_output"
          )
          ?.content
          ?.find(
            c =>
              c.type ===
              "text"
          )
          ?.text ||
        "No analysis returned";


      res.json({

        success: true,

        instrument:
          "XAUUSD",

        timeframe:
          "5min",

        candles_used:
          candles.length,

        answer
      });

    }

    catch (error) {

      res.status(500).json({

        success: false,

        error:
          error.message
      });
    }
  }
);


// ============================================================
// SERVER
// ============================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "XAU AI BOT running on port " +
      PORT
    );
  }
);

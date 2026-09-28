import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;

const SYMBOL = "XAU/USD";

// =====================================================
// BASIC
// =====================================================

app.get("/", (req, res) => {
  res.send("XAU AI BOT IS ONLINE");
});

// =====================================================
// GEMINI TEST
// =====================================================

app.get("/gemini-test", async (req, res) => {
  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/interactions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY
        },
        body: JSON.stringify({
          model: "gemini-3.8-flash",
          input: "Reply with exactly: GEMINI CONNECTION OK"
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(502).json(data);
    }

    const answer =
      data.steps
        ?.find(s => s.type === "model_output")
        ?.content
        ?.find(c => c.type === "text")
        ?.text || "No output returned";

    res.json({
      success: true,
      answer
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// =====================================================
// TWELVE DATA
// =====================================================

async function getGoldCandles(interval = "5min", outputsize = 200) {
  const response = await fetch(
    `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(
      SYMBOL
    )}&interval=${interval}&outputsize=${outputsize}&apikey=${TWELVE_DATA_API_KEY}`
  );

  const data = await response.json();

  if (!response.ok || data.status === "error") {
    throw new Error(
      `Twelve Data error: ${JSON.stringify(data)}`
    );
  }

  if (!data.values || !Array.isArray(data.values)) {
    throw new Error("No candle data returned");
  }

  return data.values
    .map(c => ({
      time: c.datetime,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume:
        c.volume !== undefined &&
        c.volume !== null &&
        c.volume !== ""
          ? Number(c.volume)
          : null
    }))
    .reverse();
}

// =====================================================
// EMA
// =====================================================

function calculateEMA(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);

  let ema =
    values
      .slice(0, period)
      .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    ema =
      (values[i] - ema) * multiplier + ema;
  }

  return ema;
}

function calculateEMASeries(values, period) {
  if (values.length < period) return [];

  const multiplier = 2 / (period + 1);

  let ema =
    values
      .slice(0, period)
      .reduce((a, b) => a + b, 0) / period;

  const result = Array(period - 1).fill(null);

  result.push(ema);

  for (let i = period; i < values.length; i++) {
    ema =
      (values[i] - ema) * multiplier + ema;

    result.push(ema);
  }

  return result;
}

// =====================================================
// RSI
// =====================================================

function calculateRSI(values, period = 14) {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }

  let averageGain = gains / period;
  let averageLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    averageGain =
      (averageGain * (period - 1) + gain) /
      period;

    averageLoss =
      (averageLoss * (period - 1) + loss) /
      period;
  }

  if (averageLoss === 0) return 100;

  const rs = averageGain / averageLoss;

  return 100 - 100 / (1 + rs);
}

// =====================================================
// MACD 12 / 26 / 9
// =====================================================

function calculateMACD(values) {
  const ema12 = calculateEMASeries(values, 12);
  const ema26 = calculateEMASeries(values, 26);

  const macdSeries = [];

  for (let i = 0; i < values.length; i++) {
    if (
      ema12[i] !== null &&
      ema26[i] !== null
    ) {
      macdSeries.push(
        ema12[i] - ema26[i]
      );
    } else {
      macdSeries.push(null);
    }
  }

  const validMACD =
    macdSeries.filter(v => v !== null);

  const signalSeries =
    calculateEMASeries(validMACD, 9);

  const macdLine =
    macdSeries[macdSeries.length - 1];

  const signal =
    signalSeries.length
      ? signalSeries[signalSeries.length - 1]
      : null;

  const histogram =
    macdLine !== null &&
    signal !== null
      ? macdLine - signal
      : null;

  let direction = "Neutral";

  if (macdLine !== null && signal !== null) {
    if (macdLine > signal)
      direction = "Bullish";

    if (macdLine < signal)
      direction = "Bearish";
  }

  return {
    MACDLine: macdLine,
    signal,
    histogram,
    direction
  };
}

// =====================================================
// ATR
// =====================================================

function calculateATR(candles, period = 14) {
  if (candles.length <= period) return null;

  const tr = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    tr.push(
      Math.max(
        current.high - current.low,
        Math.abs(
          current.high - previous.close
        ),
        Math.abs(
          current.low - previous.close
        )
      )
    );
  }

  let atr =
    tr.slice(0, period)
      .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < tr.length; i++) {
    atr =
      (atr * (period - 1) + tr[i]) /
      period;
  }

  return atr;
}

// =====================================================
// SWINGS
// =====================================================

function findSwings(candles) {
  const swingHighs = [];
  const swingLows = [];

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
      swingHighs.push({
        time: c.time,
        price: c.high
      });
    }

    if (
      c.low < candles[i - 1].low &&
      c.low < candles[i - 2].low &&
      c.low < candles[i + 1].low &&
      c.low < candles[i + 2].low
    ) {
      swingLows.push({
        time: c.time,
        price: c.low
      });
    }
  }

  return {
    swingHighs,
    swingLows
  };
}

// =====================================================
// MARKET STRUCTURE
// =====================================================

function calculateMarketStructure(
  swingHighs,
  swingLows
) {
  if (
    swingHighs.length < 2 ||
    swingLows.length < 2
  ) {
    return {
      classification: "Insufficient data",
      details: {}
    };
  }

  const latestHigh =
    swingHighs[swingHighs.length - 1];

  const previousHigh =
    swingHighs[swingHighs.length - 2];

  const latestLow =
    swingLows[swingLows.length - 1];

  const previousLow =
    swingLows[swingLows.length - 2];

  const higherHigh =
    latestHigh.price > previousHigh.price;

  const lowerHigh =
    latestHigh.price < previousHigh.price;

  const higherLow =
    latestLow.price > previousLow.price;

  const lowerLow =
    latestLow.price < previousLow.price;

  let classification =
    "Range / Mixed Structure";

  if (higherHigh && higherLow)
    classification = "Bullish Structure";

  if (lowerHigh && lowerLow)
    classification = "Bearish Structure";

  return {
    classification,
    details: {
      latestHigh,
      previousHigh,
      latestLow,
      previousLow,
      higherHigh,
      lowerHigh,
      higherLow,
      lowerLow
    }
  };
}

// =====================================================
// BOS
// =====================================================

function calculateBOS(
  candles,
  swingHighs,
  swingLows
) {
  const latest =
    candles[candles.length - 1];

  const lastHigh =
    swingHighs[swingHighs.length - 1];

  const lastLow =
    swingLows[swingLows.length - 1];

  if (
    lastHigh &&
    latest.close > lastHigh.price
  ) {
    return {
      signal: "Bullish BOS",
      reason:
        `Latest close ${latest.close} is above swing high ${lastHigh.price}`
    };
  }

  if (
    lastLow &&
    latest.close < lastLow.price
  ) {
    return {
      signal: "Bearish BOS",
      reason:
        `Latest close ${latest.close} is below swing low ${lastLow.price}`
    };
  }

  return {
    signal: "None",
    reason: "No confirmed BOS"
  };
}

// =====================================================
// CHOCH + MSS
// =====================================================

function calculateCHoCHMSS(
  candles,
  swingHighs,
  swingLows
) {
  const latest =
    candles[candles.length - 1];

  if (
    swingHighs.length < 2 ||
    swingLows.length < 2
  ) {
    return {
      CHoCH: {
        signal: "None",
        reason: "Insufficient data"
      },
      MSS: {
        signal: "None",
        reason: "Insufficient data"
      }
    };
  }

  const lastHigh =
    swingHighs[swingHighs.length - 1];

  const previousHigh =
    swingHighs[swingHighs.length - 2];

  const lastLow =
    swingLows[swingLows.length - 1];

  const previousLow =
    swingLows[swingLows.length - 2];

  let CHoCH = "None";
  let MSS = "None";

  let chochReason =
    "No confirmed CHoCH";

  let mssReason =
    "No confirmed MSS";

  if (
    lastLow.price < previousLow.price &&
    latest.close > lastHigh.price
  ) {
    CHoCH = "Bullish CHoCH";
    MSS = "Bullish MSS";

    chochReason =
      "Lower low followed by break above latest swing high.";

    mssReason =
      "Bearish structure followed by bullish break.";
  }

  if (
    lastHigh.price > previousHigh.price &&
    latest.close < lastLow.price
  ) {
    CHoCH = "Bearish CHoCH";
    MSS = "Bearish MSS";

    chochReason =
      "Higher high followed by break below latest swing low.";

    mssReason =
      "Bullish structure followed by bearish break.";
  }

  return {
    CHoCH: {
      signal: CHoCH,
      reason: chochReason
    },
    MSS: {
      signal: MSS,
      reason: mssReason
    }
  };
}

// =====================================================
// LIQUIDITY
// =====================================================

function calculateLiquidity(
  candles,
  swingHighs,
  swingLows
) {
  const latest =
    candles[candles.length - 1];

  const previousHigh =
    swingHighs[swingHighs.length - 2];

  const previousLow =
    swingLows[swingLows.length - 2];

  let sweep = "None";

  let sweepReason =
    "No confirmed liquidity sweep.";

  if (
    previousHigh &&
    latest.high > previousHigh.price &&
    latest.close < previousHigh.price
  ) {
    sweep = "Buy-side liquidity sweep";

    sweepReason =
      "Price swept a previous swing high and closed below it.";
  }

  if (
    previousLow &&
    latest.low < previousLow.price &&
    latest.close > previousLow.price
  ) {
    sweep = "Sell-side liquidity sweep";

    sweepReason =
      "Price swept a previous swing low and closed above it.";
  }

  const equalHighs = [];
  const equalLows = [];

  const tolerance =
    latest.close * 0.00015;

  for (
    let i = 0;
    i < swingHighs.length;
    i++
  ) {
    for (
      let j = i + 1;
      j < swingHighs.length;
      j++
    ) {
      if (
        Math.abs(
          swingHighs[i].price -
          swingHighs[j].price
        ) <= tolerance
      ) {
        equalHighs.push({
          price:
            (
              swingHighs[i].price +
              swingHighs[j].price
            ) / 2,
          firstTime:
            swingHighs[i].time,
          secondTime:
            swingHighs[j].time,
          type:
            "Equal High Liquidity"
        });
      }
    }
  }

  for (
    let i = 0;
    i < swingLows.length;
    i++
  ) {
    for (
      let j = i + 1;
      j < swingLows.length;
      j++
    ) {
      if (
        Math.abs(
          swingLows[i].price -
          swingLows[j].price
        ) <= tolerance
      ) {
        equalLows.push({
          price:
            (
              swingLows[i].price +
              swingLows[j].price
            ) / 2,
          firstTime:
            swingLows[i].time,
          secondTime:
            swingLows[j].time,
          type:
            "Equal Low Liquidity"
        });
      }
    }
  }

  return {
    sweep,
    sweepReason,
    equalHighs: equalHighs.slice(-10),
    equalLows: equalLows.slice(-10)
  };
}

// =====================================================
// PRICE ACTION + CANDLE PATTERNS
// =====================================================

function calculatePriceAction(candles) {
  const latest =
    candles[candles.length - 1];

  const previous =
    candles[candles.length - 2];

  const range =
    latest.high - latest.low;

  const body =
    Math.abs(
      latest.close - latest.open
    );

  const upperWick =
    latest.high -
    Math.max(
      latest.open,
      latest.close
    );

  const lowerWick =
    Math.min(
      latest.open,
      latest.close
    ) -
    latest.low;

  let candleStrength = "Normal";

  if (range > 0) {
    const ratio = body / range;

    if (ratio >= 0.70)
      candleStrength =
        "Strong Displacement";
    else if (ratio >= 0.50)
      candleStrength = "Moderate";
    else
      candleStrength =
        "Weak / Indecision";
  }

  const candleDirection =
    latest.close > latest.open
      ? "Bullish"
      : latest.close < latest.open
        ? "Bearish"
        : "Doji";

  const patterns = [];

  if (
    range > 0 &&
    body / range <= 0.10
  ) {
    patterns.push("Doji");
  }

  if (
    previous.close < previous.open &&
    latest.close > latest.open &&
    latest.open <= previous.close &&
    latest.close >= previous.open
  ) {
    patterns.push("Bullish Engulfing");
  }

  if (
    previous.close > previous.open &&
    latest.close < latest.open &&
    latest.open >= previous.close &&
    latest.close <= previous.open
  ) {
    patterns.push("Bearish Engulfing");
  }

  if (
    lowerWick > body * 2 &&
    upperWick <= body
  ) {
    patterns.push("Bullish Pin Bar");
  }

  if (
    upperWick > body * 2 &&
    lowerWick <= body
  ) {
    patterns.push("Bearish Pin Bar");
  }

  if (!patterns.length)
    patterns.push(
      "No major pattern detected"
    );

  return {
    candleDirection,
    candleStrength,
    range,
    body,
    upperWick,
    lowerWick,
    patterns
  };
}

// =====================================================
// FVG
// =====================================================

function calculateFVG(candles) {
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

// =====================================================
// ORDER BLOCKS
// =====================================================

function calculateOrderBlocks(candles) {
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

// =====================================================
// SUPPLY / DEMAND
// =====================================================

function calculateSupplyDemand(candles) {
  const supply = [];
  const demand = [];

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
      previous.close > previous.open &&
      current.close < current.open &&
      current.close < previous.low
    ) {
      supply.push({
        time: previous.time,
        low: previous.low,
        high: previous.high,
        type: "Supply Zone"
      });
    }

    if (
      previous.close < previous.open &&
      current.close > current.open &&
      current.close > previous.high
    ) {
      demand.push({
        time: previous.time,
        low: previous.low,
        high: previous.high,
        type: "Demand Zone"
      });
    }
  }

  return {
    supply: supply.slice(-10),
    demand: demand.slice(-10)
  };
}

// =====================================================
// CLASSIC PATTERNS
// =====================================================

function detectClassicPatterns(candles) {
  const patterns = [];

  if (candles.length < 20) {
    return {
      detected: [],
      note: "Insufficient data"
    };
  }

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  // Double top / bottom approximation
  const highs = [];
  const lows = [];

  for (
    let i = candles.length - 20;
    i < candles.length - 2;
    i++
  ) {
    highs.push(candles[i].high);
    lows.push(candles[i].low);
  }

  const recentHigh =
    Math.max(...highs);

  const recentLow =
    Math.min(...lows);

  const highTolerance =
    recentHigh * 0.0015;

  const lowTolerance =
    recentLow * 0.0015;

  let similarHighCount = 0;
  let similarLowCount = 0;

  for (const h of highs) {
    if (
      Math.abs(h - recentHigh) <=
      highTolerance
    ) {
      similarHighCount++;
    }
  }

  for (const l of lows) {
    if (
      Math.abs(l - recentLow) <=
      lowTolerance
    ) {
      similarLowCount++;
    }
  }

  if (similarHighCount >= 2) {
    patterns.push({
      pattern:
        "Possible Double Top Area",
      reason:
        "Multiple highs are clustered near a recent high."
    });
  }

  if (similarLowCount >= 2) {
    patterns.push({
      pattern:
        "Possible Double Bottom Area",
      reason:
        "Multiple lows are clustered near a recent low."
    });
  }

  // Simple inside bar
  if (
    last.high <= prev.high &&
    last.low >= prev.low
  ) {
    patterns.push({
      pattern: "Inside Bar",
      reason:
        "Latest candle is contained inside previous candle."
    });
  }

  return {
    detected: patterns
  };
}

// =====================================================
// TREND
// =====================================================

function calculateTrend(
  EMA9,
  EMA21,
  EMA50,
  RSI14,
  latest
) {
  let trend = "Neutral";

  if (
    EMA9 &&
    EMA21 &&
    EMA50
  ) {
    if (
      EMA9 > EMA21 &&
      EMA21 > EMA50 &&
      latest.close > EMA9
    ) {
      trend = "Strong Bullish";
    }

    else if (
      EMA9 < EMA21 &&
      EMA21 < EMA50 &&
      latest.close < EMA9
    ) {
      trend = "Strong Bearish";
    }

    else if (EMA9 > EMA21) {
      trend = "Bullish";
    }

    else if (EMA9 < EMA21) {
      trend = "Bearish";
    }
  }

  let momentum = "Neutral";

  if (RSI14 !== null) {
    if (RSI14 >= 70)
      momentum = "Overbought";
    else if (RSI14 <= 30)
      momentum = "Oversold";
    else if (RSI14 > 55)
      momentum = "Bullish Momentum";
    else if (RSI14 < 45)
      momentum = "Bearish Momentum";
  }

  return {
    trend,
    momentum
  };
}

// =====================================================
// ADVANCED SMC SCORE
// =====================================================

function calculateSMCContext(data) {
  let bullishScore = 0;
  let bearishScore = 0;

  if (
    data.marketStructure.classification ===
    "Bullish Structure"
  ) {
    bullishScore++;
  }

  if (
    data.marketStructure.classification ===
    "Bearish Structure"
  ) {
    bearishScore++;
  }

  if (
    data.BOS.signal ===
    "Bullish BOS"
  ) {
    bullishScore += 2;
  }

  if (
    data.BOS.signal ===
    "Bearish BOS"
  ) {
    bearishScore += 2;
  }

  if (
    data.CHoCH.signal ===
    "Bullish CHoCH"
  ) {
    bullishScore += 2;
  }

  if (
    data.CHoCH.signal ===
    "Bearish CHoCH"
  ) {
    bearishScore += 2;
  }

  if (
    data.MSS.signal ===
    "Bullish MSS"
  ) {
    bullishScore += 2;
  }

  if (
    data.MSS.signal ===
    "Bearish MSS"
  ) {
    bearishScore += 2;
  }

  if (
    data.liquidity.sweep ===
    "Sell-side liquidity sweep"
  ) {
    bullishScore++;
  }

  if (
    data.liquidity.sweep ===
    "Buy-side liquidity sweep"
  ) {
    bearishScore++;
  }

  if (
    data.trend ===
    "Strong Bullish"
  ) {
    bullishScore++;
  }

  if (
    data.trend ===
    "Strong Bearish"
  ) {
    bearishScore++;
  }

  if (
    data.MACD.direction ===
    "Bullish"
  ) {
    bullishScore++;
  }

  if (
    data.MACD.direction ===
    "Bearish"
  ) {
    bearishScore++;
  }

  return {
    bullishScore,
    bearishScore,

    totalScore:
      bullishScore +
      bearishScore,

    context:
      bullishScore > bearishScore
        ? "Bullish Context"
        : bearishScore > bullishScore
          ? "Bearish Context"
          : "Mixed Context"
  };
}

// =====================================================
// FULL TECHNICAL ENGINE
// =====================================================

function buildTechnicalAnalysis(
  candles,
  timeframe
) {
  const latest =
    candles[candles.length - 1];

  const closes =
    candles.map(c => c.close);

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
    calculateATR(candles, 14);

  const {
    swingHighs,
    swingLows
  } = findSwings(candles);

  const marketStructure =
    calculateMarketStructure(
      swingHighs,
      swingLows
    );

  const BOS =
    calculateBOS(
      candles,
      swingHighs,
      swingLows
    );

  const {
    CHoCH,
    MSS
  } =
    calculateCHoCHMSS(
      candles,
      swingHighs,
      swingLows
    );

  const liquidity =
    calculateLiquidity(
      candles,
      swingHighs,
      swingLows
    );

  const priceAction =
    calculatePriceAction(
      candles
    );

  const fvg =
    calculateFVG(candles);

  const orderBlocks =
    calculateOrderBlocks(candles);

  const supplyDemand =
    calculateSupplyDemand(candles);

  const classicPatterns =
    detectClassicPatterns(candles);

  const {
    trend,
    momentum
  } =
    calculateTrend(
      EMA9,
      EMA21,
      EMA50,
      RSI14,
      latest
    );

  const support =
    swingLows
      .slice(-10)
      .map(x => x.price);

  const resistance =
    swingHighs
      .slice(-10)
      .map(x => x.price);

  const supportsBelow =
    support.filter(
      x => x < latest.close
    );

  const resistancesAbove =
    resistance.filter(
      x => x > latest.close
    );

  const nearestSupport =
    supportsBelow.length
      ? Math.max(...supportsBelow)
      : null;

  const nearestResistance =
    resistancesAbove.length
      ? Math.min(...resistancesAbove)
      : null;

  const volumeAvailable =
    candles.some(
      c =>
        c.volume !== null &&
        !Number.isNaN(c.volume)
    );

  let volumeAnalysis =
    "Insufficient data";

  if (volumeAvailable) {
    const volumes =
      candles
        .map(c => c.volume)
        .filter(v => v !== null);

    const latestVolume =
      volumes[volumes.length - 1];

    const average =
      volumes
        .slice(-20)
        .reduce(
          (a, b) => a + b,
          0
        ) /
      Math.min(
        20,
        volumes.length
      );

    if (
      latestVolume >
      average * 1.5
    ) {
      volumeAnalysis =
        "High volume";
    }

    else if (
      latestVolume <
      average * 0.7
    ) {
      volumeAnalysis =
        "Low volume";
    }

    else {
      volumeAnalysis =
        "Normal volume";
    }
  }

  const displacement =
    priceAction.candleDirection ===
      "Bullish"
      ? "Bullish Displacement"
      : priceAction.candleDirection ===
          "Bearish"
        ? "Bearish Displacement"
        : "Neutral";

  const result = {
    success: true,

    instrument: "XAUUSD",

    timeframe,

    candlesUsed:
      candles.length,

    current: latest,

    marketStructure,

    latestSwingHigh:
      swingHighs[swingHighs.length - 1] ||
      null,

    latestSwingLow:
      swingLows[swingLows.length - 1] ||
      null,

    BOS,

    CHoCH,

    MSS,

    liquidity,

    displacement: {
      status: displacement,
      candleStrength:
        priceAction.candleStrength,
      candleDirection:
        priceAction.candleDirection,
      range:
        priceAction.range,
      body:
        priceAction.body
    },

    priceAction,

    classicPatterns,

    trend,

    momentum,

    EMA: {
      EMA9,
      EMA21,
      EMA50
    },

    RSI14,

    MACD,

    ATR14,

    volume: {
      available:
        volumeAvailable,
      analysis:
        volumeAnalysis
    },

    support,

    resistance,

    keyLevels: {
      currentPrice:
        latest.close,
      nearestSupport,
      nearestResistance,
      ATR14
    },

    supplyDemand,

    fvg,

    orderBlocks,

    swingHighs:
      swingHighs.slice(-15),

    swingLows:
      swingLows.slice(-15)
  };

  result.SMC =
    calculateSMCContext(
      result
    );

  return result;
}

// =====================================================
// TECHNICAL ANALYSIS
// =====================================================

app.get("/technical-analysis", async (req, res) => {
  try {
    const candles =
      await getGoldCandles(
        "5min",
        200
      );

    res.json(
      buildTechnicalAnalysis(
        candles,
        "5M"
      )
    );

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// =====================================================
// MTF ANALYSIS
// =====================================================

app.get("/mtf-analysis", async (req, res) => {
  try {
    const [
      candles1H,
      candles15M,
      candles5M
    ] = await Promise.all([
      getGoldCandles("1h", 200),
      getGoldCandles("15min", 200),
      getGoldCandles("5min", 200)
    ]);

    const H1 =
      buildTechnicalAnalysis(
        candles1H,
        "1H"
      );

    const M15 =
      buildTechnicalAnalysis(
        candles15M,
        "15M"
      );

    const M5 =
      buildTechnicalAnalysis(
        candles5M,
        "5M"
      );

    function direction(a) {
      if (
        a.trend === "Bullish" ||
        a.trend === "Strong Bullish"
      ) {
        return "Bullish";
      }

      if (
        a.trend === "Bearish" ||
        a.trend === "Strong Bearish"
      ) {
        return "Bearish";
      }

      return "Neutral";
    }

    const d1H = direction(H1);
    const d15M = direction(M15);
    const d5M = direction(M5);

    let alignment = "Mixed";

    if (
      d1H === "Bullish" &&
      d15M === "Bullish" &&
      d5M === "Bullish"
    ) {
      alignment =
        "Bullish MTF Alignment";
    }

    if (
      d1H === "Bearish" &&
      d15M === "Bearish" &&
      d5M === "Bearish"
    ) {
      alignment =
        "Bearish MTF Alignment";
    }

    res.json({
      success: true,

      instrument: "XAUUSD",

      MTF: {
        "1H": d1H,
        "15M": d15M,
        "5M": d5M,
        alignment
      },

      analysis: {
        "1H": H1,
        "15M": M15,
        "5M": M5
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// =====================================================
// GOLD DATA
// =====================================================

app.get("/gold-data", async (req, res) => {
  try {
    const candles =
      await getGoldCandles(
        "5min",
        200
      );

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

// =====================================================
// STEP 10 - AI COMPREHENSIVE ANALYSIS
// =====================================================

app.get("/analyze", async (req, res) => {
  try {
    const [
      candles1H,
      candles15M,
      candles5M
    ] = await Promise.all([
      getGoldCandles("1h", 200),
      getGoldCandles("15min", 200),
      getGoldCandles("5min", 200)
    ]);

    const H1 =
      buildTechnicalAnalysis(
        candles1H,
        "1H"
      );

    const M15 =
      buildTechnicalAnalysis(
        candles15M,
        "15M"
      );

    const M5 =
      buildTechnicalAnalysis(
        candles5M,
        "5M"
      );

    const prompt = `
You are an advanced XAUUSD Gold market-analysis AI.

Analyze ONLY the technical data supplied below.

Do not invent:
- prices
- volume
- indicators
- patterns
- liquidity
- structure

Use:
1H = higher timeframe context
15M = intermediate structure
5M = execution context

Analyze:

1. MTF trend
2. Market structure
3. HH / HL / LH / LL
4. BOS
5. CHoCH
6. MSS
7. Liquidity
8. Equal highs
9. Equal lows
10. Liquidity sweeps
11. Support
12. Resistance
13. Supply
14. Demand
15. Order Blocks
16. Fair Value Gaps
17. Displacement
18. Price action
19. Candlestick patterns
20. Classic chart pattern indications
21. EMA
22. RSI
23. MACD
24. ATR
25. Volume if available
26. SMC context
27. Key levels
28. Bullish scenario
29. Bearish scenario
30. Possible entry zones
31. Stop-loss zone
32. Take-profit zones
33. Invalidation

IMPORTANT:

- Clearly separate confirmed observations from possible interpretations.
- If something cannot be confirmed, say "Insufficient data".
- Do not claim a trade is guaranteed.
- Do not invent volume.
- Use latest closed candle as reference.
- Explain the reason behind important structure signals.
- Higher timeframe context should be considered before lower timeframe signals.
- A lower timeframe signal against the higher timeframe trend should be identified as a counter-trend situation.
- Do not force an entry if conditions are unclear.

Return exactly:

================================
XAUUSD AI MARKET ANALYSIS
================================

CURRENT PRICE:

MTF TREND:
1H:
15M:
5M:

MTF ALIGNMENT:

================================
MARKET STRUCTURE
================================

1H Structure:
15M Structure:
5M Structure:

HH:
HL:
LH:
LL:

BOS:
CHoCH:
MSS:

================================
LIQUIDITY
================================

Buy-side Liquidity:
Sell-side Liquidity:
Equal Highs:
Equal Lows:
Latest Liquidity Sweep:

================================
SMC
================================

Order Blocks:
Fair Value Gaps:
Supply:
Demand:
Displacement:

SMC Context:

================================
PRICE ACTION
================================

Candlestick:
Classic Patterns:
Trend:
Momentum:

================================
INDICATORS
================================

EMA:
RSI:
MACD:
ATR:
Volume:

================================
KEY LEVELS
================================

Support:
Resistance:
Nearest Support:
Nearest Resistance:

================================
BULLISH SCENARIO
================================

Explain what would confirm bullish continuation/reversal.

================================
BEARISH SCENARIO
================================

Explain what would confirm bearish continuation/reversal.

================================
POSSIBLE SETUP
================================

Entry Zone:
Confirmation Required:
Stop Loss Zone:
Take Profit Zone 1:
Take Profit Zone 2:
Invalidation:

================================
FINAL MARKET STATE
================================

State whether the current technical picture is:

Bullish
Bearish
Mixed
or Neutral

Explain why.

================================
RISK WARNING
================================

Mention uncertainty and that market conditions can change.

================================
1H DATA
================================

${JSON.stringify(H1, null, 2)}

================================
15M DATA
================================

${JSON.stringify(M15, null, 2)}

================================
5M DATA
================================

${JSON.stringify(M5, null, 2)}
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

          body: JSON.stringify({
            model:
              "gemini-3.8-flash",
            input: prompt
          })
        }
      );

    const data =
      await response.json();

    if (!response.ok) {
      return res
        .status(502)
        .json(data);
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
      instrument: "XAUUSD",
      timeframes: [
        "1H",
        "15M",
        "5M"
      ],
      answer
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// =====================================================
// SERVER
// =====================================================

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

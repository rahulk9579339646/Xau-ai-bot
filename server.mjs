import express from "express";

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;
app.get("/", (req, res) => {
  res.send("XAU AI BOT IS ONLINE");
});

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
// -----------------------------
// Multi-Timeframe Data
// -----------------------------

const [response15m, response1h] = await Promise.all([
  fetch(
    `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=15min&outputsize=100&apikey=${TWELVE_DATA_API_KEY}`
  ),
  fetch(
    `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=1h&outputsize=100&apikey=${TWELVE_DATA_API_KEY}`
  )
]);

const data15m = await response15m.json();
const data1h = await response1h.json();

if (
  data15m.status === "error" ||
  data1h.status === "error"
) {
  return res.status(502).json({
    success: false,
    error: "Multi-timeframe data fetch failed",
    fifteenMinute: data15m,
    oneHour: data1h
  });
}


  }))
  .reverse();
    
    res.json({
      success: true,
      answer: data.steps?.find(s => s.type === "model_output")?.content?.find(c => c.type === "text")?.text || "No output returned"
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
app.get("/analyze", async (req, res) => {
  try {
    // 1. Get Gold 5-minute candles from Twelve Data
    const marketResponse = await fetch(
      `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=5min&outputsize=50&apikey=${TWELVE_DATA_API_KEY}`
    );

    const marketData = await marketResponse.json();

    if (!marketResponse.ok || marketData.status === "error") {
      return res.status(502).json({
        success: false,
        source: "Twelve Data",
        error: marketData
      });
    }

    // 2. Convert candles into readable text for Gemini
    const candles = marketData.values
      .map(c =>
        `${c.datetime} | O:${c.open} H:${c.high} L:${c.low} C:${c.close}`
      )
      .join("\n");

    // 3. Send market data to Gemini
    const prompt = `
You are an advanced XAUUSD Gold market analysis AI.

Analyze ONLY the market data provided below.
Do NOT invent prices, indicators, patterns, liquidity or market structure
that cannot reasonably be derived from the supplied OHLC candles.

Instrument: XAUUSD
Timeframe: 5 minutes

Analyze:

1. Market Bias
2. Market Structure
3. BOS / CHoCH / MSS
4. Liquidity and Liquidity Sweeps
5. Support
6. Resistance
7. Supply and Demand
8. Order Blocks
9. Fair Value Gaps
10. Price Action
11. Candlestick Patterns
12. Trend
13. EMA-style trend assessment from price data
14. RSI-style momentum assessment from price data
15. Volume - only if volume data is actually available
16. Key Levels
17. Bullish Scenario
18. Bearish Scenario
19. Possible Entry Zone
20. Stop Loss Zone
21. Take Profit Zones
22. Invalidation
23. Risk Warning

Important:
- Clearly separate confirmed observations from possible interpretations.
- If a condition cannot be determined from the available data, write "Insufficient data".
- Do not give false certainty.
- Do not claim that a trade is guaranteed.
- Use the latest candle as the current reference.
- Explain why a BOS, CHoCH, MSS, liquidity sweep, OB or FVG is identified.

Return the analysis in this exact format:

Market Bias:
Market Structure:
BOS/CHoCH/MSS:
Liquidity:
Support:
Resistance:
Supply/Demand:
Order Block:
FVG:
Price Action:
Candlestick:
Trend:
EMA:
RSI/Momentum:
Volume:
Key Levels:

Bullish Scenario:
Bearish Scenario:

Possible Entry Zone:
Stop Loss:
Take Profit:
Invalidation:

Risk Warning:

GOLD 5-MINUTE OHLC DATA:
${candles}
`;

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
          input: prompt
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
        ?.text || "No analysis returned";

    res.json({
      success: true,
      instrument: "XAUUSD",
      timeframe: "5min",
      candles_used: marketData.values.length,
      answer
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
app.get("/gold-data", async (req, res) => {
  try {
    const response = await fetch(
      `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=5min&outputsize=50&apikey=${TWELVE_DATA_API_KEY}`
    );

    const data = await response.json();

    if (!response.ok || data.status === "error") {
      return res.status(502).json(data);
    }

    res.json({
      success: true,
      instrument: "XAUUSD",
      interval: "5min",
      candles: data.values
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
app.get("/technical-analysis", async (req, res) => {
  try {
    const response = await fetch(
      `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=5min&outputsize=50&apikey=${TWELVE_DATA_API_KEY}`
    );

    const data = await response.json();

    if (!response.ok || data.status === "error") {
      return res.status(502).json({
        success: false,
        source: "Twelve Data",
        error: data
      });
    }

    const candles = data.values
      .map(c => ({
        time: c.datetime,
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close)
      }))
      .reverse();

    // -----------------------------
    // Swing High / Swing Low
    // -----------------------------

    const swingHighs = [];
    const swingLows = [];

    for (let i = 2; i < candles.length - 2; i++) {

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

    const latest = candles[candles.length - 1];
// -----------------------------
// EMA Calculation
// -----------------------------

function calculateEMA(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);

  let ema =
    values
      .slice(0, period)
      .reduce((sum, value) => sum + value, 0) / period;

  for (let i = period; i < values.length; i++) {
    ema =
      (values[i] - ema) * multiplier + ema;
  }

  return ema;
}

const closes = candles.map(c => c.close);
    
const EMA9 = calculateEMA(closes, 9);
const EMA21 = calculateEMA(closes, 21);
const EMA50 = calculateEMA(closes, 50);

// -----------------------------
// RSI Calculation
// -----------------------------

function calculateRSI(values, period = 14) {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    if (change > 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  let averageGain = gains / period;
  let averageLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    averageGain =
      (averageGain * (period - 1) + gain) / period;

    averageLoss =
      (averageLoss * (period - 1) + loss) / period;
  }

  if (averageLoss === 0) return 100;

  const RS = averageGain / averageLoss;

  return 100 - (100 / (1 + RS));
}

const RSI14 = calculateRSI(closes, 14);

// -----------------------------
// Trend
// -----------------------------

let trend = "Neutral";

if (EMA9 && EMA21 && EMA50) {

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

// -----------------------------
// RSI Momentum
// -----------------------------

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
    
    const previousSwingHigh =
      swingHighs[swingHighs.length - 1];

    const previousSwingLow =
      swingLows[swingLows.length - 1];

    // -----------------------------
    // BOS Detection
    // -----------------------------

    let BOS = "None";

    if (
      previousSwingHigh &&
      latest.close > previousSwingHigh.price
    ) {
      BOS = "Bullish BOS";
    }

    if (
      previousSwingLow &&
      latest.close < previousSwingLow.price
    ) {
      BOS = "Bearish BOS";
    }
// -----------------------------
// CHoCH / MSS Detection
// -----------------------------

let CHoCH = "None";
let MSS = "None";

if (swingHighs.length >= 2 && swingLows.length >= 2) {

  const lastHigh = swingHighs[swingHighs.length - 1];
  const previousHigh = swingHighs[swingHighs.length - 2];

  const lastLow = swingLows[swingLows.length - 1];
  const previousLow = swingLows[swingLows.length - 2];

  // Bearish structure -> Bullish change
  if (
    lastLow.price < previousLow.price &&
    latest.close > lastHigh.price
  ) {
    CHoCH = "Bullish CHoCH";
    MSS = "Bullish MSS";
  }

  // Bullish structure -> Bearish change
  if (
    lastHigh.price > previousHigh.price &&
    latest.close < lastLow.price
  ) {
    CHoCH = "Bearish CHoCH";
    MSS = "Bearish MSS";
  }
}

// -----------------------------
// Candle Strength / Displacement
// -----------------------------

const candleRange = latest.high - latest.low;
const candleBody = Math.abs(latest.close - latest.open);

let candleStrength = "Normal";

if (candleRange > 0) {

  const bodyRatio = candleBody / candleRange;

  if (bodyRatio >= 0.70) {
    candleStrength = "Strong Displacement";
  } else if (bodyRatio >= 0.50) {
    candleStrength = "Moderate";
  } else {
    candleStrength = "Weak / Indecision";
  }
}

const candleDirection =
  latest.close > latest.open
    ? "Bullish"
    : latest.close < latest.open
      ? "Bearish"
      : "Doji";
// -----------------------------
// Candlestick Pattern Detection
// -----------------------------

const body = Math.abs(latest.close - latest.open);
const upperWick = latest.high - Math.max(latest.open, latest.close);
const lowerWick = Math.min(latest.open, latest.close) - latest.low;

let candlestickPattern = "None";

// Doji
if (
  candleRange > 0 &&
  body / candleRange <= 0.10
) {
  candlestickPattern = "Doji";
}

// Hammer
else if (
  lowerWick >= body * 2 &&
  upperWick <= body &&
  latest.close >= latest.open
) {
  candlestickPattern = "Hammer";
}

// Shooting Star
else if (
  upperWick >= body * 2 &&
  lowerWick <= body &&
  latest.close <= latest.open
) {
  candlestickPattern = "Shooting Star";
}

// Bullish Engulfing
else if (candles.length >= 2) {

  const previous = candles[candles.length - 2];

  if (
    previous.close < previous.open &&
    latest.close > latest.open &&
    latest.open <= previous.close &&
    latest.close >= previous.open
  ) {
    candlestickPattern = "Bullish Engulfing";
  }
}

// Bearish Engulfing
if (candles.length >= 2) {

  const previous = candles[candles.length - 2];

  if (
    previous.close > previous.open &&
    latest.close < latest.open &&
    latest.open >= previous.close &&
    latest.close <= previous.open
  ) {
    candlestickPattern = "Bearish Engulfing";
  }
}

// Pin Bar
if (
  candleRange > 0 &&
  body / candleRange <= 0.30
) {

  if (lowerWick >= body * 2) {
    candlestickPattern = "Bullish Pin Bar";
  }

  else if (upperWick >= body * 2) {
    candlestickPattern = "Bearish Pin Bar";
  }
}
    
    // -----------------------------
    // Liquidity Sweep
    // -----------------------------

    let liquiditySweep = "None";

    if (
      previousSwingHigh &&
      latest.high > previousSwingHigh.price &&
      latest.close < previousSwingHigh.price
    ) {
      liquiditySweep = "Buy-side liquidity sweep";
    }

    if (
      previousSwingLow &&
      latest.low < previousSwingLow.price &&
      latest.close > previousSwingLow.price
    ) {
      liquiditySweep = "Sell-side liquidity sweep";
    }

    // -----------------------------
    // Support / Resistance
    // -----------------------------

    const support = swingLows
      .slice(-3)
      .map(x => x.price);

    const resistance = swingHighs
      .slice(-3)
      .map(x => x.price);
// -----------------------------
// Fair Value Gap (FVG)
// -----------------------------

const bullishFVGs = [];
const bearishFVGs = [];

for (let i = 2; i < candles.length; i++) {

  const first = candles[i - 2];
  const middle = candles[i - 1];
  const third = candles[i];

  // Bullish FVG
  if (third.low > first.high) {
    bullishFVGs.push({
      time: third.time,
      type: "Bullish FVG",
      lower: first.high,
      upper: third.low
    });
  }

  // Bearish FVG
  if (third.high < first.low) {
    bearishFVGs.push({
      time: third.time,
      type: "Bearish FVG",
      lower: third.high,
      upper: first.low
    });
  }
}

// -----------------------------
// Order Block
// -----------------------------

const bullishOrderBlocks = [];
const bearishOrderBlocks = [];

for (let i = 1; i < candles.length; i++) {

  const previous = candles[i - 1];
  const current = candles[i];

  // Previous bearish candle followed by strong bullish move
  if (
    previous.close < previous.open &&
    current.close > current.open &&
    current.close > previous.high
  ) {
    bullishOrderBlocks.push({
      time: previous.time,
      type: "Bullish Order Block",
      high: previous.high,
      low: previous.low
    });
  }

  // Previous bullish candle followed by strong bearish move
  if (
    previous.close > previous.open &&
    current.close < current.open &&
    current.close < previous.low
  ) {
    bearishOrderBlocks.push({
      time: previous.time,
      type: "Bearish Order Block",
      high: previous.high,
      low: previous.low
    });
  }
}
    
    res.json({
      success: true,
      instrument: "XAUUSD",
      timeframe: "5min",

      current: latest,

      marketStructure: {
        latestSwingHigh: previousSwingHigh || null,
        latestSwingLow: previousSwingLow || null
      },

      BOS,

      liquiditySweep,
CHoCH,

  MSS,
EMA: {
    EMA9,
    EMA21,
    EMA50
  },

  RSI14,

  trend,

  momentum,
      
  candleStrength,    
   
  candleDirection,

  candlestickPattern,
      
  candleRange,

  candleBody,
      
      support,

      resistance,
fvg: {
        bullish: bullishFVGs.slice(-5),
        bearish: bearishFVGs.slice(-5)
      },

      orderBlocks: {
        bullish: bullishOrderBlocks.slice(-5),
        bearish: bearishOrderBlocks.slice(-5)
      },
swingHighs: swingHighs.slice(-10),

swingLows: swingLows.slice(-10),

});
      
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port " + PORT);
});

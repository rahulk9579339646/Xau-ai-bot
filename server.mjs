import express from "express";

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;

// ======================================================
// BASIC
// ======================================================

app.get("/", (req, res) => {
  res.send("XAU AI BOT IS ONLINE");
});

// ======================================================
// GEMINI TEST
// ======================================================

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

    res.json({
      success: true,
      answer:
        data.steps
          ?.find(s => s.type === "model_output")
          ?.content
          ?.find(c => c.type === "text")
          ?.text || "No output returned"
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ======================================================
// HELPER: GET GOLD DATA
// ======================================================

async function getGoldCandles() {

  const url =
    `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=5min&outputsize=200&apikey=${TWELVE_DATA_API_KEY}`;

  const response = await fetch(url);

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
        c.volume !== undefined
          ? Number(c.volume)
          : null
    }))
    .reverse();
}

// ======================================================
// /ANALYZE
// ======================================================

app.get("/analyze", async (req, res) => {

  try {

    const candles = await getGoldCandles();

    const readableCandles = candles
      .slice(-100)
      .map(c =>
        `${c.time} | O:${c.open} H:${c.high} L:${c.low} C:${c.close} V:${c.volume ?? "N/A"}`
      )
      .join("\n");

    const prompt = `
You are an advanced XAUUSD Gold market analysis AI.

Analyze ONLY the supplied OHLC market data.

Instrument: XAUUSD
Timeframe: 5 minutes

Analyze:

1. Market Bias
2. Market Structure
3. HH / HL / LH / LL
4. BOS
5. CHoCH
6. MSS
7. Liquidity
8. Liquidity Sweeps
9. Equal Highs
10. Equal Lows
11. Support
12. Resistance
13. Supply
14. Demand
15. Order Blocks
16. Fair Value Gaps
17. Displacement
18. Price Action
19. Candlestick Patterns
20. EMA trend
21. RSI momentum
22. MACD
23. ATR / volatility
24. Volume if available
25. Key Levels
26. Bullish Scenario
27. Bearish Scenario
28. Possible Entry Zone
29. Stop Loss Zone
30. Take Profit Zones
31. Invalidation
32. Risk Warning

Rules:

- Separate confirmed observations from interpretations.
- If something cannot be determined, say "Insufficient data".
- Do not invent volume.
- Do not claim guaranteed trades.
- Explain why a BOS, CHoCH, MSS, liquidity sweep, FVG or Order Block is identified.
- Use the latest candle as the current reference.

Return a structured analysis.

GOLD 5-MINUTE DATA:

${readableCandles}
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
      candles_used: candles.length,
      answer
    });

  } catch (error) {

    res.status(500).json({
      success: false,
      error: error.message
    });

  }

});

// ======================================================
// /GOLD-DATA
// ======================================================

app.get("/gold-data", async (req, res) => {

  try {

    const candles = await getGoldCandles();

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

    const candles = await getGoldCandles();

    if (candles.length < 60) {
      return res.status(400).json({
        success: false,
        error: "Not enough candles for technical analysis"
      });
    }

    const latest =
      candles[candles.length - 1];

    const closes =
      candles.map(c => c.close);

    // ==================================================
    // EMA
    // ==================================================

    function calculateEMA(values, period) {

      if (values.length < period) {
        return null;
      }

      const multiplier =
        2 / (period + 1);

      let ema =
        values
          .slice(0, period)
          .reduce(
            (sum, value) => sum + value,
            0
          ) / period;

      for (
        let i = period;
        i < values.length;
        i++
      ) {

        ema =
          (values[i] - ema) *
            multiplier +
          ema;
      }

      return ema;
    }

    const EMA9 =
      calculateEMA(closes, 9);

    const EMA21 =
      calculateEMA(closes, 21);

    const EMA50 =
      calculateEMA(closes, 50);

    // ==================================================
    // RSI
    // ==================================================

    function calculateRSI(
      values,
      period = 14
    ) {

      if (values.length <= period) {
        return null;
      }

      let gains = 0;
      let losses = 0;

      for (
        let i = 1;
        i <= period;
        i++
      ) {

        const change =
          values[i] -
          values[i - 1];

        if (change > 0) {
          gains += change;
        } else {
          losses += Math.abs(change);
        }
      }

      let averageGain =
        gains / period;

      let averageLoss =
        losses / period;

      for (
        let i = period + 1;
        i < values.length;
        i++
      ) {

        const change =
          values[i] -
          values[i - 1];

        const gain =
          change > 0 ? change : 0;

        const loss =
          change < 0
            ? Math.abs(change)
            : 0;

        averageGain =
          (
            averageGain *
              (period - 1) +
            gain
          ) / period;

        averageLoss =
          (
            averageLoss *
              (period - 1) +
            loss
          ) / period;
      }

      if (averageLoss === 0) {
        return 100;
      }

      const RS =
        averageGain /
        averageLoss;

      return (
        100 -
        100 / (1 + RS)
      );
    }

    const RSI14 =
      calculateRSI(
        closes,
        14
      );

    // ==================================================
    // MACD
    // ==================================================

    function calculateMACD(values) {

      const ema12 =
        calculateEMA(values, 12);

      const ema26 =
        calculateEMA(values, 26);

      if (
        ema12 === null ||
        ema26 === null
      ) {
        return null;
      }

      const macdLine =
        ema12 - ema26;

      return {
        MACDLine: macdLine,
        signal: null,
        histogram: null,
        note:
          "MACD line calculated from current candle history. Full signal-line calculation requires longer historical series."
      };
    }

    const MACD =
      calculateMACD(closes);

    // ==================================================
    // ATR
    // ==================================================

    function calculateATR(
      candleData,
      period = 14
    ) {

      if (
        candleData.length <
        period + 1
      ) {
        return null;
      }

      const trueRanges = [];

      for (
        let i = 1;
        i < candleData.length;
        i++
      ) {

        const current =
          candleData[i];

        const previous =
          candleData[i - 1];

        const TR =
          Math.max(
            current.high -
              current.low,

            Math.abs(
              current.high -
                previous.close
            ),

            Math.abs(
              current.low -
                previous.close
            )
          );

        trueRanges.push(TR);
      }

      const recent =
        trueRanges.slice(-period);

      return (
        recent.reduce(
          (sum, value) =>
            sum + value,
          0
        ) / recent.length
      );
    }

    const ATR14 =
      calculateATR(
        candles,
        14
      );

    // ==================================================
    // SWING HIGH / LOW
    // ==================================================

    const swingHighs = [];
    const swingLows = [];

    for (
      let i = 2;
      i < candles.length - 2;
      i++
    ) {

      const c =
        candles[i];

      if (
        c.high >
          candles[i - 1].high &&
        c.high >
          candles[i - 2].high &&
        c.high >
          candles[i + 1].high &&
        c.high >
          candles[i + 2].high
      ) {

        swingHighs.push({
          time: c.time,
          price: c.high
        });
      }

      if (
        c.low <
          candles[i - 1].low &&
        c.low <
          candles[i - 2].low &&
        c.low <
          candles[i + 1].low &&
        c.low <
          candles[i + 2].low
      ) {

        swingLows.push({
          time: c.time,
          price: c.low
        });
      }
    }

    const previousSwingHigh =
      swingHighs[
        swingHighs.length - 1
      ];

    const previousSwingLow =
      swingLows[
        swingLows.length - 1
      ];

    // ==================================================
    // MARKET STRUCTURE HH HL LH LL
    // ==================================================

    let marketStructure =
      "Insufficient data";

    let structureDetails = {
      latestHigh: null,
      previousHigh: null,
      latestLow: null,
      previousLow: null,
      classification: "Insufficient data"
    };

    if (
      swingHighs.length >= 2 &&
      swingLows.length >= 2
    ) {

      const latestHigh =
        swingHighs[
          swingHighs.length - 1
        ];

      const previousHigh =
        swingHighs[
          swingHighs.length - 2
        ];

      const latestLow =
        swingLows[
          swingLows.length - 1
        ];

      const previousLow =
        swingLows[
          swingLows.length - 2
        ];

      const higherHigh =
        latestHigh.price >
        previousHigh.price;

      const lowerHigh =
        latestHigh.price <
        previousHigh.price;

      const higherLow =
        latestLow.price >
        previousLow.price;

      const lowerLow =
        latestLow.price <
        previousLow.price;

      if (
        higherHigh &&
        higherLow
      ) {
        marketStructure =
          "Bullish Structure";
      }

      else if (
        lowerHigh &&
        lowerLow
      ) {
        marketStructure =
          "Bearish Structure";
      }

      else {
        marketStructure =
          "Mixed / Transitional Structure";
      }

      structureDetails = {
        latestHigh,
        previousHigh,
        latestLow,
        previousLow,

        classification:
          marketStructure,

        higherHigh,
        lowerHigh,
        higherLow,
        lowerLow
      };
    }

    // ==================================================
    // BOS
    // ==================================================

    let BOS = "None";
    let BOSReason = "No confirmed BOS";

    if (
      previousSwingHigh &&
      latest.close >
        previousSwingHigh.price
    ) {

      BOS =
        "Bullish BOS";

      BOSReason =
        `Latest close ${latest.close} is above swing high ${previousSwingHigh.price}`;
    }

    if (
      previousSwingLow &&
      latest.close <
        previousSwingLow.price
    ) {

      BOS =
        "Bearish BOS";

      BOSReason =
        `Latest close ${latest.close} is below swing low ${previousSwingLow.price}`;
    }

    // ==================================================
    // CHoCH / MSS
    // ==================================================

    let CHoCH = "None";
    let MSS = "None";

    let CHoCHReason =
      "No confirmed CHoCH";

    let MSSReason =
      "No confirmed MSS";

    if (
      swingHighs.length >= 2 &&
      swingLows.length >= 2
    ) {

      const lastHigh =
        swingHighs[
          swingHighs.length - 1
        ];

      const previousHigh =
        swingHighs[
          swingHighs.length - 2
        ];

      const lastLow =
        swingLows[
          swingLows.length - 1
        ];

      const previousLow =
        swingLows[
          swingLows.length - 2
        ];

      // Bearish structure -> Bullish shift

      if (
        lastLow.price <
          previousLow.price &&
        latest.close >
          lastHigh.price
      ) {

        CHoCH =
          "Bullish CHoCH";

        MSS =
          "Bullish MSS";

        CHoCHReason =
          "Lower-low structure followed by break above the latest swing high.";

        MSSReason =
          "Bullish market structure shift confirmed by closing above the latest swing high.";
      }

      // Bullish structure -> Bearish shift

      if (
        lastHigh.price >
          previousHigh.price &&
        latest.close <
          lastLow.price
      ) {

        CHoCH =
          "Bearish CHoCH";

        MSS =
          "Bearish MSS";

        CHoCHReason =
          "Higher-high structure followed by break below the latest swing low.";

        MSSReason =
          "Bearish market structure shift confirmed by closing below the latest swing low.";
      }
    }

    // ==================================================
    // LIQUIDITY
    // ==================================================

    const liquidityHighs = [];
    const liquidityLows = [];

    const tolerance =
      latest.close * 0.0003;

    for (
      let i = 1;
      i < swingHighs.length;
      i++
    ) {

      const a =
        swingHighs[i - 1];

      const b =
        swingHighs[i];

      if (
        Math.abs(
          a.price - b.price
        ) <= tolerance
      ) {

        liquidityHighs.push({
          price:
            (
              a.price +
              b.price
            ) / 2,

          firstTime: a.time,
          secondTime: b.time,

          type:
            "Equal High Liquidity"
        });
      }
    }

    for (
      let i = 1;
      i < swingLows.length;
      i++
    ) {

      const a =
        swingLows[i - 1];

      const b =
        swingLows[i];

      if (
        Math.abs(
          a.price - b.price
        ) <= tolerance
      ) {

        liquidityLows.push({
          price:
            (
              a.price +
              b.price
            ) / 2,

          firstTime: a.time,
          secondTime: b.time,

          type:
            "Equal Low Liquidity"
        });
      }
    }

    let liquiditySweep =
      "None";

    let liquiditySweepReason =
      "No confirmed liquidity sweep on latest candle.";

    if (
      previousSwingHigh &&
      latest.high >
        previousSwingHigh.price &&
      latest.close <
        previousSwingHigh.price
    ) {

      liquiditySweep =
        "Buy-side liquidity sweep";

      liquiditySweepReason =
        "Price traded above the previous swing high but closed back below it.";
    }

    if (
      previousSwingLow &&
      latest.low <
        previousSwingLow.price &&
      latest.close >
        previousSwingLow.price
    ) {

      liquiditySweep =
        "Sell-side liquidity sweep";

      liquiditySweepReason =
        "Price traded below the previous swing low but closed back above it.";
    }

    // ==================================================
    // CANDLE STRENGTH / DISPLACEMENT
    // ==================================================

    const candleRange =
      latest.high -
      latest.low;

    const candleBody =
      Math.abs(
        latest.close -
        latest.open
      );

    let candleStrength =
      "Normal";

    let displacement =
      "None";

    if (candleRange > 0) {

      const bodyRatio =
        candleBody /
        candleRange;

      if (
        bodyRatio >= 0.70
      ) {

        candleStrength =
          "Strong Displacement";

        displacement =
          latest.close >
          latest.open
            ? "Bullish Displacement"
            : "Bearish Displacement";
      }

      else if (
        bodyRatio >= 0.50
      ) {

        candleStrength =
          "Moderate";
      }

      else {

        candleStrength =
          "Weak / Indecision";
      }
    }

    const candleDirection =
      latest.close >
      latest.open
        ? "Bullish"
        : latest.close <
          latest.open
          ? "Bearish"
          : "Doji";

    // ==================================================
    // CANDLESTICK PATTERNS
    // ==================================================

    let candlestickPatterns = [];

    const previous =
      candles[candles.length - 2];

    if (previous) {

      // Bullish Engulfing

      if (
        previous.close <
          previous.open &&
        latest.close >
          latest.open &&
        latest.open <=
          previous.close &&
        latest.close >=
          previous.open
      ) {

        candlestickPatterns.push(
          "Bullish Engulfing"
        );
      }

      // Bearish Engulfing

      if (
        previous.close >
          previous.open &&
        latest.close <
          latest.open &&
        latest.open >=
          previous.close &&
        latest.close <=
          previous.open
      ) {

        candlestickPatterns.push(
          "Bearish Engulfing"
        );
      }
    }

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

    if (
      candleBody > 0 &&
      lowerWick >=
        candleBody * 2 &&
      upperWick <=
        candleBody
    ) {

      candlestickPatterns.push(
        "Bullish Pin Bar"
      );
    }

    if (
      candleBody > 0 &&
      upperWick >=
        candleBody * 2 &&
      lowerWick <=
        candleBody
    ) {

      candlestickPatterns.push(
        "Bearish Pin Bar"
      );
    }

    if (
      candleBody <=
      candleRange * 0.10
    ) {

      candlestickPatterns.push(
        "Doji / Indecision"
      );
    }

    if (
      candlestickPatterns.length === 0
    ) {

      candlestickPatterns.push(
        "No major pattern detected"
      );
    }

    // ==================================================
    // SUPPORT / RESISTANCE
    // ==================================================

    const support =
      swingLows
        .slice(-5)
        .map(x => x.price);

    const resistance =
      swingHighs
        .slice(-5)
        .map(x => x.price);

    // ==================================================
    // SUPPLY / DEMAND
    // ==================================================

    const demandZones = [];

    const supplyZones = [];

    for (
      let i = 2;
      i < candles.length;
      i++
    ) {

      const first =
        candles[i - 2];

      const second =
        candles[i - 1];

      const third =
        candles[i];

      // Demand:
      // bearish candle -> bullish displacement

      if (
        second.close <
          second.open &&
        third.close >
          third.open &&
        third.close >
          second.high
      ) {

        demandZones.push({
          time: second.time,
          low: second.low,
          high: second.high,
          type: "Demand Zone"
        });
      }

      // Supply:
      // bullish candle -> bearish displacement

      if (
        second.close >
          second.open &&
        third.close <
          third.open &&
        third.close <
          second.low
      ) {

        supplyZones.push({
          time: second.time,
          low: second.low,
          high: second.high,
          type: "Supply Zone"
        });
      }
    }

    // ==================================================
    // FVG
    // ==================================================

    const bullishFVGs = [];
    const bearishFVGs = [];

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
        third.low >
        first.high
      ) {

        bullishFVGs.push({
          time: third.time,
          type: "Bullish FVG",
          lower: first.high,
          upper: third.low
        });
      }

      if (
        third.high <
        first.low
      ) {

        bearishFVGs.push({
          time: third.time,
          type: "Bearish FVG",
          lower: third.high,
          upper: first.low
        });
      }
    }

    // ==================================================
    // ORDER BLOCKS
    // ==================================================

    const bullishOrderBlocks = [];
    const bearishOrderBlocks = [];

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
        previous.close <
          previous.open &&
        current.close >
          current.open &&
        current.close >
          previous.high
      ) {

        bullishOrderBlocks.push({
          time: previous.time,
          type:
            "Bullish Order Block",
          high: previous.high,
          low: previous.low
        });
      }

      if (
        previous.close >
          previous.open &&
        current.close <
          current.open &&
        current.close <
          previous.low
      ) {

        bearishOrderBlocks.push({
          time: previous.time,
          type:
            "Bearish Order Block",
          high: previous.high,
          low: previous.low
        });
      }
    }

    // ==================================================
    // TREND
    // ==================================================

    let trend =
      "Neutral";

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

        trend =
          "Strong Bullish";
      }

      else if (
        EMA9 < EMA21 &&
        EMA21 < EMA50 &&
        latest.close < EMA9
      ) {

        trend =
          "Strong Bearish";
      }

      else if (
        EMA9 > EMA21
      ) {

        trend =
          "Bullish";
      }

      else if (
        EMA9 < EMA21
      ) {

        trend =
          "Bearish";
      }
    }

    // ==================================================
    // RSI MOMENTUM
    // ==================================================

    let momentum =
      "Neutral";

    if (
      RSI14 !== null
    ) {

      if (
        RSI14 >= 70
      ) {

        momentum =
          "Overbought";
      }

      else if (
        RSI14 <= 30
      ) {

        momentum =
          "Oversold";
      }

      else if (
        RSI14 > 55
      ) {

        momentum =
          "Bullish Momentum";
      }

      else if (
        RSI14 < 45
      ) {

        momentum =
          "Bearish Momentum";
      }
    }

    // ==================================================
    // VOLUME
    // ==================================================

    const volumeAvailable =
      candles.some(
        c =>
          c.volume !== null &&
          Number.isFinite(c.volume)
      );

    let volumeAnalysis =
      "Insufficient data";

    if (
      volumeAvailable
    ) {

      const volumes =
        candles
          .filter(
            c =>
              c.volume !== null
          )
          .map(
            c =>
              c.volume
          );

      const recentVolume =
        volumes[
          volumes.length - 1
        ];

      const averageVolume =
        volumes
          .slice(-20)
          .reduce(
            (sum, value) =>
              sum + value,
            0
          ) /
        Math.min(
          20,
          volumes.length
        );

      if (
        recentVolume >
        averageVolume * 1.5
      ) {

        volumeAnalysis =
          "High Volume";
      }

      else if (
        recentVolume >
        averageVolume
      ) {

        volumeAnalysis =
          "Above Average Volume";
      }

      else {

        volumeAnalysis =
          "Normal / Low Volume";
      }
    }

    // ==================================================
    // KEY LEVELS
    // ==================================================

    const keyLevels = {

      currentPrice:
        latest.close,

      nearestSupport:
        support.length
          ? Math.max(
              ...support.filter(
                x =>
                  x <
                  latest.close
              )
            )
          : null,

      nearestResistance:
        resistance.length
          ? Math.min(
              ...resistance.filter(
                x =>
                  x >
                  latest.close
              )
            )
          : null,

      ATR14
    };

    // ==================================================
    // FINAL RESPONSE
    // ==================================================

    res.json({

      success: true,

      instrument:
        "XAUUSD",

      timeframe:
        "5min",

      current:
        latest,

      marketStructure: {

        classification:
          marketStructure,

        details:
          structureDetails,

        latestSwingHigh:
          previousSwingHigh ||
          null,

        latestSwingLow:
          previousSwingLow ||
          null
      },

      BOS: {

        signal: BOS,

        reason:
          BOSReason
      },

      CHoCH: {

        signal: CHoCH,

        reason:
          CHoCHReason
      },

      MSS: {

        signal: MSS,

        reason:
          MSSReason
      },

      liquidity: {

        sweep:
          liquiditySweep,

        sweepReason:
          liquiditySweepReason,

        equalHighs:
          liquidityHighs.slice(-5),

        equalLows:
          liquidityLows.slice(-5)
      },

      displacement: {

        status:
          displacement,

        candleStrength,

        candleDirection,

        range:
          candleRange,

        body:
          candleBody
      },

      priceAction: {

        candleDirection,

        candleStrength,

        patterns:
          candlestickPatterns,

        upperWick,

        lowerWick
      },

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

      supplyDemand: {

        supply:
          supplyZones.slice(-5),

        demand:
          demandZones.slice(-5)
      },

      fvg: {

        bullish:
          bullishFVGs.slice(-5),

        bearish:
          bearishFVGs.slice(-5)
      },

      orderBlocks: {

        bullish:
          bullishOrderBlocks.slice(-5),

        bearish:
          bearishOrderBlocks.slice(-5)
      },

      keyLevels,

      swingHighs:
        swingHighs.slice(-10),

      swingLows:
        swingLows.slice(-10)

    });

  } catch (error) {

    console.error(
      "Technical analysis error:",
      error
    );

    res.status(500).json({

      success: false,

      error:
        error.message
    });
  }
});

// ======================================================
// SERVER
// ======================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "Server running on port " +
      PORT
    );

  }
);

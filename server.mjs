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

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port " + PORT);
});

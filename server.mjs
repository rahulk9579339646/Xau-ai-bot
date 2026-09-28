import express from "express";

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

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
    const prompt = `
You are an advanced XAUUSD (Gold) market analysis AI.

Analyze the current market information provided by the user.

Use these frameworks when data is available:
1. Market Structure
2. BOS / CHoCH / MSS
3. Liquidity and Liquidity Sweeps
4. Support and Resistance
5. Supply and Demand
6. Order Blocks
7. Fair Value Gaps
8. Price Action
9. Candlestick Patterns
10. EMA / RSI / Volume
11. Trendlines
12. Risk and invalidation levels

Do not invent market data that is not provided.

Return the analysis in this format:

Market Bias:
Market Structure:
BOS/CHoCH/MSS:
Liquidity:
Support:
Resistance:
Order Block:
FVG:
Candlestick:
Indicators:
Key Levels:
Bullish Scenario:
Bearish Scenario:
Invalidation:
Risk Warning:

User market data:
XAUUSD Gold
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
      answer
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

import express from "express";
import OpenAI from "openai";

const app = express();

app.use(express.json({ limit: "100kb" }));

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.json({
    status: "XAU AI BOT ONLINE"
  });
});

app.post("/xau-ai", async (req, res) => {
  try {
    const marketData = req.body;

    const prompt = `
You are an XAUUSD M1 market-analysis engine.

Analyze the supplied XAUUSD M1 market data.

You MUST use live web search to check current information that can materially affect gold, including where relevant:
- CPI and Core CPI
- PPI and Core PPI
- NFP
- Unemployment
- Average Hourly Earnings
- FOMC / Federal Reserve
- Powell statements
- US Dollar / DXY
- US Treasury yields
- major geopolitical or economic events
- other important current gold-related news

Do NOT invent news.

Decision rules:
1. If important high-impact news is imminent or market risk is unusually high, prefer NO_TRADE.
2. Consider both the supplied price action and current news.
3. Do not make a decision from news alone.
4. If evidence is conflicting, return NO_TRADE.
5. This is an analysis signal, not a guarantee of profit.

Return ONLY valid JSON in exactly this format:

{
  "signal": "BUY",
  "confidence": 0,
  "newsImpact": "BULLISH",
  "reason": "short explanation",
  "risk": "LOW"
}

Allowed signal:
BUY
SELL
NO_TRADE

Allowed newsImpact:
BULLISH
BEARISH
NEUTRAL

Allowed risk:
LOW
MEDIUM
HIGH

confidence must be an integer from 0 to 100.

MARKET DATA:
${JSON.stringify(marketData)}
`;

    const response = await client.responses.create({
      model: "gpt-5.5",
      tools: [
        {
          type: "web_search"
        }
      ],
      tool_choice: "required",
      input: prompt
    });

    const text = response.output_text || "";

    const match = text.match(/\{[\s\S]*\}/);

    if (!match) {
      return res.json({
        signal: "NO_TRADE",
        confidence: 0,
        newsImpact: "NEUTRAL",
        reason: "AI did not return valid JSON",
        risk: "HIGH"
      });
    }

    let result;

    try {
      result = JSON.parse(match[0]);
    } catch (error) {
      return res.json({
        signal: "NO_TRADE",
        confidence: 0,
        newsImpact: "NEUTRAL",
        reason: "Invalid AI JSON",
        risk: "HIGH"
      });
    }

    if (!["BUY", "SELL", "NO_TRADE"].includes(result.signal)) {
      result.signal = "NO_TRADE";
    }

    if (!["BULLISH", "BEARISH", "NEUTRAL"].includes(result.newsImpact)) {
      result.newsImpact = "NEUTRAL";
    }

    if (!["LOW", "MEDIUM", "HIGH"].includes(result.risk)) {
      result.risk = "HIGH";
    }

    result.confidence = Math.max(
      0,
      Math.min(100, Number(result.confidence) || 0)
    );

    result.reason = String(result.reason || "No reason provided");

    res.json(result);

  } catch (error) {
    console.error("AI ERROR:", error);

    res.status(500).json({
      signal: "NO_TRADE",
      confidence: 0,
      newsImpact: "NEUTRAL",
      reason: "Backend error",
      risk: "HIGH"
    });
  }
});

app.listen(PORT, () => {
  console.log(`XAU AI server running on port ${PORT}`);
});

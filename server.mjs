import express from "express";
import OpenAI from "openai";

const app = express();

app.use(express.json({ limit: "100kb" }));

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const PORT = process.env.PORT || 3000;

/* =========================
   FRONTEND
========================= */

app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">

<title>XAU AI Bot</title>

<style>
body {
  font-family: Arial, sans-serif;
  background: #111;
  color: white;
  margin: 0;
  padding: 20px;
}

.container {
  max-width: 700px;
  margin: auto;
}

h1 {
  text-align: center;
}

.card {
  background: #1d1d1d;
  padding: 20px;
  border-radius: 12px;
  margin-top: 20px;
}

label {
  display: block;
  margin-top: 12px;
  margin-bottom: 5px;
}

input {
  width: 100%;
  box-sizing: border-box;
  padding: 12px;
  border-radius: 7px;
  border: 1px solid #555;
  background: #222;
  color: white;
}

button {
  width: 100%;
  padding: 14px;
  margin-top: 20px;
  border: none;
  border-radius: 8px;
  font-size: 17px;
  font-weight: bold;
  cursor: pointer;
}

.result {
  margin-top: 20px;
  padding: 20px;
  background: #222;
  border-radius: 10px;
  white-space: pre-wrap;
}

.status {
  text-align: center;
  margin-top: 10px;
  color: #aaa;
}
</style>
</head>

<body>

<div class="container">

<h1>🟡 XAU AI BOT</h1>

<div class="status">
Gold / XAUUSD AI Market Analysis
</div>

<div class="card">

<label>Current Price</label>
<input id="price" placeholder="Example: 3800">

<label>Open</label>
<input id="open" placeholder="M1 Open">

<label>High</label>
<input id="high" placeholder="M1 High">

<label>Low</label>
<input id="low" placeholder="M1 Low">

<label>Close</label>
<input id="close" placeholder="M1 Close">

<label>RSI</label>
<input id="rsi" placeholder="Example: 55">

<label>EMA 5</label>
<input id="ema5" placeholder="EMA 5">

<label>EMA 13</label>
<input id="ema13" placeholder="EMA 13">

<label>Volume</label>
<input id="volume" placeholder="Volume">

<button onclick="analyze()">ANALYZE XAUUSD</button>

<div id="result" class="result">
Waiting for analysis...
</div>

</div>

</div>

<script>

async function analyze() {

  const resultBox = document.getElementById("result");

  resultBox.innerText = "⏳ AI is analyzing XAUUSD...";

  const marketData = {

    instrument: "XAUUSD",

    timeframe: "M1",

    price: document.getElementById("price").value,

    open: document.getElementById("open").value,

    high: document.getElementById("high").value,

    low: document.getElementById("low").value,

    close: document.getElementById("close").value,

    rsi: document.getElementById("rsi").value,

    ema5: document.getElementById("ema5").value,

    ema13: document.getElementById("ema13").value,

    volume: document.getElementById("volume").value

  };

  try {

    const response = await fetch("/xau-ai", {

      method: "POST",

      headers: {
        "Content-Type": "application/json"
      },

      body: JSON.stringify(marketData)

    });

    const data = await response.json();

    resultBox.innerText =

      "SIGNAL: " + data.signal + "\\n\\n" +

      "CONFIDENCE: " + data.confidence + "%\\n\\n" +

      "NEWS IMPACT: " + data.newsImpact + "\\n\\n" +

      "RISK: " + data.risk + "\\n\\n" +

      "REASON:\\n" + data.reason;

  }

  catch (error) {

    resultBox.innerText =
      "ERROR: " + error.message;

  }

}

</script>

</body>
</html>
  `);
});


/* =========================
   AI ANALYSIS API
========================= */

app.post("/xau-ai", async (req, res) => {

  try {

    const marketData = req.body;

    const prompt = `

You are an XAUUSD M1 market-analysis engine.

Analyze the supplied XAUUSD M1 market data.

You MUST use live web search to check current information that can materially affect gold, including where relevant:

- CPI
- Core CPI
- PPI
- Core PPI
- NFP
- Unemployment
- Average Hourly Earnings
- FOMC
- Federal Reserve
- Powell statements
- US Dollar / DXY
- US Treasury yields
- major geopolitical events
- major economic events
- other important current gold-related news

Do NOT invent news.

Decision rules:

1. If important high-impact news is imminent or market risk is unusually high, prefer NO_TRADE.

2. Consider both supplied price action and current news.

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

      model: "gpt-5.6-luna",

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

    result.reason = String(
      result.reason || "No reason provided"
    );

    res.json(result);

  }

  catch (error) {

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


/* =========================
   START SERVER
========================= */

app.listen(PORT, () => {

  console.log(
    `XAU AI server running on port ${PORT}`
  );

});

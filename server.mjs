import express from "express";

const app = express();

app.use(express.json({ limit: "200kb" }));

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>XAU AI Bot</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      background: #111;
      color: white;
      padding: 20px;
      max-width: 700px;
      margin: auto;
    }

    h1 {
      text-align: center;
    }

    .box {
      background: #1d1d1d;
      padding: 15px;
      border-radius: 12px;
      margin-bottom: 15px;
    }

    input {
      width: 100%;
      box-sizing: border-box;
      padding: 12px;
      margin: 6px 0 12px;
      border-radius: 8px;
      border: 1px solid #555;
      background: #222;
      color: white;
    }

    button {
      width: 100%;
      padding: 15px;
      border: 0;
      border-radius: 10px;
      background: #ffffff;
      color: #111;
      font-size: 18px;
      font-weight: bold;
    }

    #result {
      white-space: pre-wrap;
      line-height: 1.6;
    }
  </style>
</head>

<body>

<h1> XAU AI BOT </h1>

<div class="box">

  <label>Current Price</label>
  <input id="price" type="number" step="any">

  <label>Open</label>
  <input id="open" type="number" step="any">

  <label>High</label>
  <input id="high" type="number" step="any">

  <label>Low</label>
  <input id="low" type="number" step="any">

  <label>Close</label>
  <input id="close" type="number" step="any">

  <label>RSI</label>
  <input id="rsi" type="number" step="any">

  <label>EMA 5</label>
  <input id="ema5" type="number" step="any">

  <label>EMA 13</label>
  <input id="ema13" type="number" step="any">

  <label>Volume</label>
  <input id="volume" type="number" step="any">

  <button onclick="analyze()">ANALYZE XAUUSD</button>

</div>

<div class="box">
  <div id="result">Waiting for analysis...</div>
</div>

<script>

async function analyze() {

  const result = document.getElementById("result");

  result.innerText = "Analyzing XAUUSD...";

  const data = {
    instrument: "XAUUSD",
    timeframe: "M1",

    currentPrice: Number(document.getElementById("price").value),
    open: Number(document.getElementById("open").value),
    high: Number(document.getElementById("high").value),
    low: Number(document.getElementById("low").value),
    close: Number(document.getElementById("close").value),

    indicators: {
      RSI: Number(document.getElementById("rsi").value),
      EMA5: Number(document.getElementById("ema5").value),
      EMA13: Number(document.getElementById("ema13").value),
      volume: Number(document.getElementById("volume").value)
    }
  };

  try {

    const response = await fetch("/xau-ai", {

      method: "POST",

      headers: {
        "Content-Type": "application/json"
      },

      body: JSON.stringify(data)

    });

    const resultData = await response.json();

    result.innerText =
      "SIGNAL: " + resultData.signal + "\\n\\n" +
      "CONFIDENCE: " + resultData.confidence + "%\\n\\n" +
      "NEWS IMPACT: " + resultData.newsImpact + "\\n\\n" +
      "RISK: " + resultData.risk + "\\n\\n" +
      "REASON:\\n" + resultData.reason;

  } catch (error) {

    result.innerText =
      "ERROR:\\n" + error.message;

  }

}

</script>

</body>
</html>
  `);
});


app.post("/xau-ai", async (req, res) => {

  try {

    if (!GEMINI_API_KEY) {

      return res.status(500).json({
        signal: "NO_TRADE",
        confidence: 0,
        newsImpact: "NEUTRAL",
        reason: "GEMINI_API_KEY is missing in Render Environment Variables.",
        risk: "HIGH"
      });

    }

    const marketData = req.body;

    const prompt = `
You are the core analysis engine of a professional XAUUSD market-analysis system.

IMPORTANT:
This is NOT only a news-analysis bot.

The long-term system is designed to analyze as many established technical-analysis methods as practical.

Analyze the supplied XAUUSD market data using structured confluence.

Consider, when data is available:

1. PRICE ACTION
- trend
- HH
- HL
- LH
- LL
- breakout
- retest
- rejection
- consolidation
- expansion

2. CANDLESTICK ANALYSIS
- engulfing
- pin bar
- hammer
- shooting star
- doji
- inside bar
- outside bar
- morning/evening star
- other recognized formations

3. CHART PATTERNS
- head and shoulders
- inverse head and shoulders
- double top
- double bottom
- triple top
- triple bottom
- triangles
- wedges
- flags
- pennants
- rectangles
- channels
- cup and handle
- rounding structures
- other recognizable formations

4. MARKET STRUCTURE
- BOS
- CHoCH
- MSS
- internal structure
- external structure
- swing highs/lows
- trend/range

5. SMC / ICT
- liquidity pools
- buy-side liquidity
- sell-side liquidity
- liquidity sweep
- stop run
- order block
- breaker
- mitigation
- fair value gap
- imbalance
- displacement
- premium/discount

6. LEVELS
- support
- resistance
- supply
- demand
- trendlines
- channels
- previous high/low
- session high/low

7. INDICATORS
Use supplied indicators when available and do not invent values.

Consider categories such as:
- moving averages
- RSI
- MACD
- stochastic
- ADX
- ATR
- CCI
- ROC
- Williams %R
- Bollinger Bands
- Keltner Channels
- Donchian Channels
- VWAP
- OBV
- MFI
- CMF
- volume analysis
- volatility measurements
- momentum measurements

8. MULTI-TIMEFRAME
When multiple timeframes are supplied, compare them and identify alignment or conflict.

9. VOLUME / ORDER-FLOW STYLE INFORMATION
Use only actual supplied data.
Do not invent order-book or footprint data.

10. FUNDAMENTAL / NEWS
Use Google Search grounding when available to check important current events affecting gold, including:
- CPI
- Core CPI
- PPI
- Core PPI
- NFP
- unemployment
- Average Hourly Earnings
- FOMC
- Federal Reserve
- Powell
- DXY
- Treasury yields
- major geopolitical/economic events

Do NOT invent news.

11. CONFLUENCE
Do not trade from one indicator alone.

Look for agreement between multiple independent categories.

If evidence conflicts strongly, prefer NO_TRADE.

If important high-impact news is imminent and risk is unusually high, prefer NO_TRADE.

This is analysis only and is not a guarantee of profit.

Return ONLY valid JSON.

Use exactly this structure:

{
  "signal": "BUY",
  "confidence": 0,
  "newsImpact": "BULLISH",
  "risk": "LOW",
  "reason": "short explanation",
  "conditions": [],
  "conflicts": [],
  "marketStructure": "NEUTRAL",
  "liquidity": "NEUTRAL",
  "pattern": "NONE"
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

Allowed marketStructure:
BULLISH
BEARISH
NEUTRAL

Allowed liquidity:
BULLISH
BEARISH
NEUTRAL

confidence must be an integer from 0 to 100.

conditions must contain the important confirmed conditions.

conflicts must contain important conflicting signals.

Do not claim that an indicator, pattern, liquidity event or structure exists unless the supplied data is sufficient to support it.

MARKET DATA:
${JSON.stringify(marketData)}
`;

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
          ],

          generationConfig: {
            temperature: 0.2,
            responseMimeType: "application/json"
          },

          tools: [
            {
              googleSearch: {}
            }
          ]
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {

      console.error("GEMINI ERROR:", data);

      return res.status(500).json({
        signal: "NO_TRADE",
        confidence: 0,
        newsImpact: "NEUTRAL",
        reason: "Gemini API error. Check Render logs.",
        risk: "HIGH"
      });
    }

    const text =
      data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    let result;

    try {

      result = JSON.parse(text);

    } catch (error) {

      console.error("JSON ERROR:", text);

      return res.json({
        signal: "NO_TRADE",
        confidence: 0,
        newsImpact: "NEUTRAL",
        reason: "Gemini returned invalid JSON.",
        risk: "HIGH",
        conditions: [],
        conflicts: [],
        marketStructure: "NEUTRAL",
        liquidity: "NEUTRAL",
        pattern: "NONE"
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

    if (!["BULLISH", "BEARISH", "NEUTRAL"].includes(result.marketStructure)) {
      result.marketStructure = "NEUTRAL";
    }

    if (!["BULLISH", "BEARISH", "NEUTRAL"].includes(result.liquidity)) {
      result.liquidity = "NEUTRAL";
    }

    result.confidence = Math.max(
      0,
      Math.min(100, Number(result.confidence) || 0)
    );

    result.reason = String(
      result.reason || "No reason provided"
    );

    if (!Array.isArray(result.conditions)) {
      result.conditions = [];
    }

    if (!Array.isArray(result.conflicts)) {
      result.conflicts = [];
    }

    result.pattern = String(
      result.pattern || "NONE"
    );

    res.json(result);

  } catch (error) {

    console.error("SERVER ERROR:", error);

    res.status(500).json({
      signal: "NO_TRADE",
      confidence: 0,
      newsImpact: "NEUTRAL",
      reason: "Backend error. Check Render logs.",
      risk: "HIGH",
      conditions: [],
      conflicts: [],
      marketStructure: "NEUTRAL",
      liquidity: "NEUTRAL",
      pattern: "NONE"
    });

  }

});


app.listen(PORT, () => {

  console.log(
    `XAU AI server running on port ${PORT}`
  );

});

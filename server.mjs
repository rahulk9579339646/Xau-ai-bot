```js
import express from "express";

const app = express();

app.use(express.json({ limit: "200kb" }));

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

app.get("/", function (req, res) {
  const html = [
    "<!DOCTYPE html>",
    "<html>",
    "<head>",
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    "<title>XAU AI Bot</title>",
    "<style>",
    "body{font-family:Arial,sans-serif;background:#111;color:white;padding:20px;max-width:700px;margin:auto}",
    "h1{text-align:center}",
    ".box{background:#1d1d1d;padding:15px;border-radius:12px;margin-bottom:15px}",
    "input{width:100%;box-sizing:border-box;padding:12px;margin:6px 0 12px;border-radius:8px;border:1px solid #555;background:#222;color:white}",
    "button{width:100%;padding:15px;border:0;border-radius:10px;background:white;color:#111;font-size:18px;font-weight:bold}",
    "#result{white-space:pre-wrap;line-height:1.6}",
    "</style>",
    "</head>",
    "<body>",
    "<h1>XAU AI BOT</h1>",
    '<div class="box">',

    "<label>Current Price</label>",
    '<input id="price" type="number" step="any">',

    "<label>Open</label>",
    '<input id="open" type="number" step="any">',

    "<label>High</label>",
    '<input id="high" type="number" step="any">',

    "<label>Low</label>",
    '<input id="low" type="number" step="any">',

    "<label>Close</label>",
    '<input id="close" type="number" step="any">',

    "<label>RSI</label>",
    '<input id="rsi" type="number" step="any">',

    "<label>EMA 5</label>",
    '<input id="ema5" type="number" step="any">',

    "<label>EMA 13</label>",
    '<input id="ema13" type="number" step="any">',

    "<label>Volume</label>",
    '<input id="volume" type="number" step="any">',

    '<button onclick="analyze()">ANALYZE XAUUSD</button>',
    "</div>",

    '<div class="box">',
    '<div id="result">Waiting for analysis...</div>',
    "</div>",

    "<script>",
    "async function analyze(){",
    "const result=document.getElementById('result');",
    "result.innerText='Analyzing XAUUSD...';",

    "const data={",
    "instrument:'XAUUSD',",
    "timeframe:'M1',",
    "currentPrice:Number(document.getElementById('price').value),",
    "open:Number(document.getElementById('open').value),",
    "high:Number(document.getElementById('high').value),",
    "low:Number(document.getElementById('low').value),",
    "close:Number(document.getElementById('close').value),",
    "indicators:{",
    "RSI:Number(document.getElementById('rsi').value),",
    "EMA5:Number(document.getElementById('ema5').value),",
    "EMA13:Number(document.getElementById('ema13').value),",
    "volume:Number(document.getElementById('volume').value)",
    "}",
    "};",

    "try{",
    "const response=await fetch('/xau-ai',{",
    "method:'POST',",
    "headers:{'Content-Type':'application/json'},",
    "body:JSON.stringify(data)",
    "});",

    "const resultData=await response.json();",

    "result.innerText=",
    "'SIGNAL: '+resultData.signal+'\\n\\n'+",
    "'CONFIDENCE: '+resultData.confidence+'%\\n\\n'+",
    "'NEWS IMPACT: '+resultData.newsImpact+'\\n\\n'+",
    "'RISK: '+resultData.risk+'\\n\\n'+",
    "'MARKET STRUCTURE: '+resultData.marketStructure+'\\n\\n'+",
    "'LIQUIDITY: '+resultData.liquidity+'\\n\\n'+",
    "'PATTERN: '+resultData.pattern+'\\n\\n'+",
    "'CONDITIONS:\\n'+(resultData.conditions||[]).join('\\n')+'\\n\\n'+",
    "'CONFLICTS:\\n'+(resultData.conflicts||[]).join('\\n')+'\\n\\n'+",
    "'REASON:\\n'+resultData.reason;",

    "}catch(error){",
    "result.innerText='ERROR:\\n'+error.message;",
    "}",
    "}",
    "</script>",
    "</body>",
    "</html>"
  ].join("\n");

  res.type("html").send(html);
});


app.post("/xau-ai", async function (req, res) {

  try {

    if (!GEMINI_API_KEY) {
      return res.status(500).json({
        signal: "NO_TRADE",
        confidence: 0,
        newsImpact: "NEUTRAL",
        risk: "HIGH",
        reason: "GEMINI_API_KEY is missing in Render.",
        conditions: [],
        conflicts: [],
        marketStructure: "NEUTRAL",
        liquidity: "NEUTRAL",
        pattern: "NONE"
      });
    }

    const marketData = req.body;

    const prompt =
      "You are the core XAUUSD market-analysis engine.\n\n" +

      "This is NOT only a news-analysis bot.\n\n" +

      "Analyze XAUUSD using structured confluence.\n\n" +

      "Use only information actually supplied or obtained through Google Search. " +
      "Never invent indicator values, chart patterns, liquidity events, order flow, " +
      "market structure or news.\n\n" +

      "Analyze these categories whenever sufficient data exists:\n\n" +

      "PRICE ACTION:\n" +
      "trend, HH, HL, LH, LL, breakout, retest, rejection, consolidation, expansion.\n\n" +

      "CANDLESTICKS:\n" +
      "engulfing, pin bar, hammer, shooting star, doji, inside bar, outside bar, " +
      "morning star, evening star and other recognized formations.\n\n" +

      "CHART PATTERNS:\n" +
      "head and shoulders, inverse head and shoulders, double top, double bottom, " +
      "triple top, triple bottom, triangles, wedges, flags, pennants, rectangles, " +
      "channels, cup and handle and rounding structures.\n\n" +

      "MARKET STRUCTURE:\n" +
      "BOS, CHoCH, MSS, swing highs/lows, internal structure, external structure, trend/range.\n\n" +

      "SMC / ICT:\n" +
      "buy-side liquidity, sell-side liquidity, liquidity sweep, stop run, order block, " +
      "breaker, mitigation, fair value gap, imbalance, displacement, premium/discount.\n\n" +

      "LEVELS:\n" +
      "support, resistance, supply, demand, trendlines, channels, previous high/low, session high/low.\n\n" +

      "INDICATORS:\n" +
      "Use supplied values only. Consider moving averages, RSI, MACD, stochastic, ADX, ATR, " +
      "CCI, ROC, Williams %R, Bollinger Bands, Keltner Channels, Donchian Channels, VWAP, " +
      "OBV, MFI, CMF, volume, volatility and momentum.\n\n" +

      "MULTI-TIMEFRAME:\n" +
      "If multiple timeframes are supplied, compare alignment and conflict.\n\n" +

      "VOLUME / ORDER FLOW:\n" +
      "Use only actual supplied information. Do not invent order-book or footprint data.\n\n" +

      "FUNDAMENTAL / NEWS:\n" +
      "Use Google Search when current news is needed. Check CPI, Core CPI, PPI, Core PPI, " +
      "NFP, unemployment, Average Hourly Earnings, FOMC, Federal Reserve, Powell, DXY, " +
      "Treasury yields and major geopolitical/economic events.\n\n" +

      "CONFLUENCE:\n" +
      "Do not make a decision from one indicator alone. Look for agreement between independent categories. " +
      "If important evidence conflicts, use NO_TRADE. " +
      "If major high-impact news is imminent and risk is unusually high, use NO_TRADE.\n\n" +

      "IMPORTANT LIMITATION:\n" +
      "The current input may contain only one candle and a few indicators. " +
      "Do NOT claim complex patterns, BOS, CHoCH, liquidity sweeps, order blocks or multi-timeframe confirmation " +
      "unless enough data is supplied.\n\n" +

      "Return only JSON matching the requested schema.\n\n" +

      "MARKET DATA:\n" +
      JSON.stringify(marketData);


    const requestBody = {
      model: "gemini-3.8-flash",

      input: prompt,

      tools: [
        {
          type: "google_search"
        }
      ],

      response_format: {
        type: "text",
        mime_type: "application/json",

        schema: {
          type: "object",

          properties: {
            signal: {
              type: "string",
              enum: ["BUY", "SELL", "NO_TRADE"]
            },

            confidence: {
              type: "integer"
            },

            newsImpact: {
              type: "string",
              enum: ["BULLISH", "BEARISH", "NEUTRAL"]
            },

            risk: {
              type: "string",
              enum: ["LOW", "MEDIUM", "HIGH"]
            },

            reason: {
              type: "string"
            },

            conditions: {
              type: "array",
              items: {
                type: "string"
              }
            },

            conflicts: {
              type: "array",
              items: {
                type: "string"
              }
            },

            marketStructure: {
              type: "string",
              enum: ["BULLISH", "BEARISH", "NEUTRAL"]
            },

            liquidity: {
              type: "string",
              enum: ["BULLISH", "BEARISH", "NEUTRAL"]
            },

            pattern: {
              type: "string"
            }
          },

          required: [
            "signal",
            "confidence",
            "newsImpact",
            "risk",
            "reason",
            "conditions",
            "conflicts",
            "marketStructure",
            "liquidity",
            "pattern"
          ]
        }
      }
    };


    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/interactions",
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY
        },

        body: JSON.stringify(requestBody)
      }
    );


    const data = await response.json();


    if (!response.ok) {

      console.error("GEMINI ERROR:", data);

      return res.status(500).json({
        signal: "NO_TRADE",
        confidence: 0,
        newsImpact: "NEUTRAL",
        risk: "HIGH",
        reason:
          "Gemini API error: " +
          String(data?.error?.message || "Unknown error"),
        conditions: [],
        conflicts: [],
        marketStructure: "NEUTRAL",
        liquidity: "NEUTRAL",
        pattern: "NONE"
      });
    }


    let text = "";

    if (typeof data.output_text === "string") {
      text = data.output_text;
    }

    if (!text && Array.isArray(data.steps)) {

      for (let i = data.steps.length - 1; i >= 0; i--) {

        const step = data.steps[i];

        if (
          step &&
          step.type === "model_output" &&
          Array.isArray(step.content)
        ) {

          for (let j = 0; j < step.content.length; j++) {

            const item = step.content[j];

            if (
              item &&
              item.type === "text" &&
              typeof item.text === "string"
            ) {
              text = item.text;
              break;
            }
          }
        }

        if (text) {
          break;
        }
      }
    }


    let result;

    try {

      result = JSON.parse(text);

    } catch (error) {

      console.error("JSON PARSE ERROR:", text);

      return res.json({
        signal: "NO_TRADE",
        confidence: 0,
        newsImpact: "NEUTRAL",
        risk: "HIGH",
        reason: "Gemini returned invalid JSON.",
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
      risk: "HIGH",
      reason: "Backend error. Check Render logs.",
      conditions: [],
      conflicts: [],
      marketStructure: "NEUTRAL",
      liquidity: "NEUTRAL",
      pattern: "NONE"
    });
  }
});


app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port " + PORT);
});

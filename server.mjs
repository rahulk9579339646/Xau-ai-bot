```js
import express from "express";

const app = express();

app.use(express.json({ limit: "200kb" }));

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

app.get("/", (req, res) => {
  const html = [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    "<title>XAU AI BOT</title>",
    "<style>body{font-family:Arial,sans-serif;max-width:600px;margin:20px auto;padding:16px}input,button{width:100%;padding:10px;margin:6px 0;box-sizing:border-box}button{cursor:pointer}#result{white-space:pre-wrap;margin-top:15px;padding:12px;border:1px solid #ccc}</style>",
    "</head>",
    "<body>",
    "<h2>XAU AI BOT</h2>",
    '<input id="price" placeholder="Current Price" value="4400">',
    '<input id="open" placeholder="Open" value="4398">',
    '<input id="high" placeholder="High" value="4402">',
    '<input id="low" placeholder="Low" value="4397">',
    '<input id="close" placeholder="Close" value="4401">',
    '<input id="rsi" placeholder="RSI" value="55">',
    '<input id="ema5" placeholder="EMA 5" value="4400">',
    '<input id="ema13" placeholder="EMA 13" value="4398">',
    '<input id="volume" placeholder="Volume" value="1000">',
    '<button onclick="analyze()">ANALYZE XAUUSD</button>',
    '<div id="result">Enter data and press ANALYZE.</div>',
    "<script>",
    "async function analyze(){",
    'const result=document.getElementById("result");',
    'result.textContent="Analyzing...";',
    "const data={",
    'currentPrice:document.getElementById("price").value,',
    'open:document.getElementById("open").value,',
    'high:document.getElementById("high").value,',
    'low:document.getElementById("low").value,',
    'close:document.getElementById("close").value,',
    'rsi:document.getElementById("rsi").value,',
    'ema5:document.getElementById("ema5").value,',
    'ema13:document.getElementById("ema13").value,',
    'volume:document.getElementById("volume").value',
    "};",
    "try{",
    'const response=await fetch("/xau-ai",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)});',
    "const json=await response.json();",
    "if(!response.ok){throw new Error(json.error||\"API request failed\");}",
    'result.textContent=json.result||JSON.stringify(json,null,2);',
    "}catch(error){",
    'result.textContent="Error: "+error.message;',
    "}",
    "}",
    "</script>",
    "</body>",
    "</html>"
  ].join("\n");

  res.send(html);
});

app.post("/xau-ai", async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({
        error: "GEMINI_API_KEY is missing"
      });
    }

    const prompt =
      "Analyze XAUUSD using the supplied market data. " +
      "Do not invent missing data. " +
      "Return JSON only with signal, confidence, newsImpact, reason, and risk. " +
      "Data: " +
      JSON.stringify(req.body || {});

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
          input: prompt,
          tools: [
            {
              type: "google_search"
            }
          ]
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("Gemini API error:", data);

      return res.status(502).json({
        error: "Gemini API error",
        details: data
      });
    }

    let output = data.output_text || "";

    if (!output && Array.isArray(data.steps)) {
      for (const step of data.steps) {
        if (
          step.type === "model_output" &&
          Array.isArray(step.content)
        ) {
          for (const item of step.content) {
            if (item.type === "text" && item.text) {
              output += item.text;
            }
          }
        }
      }
    }

    res.json({
      result: output || "No model output returned.",
      raw_id: data.id || null
    });
  } catch (error) {
    console.error("Server error:", error);

    res.status(500).json({
      error: error.message
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port " + PORT);
});
```

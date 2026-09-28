import express from "express";

const app = express();

app.use(express.json({ limit: "200kb" }));

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

app.get("/", (req, res) => {
  res.send("XAU AI BOT IS ONLINE");
});

app.post("/xau-ai", async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({
        error: "GEMINI_API_KEY is missing"
      });
    }

    const body = req.body || {};

    const prompt =
      "Analyze XAUUSD using the supplied market data. " +
      "Do not invent missing data. " +
      "Return JSON only with signal, confidence, newsImpact, reason, and risk. " +
      "Data: " +
      JSON.stringify(body);

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

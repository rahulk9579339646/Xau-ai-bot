import express from "express";

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("XAU AI BOT IS ONLINE");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port " + PORT);
});

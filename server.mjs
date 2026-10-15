
import express from "express";

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-HF-Secret");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

const PORT = process.env.PORT || 10000;
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY || "";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const LIQUID_AUTO_TRADE =
  String(process.env.LIQUID_AUTO_TRADE || "false").toLowerCase() === "true";
const HF_SECRET = process.env.HF_SECRET || "";

const SYMBOL = "XAU/USD";
const OUTPUT_SYMBOL = "XAUUSD";
const TF = { "1H": "1h", "15M": "15min", "5M": "5min" };

const CACHE = new Map();
const CACHE_MS = 15000;

let lastScan = null;
let lastSignalKey = null;
let lastTelegram = null;
let lastError = null;
let telegramEnabled = true;

function num(v, d = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function round(v, d = 5) {
  return Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null;
}

function last(a) {
  return a?.length ? a[a.length - 1] : null;
}

function emaSeries(values, period) {
  const out = Array(values.length).fill(null);
  if (values.length < period) return out;

  let s = 0;
  for (let i = 0; i < period; i++) s += values[i];

  let e = s / period;
  out[period - 1] = e;
  const k = 2 / (period + 1);

  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    out[i] = e;
  }

  return out;
}

function rsiSeries(values, period = 14) {
  const out = Array(values.length).fill(null);
  if (values.length <= period) return out;

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }

  gain /= period;
  loss /= period;

  out[period] =
    loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);

  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const g = Math.max(d, 0);
    const l = Math.max(-d, 0);

    gain = (gain * (period - 1) + g) / period;
    loss = (loss * (period - 1) + l) / period;

    out[i] =
      loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }

  return out;
}

function atrSeries(candles, period = 14) {
  const out = Array(candles.length).fill(null);
  if (candles.length < period + 1) return out;

  const tr = Array(candles.length);

  for (let i = 0; i < candles.length; i++) {
    tr[i] =
      i === 0
        ? candles[i].high - candles[i].low
        : Math.max(
            candles[i].high - candles[i].low,
            Math.abs(candles[i].high - candles[i - 1].close),
            Math.abs(candles[i].low - candles[i - 1].close)
          );
  }

  let a = 0;
  for (let i = 1; i <= period; i++) a += tr[i];

  a /= period;
  out[period] = a;

  for (let i = period + 1; i < candles.length; i++) {
    a = (a * (period - 1) + tr[i]) / period;
    out[i] = a;
  }

  return out;
}

function normalize(values) {
  return values
    .map((x) => ({
      time: x.datetime,
      open: num(x.open),
      high: num(x.high),
      low: num(x.low),
      close: num(x.close),
      volume: num(x.volume)
    }))
    .filter(
      (x) =>
        x.time &&
        [x.open, x.high, x.low, x.close].every(Number.isFinite)
    )
    .sort((a, b) => new Date(a.time) - new Date(b.time));
}

async function getCandles(interval, outputsize = 5000) {
  const key = `${interval}-${outputsize}`;
  const cached = CACHE.get(key);

  if (cached && Date.now() - cached.t < CACHE_MS) {
    return cached.d;
  }

  let err = null;

  if (TWELVE_DATA_API_KEY) {
    try {
      const u =
        `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(SYMBOL)}` +
        `&interval=${encodeURIComponent(interval)}` +
        `&outputsize=${Math.min(outputsize, 5000)}` +
        `&apikey=${encodeURIComponent(TWELVE_DATA_API_KEY)}&format=JSON`;

      const r = await fetch(u);
      const j = await r.json();

      if (!r.ok || j.status === "error" || !j.values) {
        throw new Error(j.message || "Twelve Data error");
      }

      const d = normalize(j.values);
      const duration = ({ "1day": 86400000, "1h": 3600000, "15min": 900000, "5min": 300000 })[interval] || 300000;
      const closed = d.filter(x => {
        const t = new Date(x.time).getTime();
        return Number.isFinite(t) && t + duration <= Date.now();
      });
      CACHE.set(key, { t: Date.now(), d: closed });
      return closed;
    } catch (e) {
      err = e;
    }
  }

  try {
    const biInterval =
      interval === "1day" ? "1d" : interval === "1h" ? "1h" : interval === "15min" ? "15m" : "5m";

    const u =
      `https://biquote.io/api/XAUUSD/ohlc?interval=${biInterval}` +
      `&limit=${Math.min(Math.max(outputsize, 100), 5000)}`;

    const r = await fetch(u);
    const j = await r.json();

    if (!r.ok || !Array.isArray(j.bars)) {
      throw new Error(j.message || "Biquote error");
    }

    const d = j.bars
      .filter((x) => !x.isOpen)
      .map((x) => ({
        time: x.openTime,
        open: num(x.open),
        high: num(x.high),
        low: num(x.low),
        close: num(x.close),
        volume: num(x.volume) || num(x.tickVolume)
      }))
      .filter(
        (x) =>
          x.time &&
          [x.open, x.high, x.low, x.close].every(Number.isFinite)
      )
      .sort((a, b) => new Date(a.time) - new Date(b.time));

    if (d.length < 100) throw new Error("Insufficient candles");

    CACHE.set(key, { t: Date.now(), d });
    return d;
  } catch (e) {
    throw new Error(
      `Data error: ${err?.message || "Twelve Data unavailable"}; ${e.message}`
    );
  }
}

function addIndicators(candles) {
  const close = candles.map((x) => x.close);
  const e20 = emaSeries(close, 20);
  const e50 = emaSeries(close, 50);
  const r = rsiSeries(close, 14);
  const a = atrSeries(candles, 14);

  return candles.map((x, i) => ({
    ...x,
    EMA20: e20[i],
    EMA50: e50[i],
    RSI14: r[i],
    ATR14: a[i]
  }));
}

/* =========================================================
   STRATEGY #5 — SUPPORT / RESISTANCE REJECTION
   Original rules preserved.
   ========================================================= */

function strategy5AtrSma(candles, period = 14) {
  const tr = candles.map((c, i) =>
    i === 0
      ? c.high - c.low
      : Math.max(
          c.high - c.low,
          Math.abs(c.high - candles[i - 1].close),
          Math.abs(c.low - candles[i - 1].close)
        )
  );

  return candles.map((_, i) => {
    if (i < period - 1) return null;

    const slice = tr.slice(i - period + 1, i + 1);
    return slice.reduce((a, b) => a + b, 0) / period;
  });
}

function strategy5ScanCandles(candles) {
  const n = candles.length;
  const atr = strategy5AtrSma(candles, 14);

  let support = null;
  let resistance = null;
  let supportTested = false;
  let resistanceTested = false;
  let latestSignal = null;

  const left = 3;
  const right = 3;
  const toleranceAtr = 0.25;

  for (let k = 0; k < n; k++) {
    const pivot = k - right;

    if (pivot >= left && pivot + right < n) {
      const ph = candles[pivot].high;
      const pl = candles[pivot].low;

      let isHigh = true;
      let isLow = true;

      for (let j = pivot - left; j < pivot; j++) {
        if (!(ph > candles[j].high)) isHigh = false;
        if (!(pl < candles[j].low)) isLow = false;
      }

      for (let j = pivot + 1; j <= pivot + right; j++) {
        if (!(ph >= candles[j].high)) isHigh = false;
        if (!(pl <= candles[j].low)) isLow = false;
      }

      if (isHigh) {
        resistance = ph;
        resistanceTested = false;
      }

      if (isLow) {
        support = pl;
        supportTested = false;
      }
    }

    if (k < 14 || !Number.isFinite(atr[k]) || atr[k] <= 0) {
      continue;
    }

    const c = candles[k];
    const tol = atr[k] * toleranceAtr;

    if (
      support !== null &&
      !supportTested &&
      c.low <= support + tol &&
      c.close > support &&
      c.close > c.open
    ) {
      const entry = c.close;
      let sl = c.low;

      if (entry - sl < atr[k]) sl = entry - atr[k];

      const risk = entry - sl;

      latestSignal = {
        index: k,
        time: c.time,
        direction: "BUY",
        entry,
        stopLoss: sl,
        takeProfit: entry + risk * 2,
        support,
        resistance,
        rejection: "SUPPORT BULLISH REJECTION",
        atr: atr[k],
        risk
      };

      supportTested = true;
    } else if (
      resistance !== null &&
      !resistanceTested &&
      c.high >= resistance - tol &&
      c.close < resistance &&
      c.close < c.open
    ) {
      const entry = c.close;
      let sl = c.high;

      if (sl - entry < atr[k]) sl = entry + atr[k];

      const risk = sl - entry;

      latestSignal = {
        index: k,
        time: c.time,
        direction: "SELL",
        entry,
        stopLoss: sl,
        takeProfit: entry - risk * 2,
        support,
        resistance,
        rejection: "RESISTANCE BEARISH REJECTION",
        atr: atr[k],
        risk
      };

      resistanceTested = true;
    }
  }

  const lastIndex = n - 1;
  const currentAtr = lastIndex >= 0 ? atr[lastIndex] : null;
  const active =
    latestSignal && latestSignal.index === lastIndex
      ? latestSignal
      : null;

  return {
    success: true,
    strategy: "STRATEGY_5",
    strategyName: "XAUUSD Strategy #5 — Support / Resistance Rejection",
    instrument: OUTPUT_SYMBOL,
    executionTimeframe: "5M",
    generatedAt: new Date().toISOString(),
    currentPrice: last(candles)?.close ?? null,
    status: active ? "CONFIRMED" : "WAITING",
    executable: !!active,
    signal: active
      ? {
          direction: active.direction,
          status: active.rejection,
          signalTime: active.time
        }
      : {
          direction: null,
          status: "WAITING",
          signalTime: null
        },
    tradeLevels: active
      ? {
          entry: round(active.entry),
          stopLoss: round(active.stopLoss),
          takeProfit: round(active.takeProfit),
          risk: round(active.risk),
          rr: "1:2"
        }
      : null,
    components: {
      support: support === null ? null : round(support),
      resistance: resistance === null ? null : round(resistance),
      rejection: active ? active.rejection : "NONE",
      direction: active ? active.direction : "-",
      atr: round(currentAtr),
      swingLeft: left,
      swingRight: right,
      toleranceATR: toleranceAtr,
      tested: {
        support: supportTested,
        resistance: resistanceTested
      }
    },
    note:
      "Strategy #5 only: 3/3 swing levels, rejection candle, ATR(14) SMA, " +
      "0.25 ATR tolerance, minimum 1 ATR SL, TP 2R. Original Strategy #5 only."
  };
}

async function strategy5Scan() {
  const candles = await getCandles(TF["5M"], 5000);

  if (!candles || candles.length < 30) {
    throw new Error("Strategy #5: insufficient XAUUSD 5M candles");
  }

  return strategy5ScanCandles(candles);
}

app.get("/strategy5/decision", auth, async (req, res) => {
  try {
    const x = await strategy5Scan();

    res.status(200).json({
      ...x,
      liquidAutoTrade: LIQUID_AUTO_TRADE,
      executionAllowed: LIQUID_AUTO_TRADE && !!x.executable
    });
  } catch (e) {
    lastError = e.message;

    res.status(500).json({
      success: false,
      strategy: "STRATEGY_5",
      status: "ERROR",
      error: e.message
    });
  }
});

app.get("/strategy5/status", (req, res) =>
  res.json({
    success: true,
    strategy: "STRATEGY_5",
    status: "RUNNING",
    lastError
  })
);

/* =========================================================
   MASTER XAUUSD STRATEGIES — COMPLETE SEPARATE ENGINE
   Candlestick + Market Structure + Chart Patterns
   Signal timeframe 5M; D1/H1/15M are context only.
   Closed candles only. RR 1:3. No P78 code/routes.
   ========================================================= */

const MASTER_RR = 3;
const MASTER_IDS = new Set();
let masterLastScan = null;
let masterLastError = null;

function mBody(c){ return Math.abs(c.close-c.open); }
function mRange(c){ return Math.max(c.high-c.low,1e-9); }
function mUpper(c){ return c.high-Math.max(c.open,c.close); }
function mLower(c){ return Math.min(c.open,c.close)-c.low; }
function mBull(c){ return c.close>c.open; }
function mBear(c){ return c.close<c.open; }
function mMid(c){ return (c.open+c.close)/2; }
function mNear(a,b,t){ return Math.abs(a-b)<=t; }
function mMax(a){ return Math.max(...a); }
function mMin(a){ return Math.min(...a); }
function mEmaLast(c,period){ const x=emaSeries(c.map(z=>z.close),period); return last(x); }
function mRsiLast(c){ return last(rsiSeries(c.map(z=>z.close),14)); }
function mAtrLast(c){ return last(atrSeries(c,14)); }

function mPivots(c,left=3,right=3){
  const highs=[],lows=[];
  // A pivot is only usable after its right-side confirmation candles exist.
  for(let i=left;i<c.length-right;i++){
    let hi=true,lo=true;
    for(let j=i-left;j<=i+right;j++) if(j!==i){
      if(c[j].high>=c[i].high)hi=false;
      if(c[j].low<=c[i].low)lo=false;
    }
    if(hi)highs.push({i,p:c[i].high});
    if(lo)lows.push({i,p:c[i].low});
  }
  return {highs,lows};
}
function mEmit(out,id,side,c,atr,reason,slOverride=null){
  const x=last(c); if(!x||!atr||atr<=0)return;
  const entry=x.close;
  const fallback=side==='BUY'?mMin(c.slice(-3).map(z=>z.low))-atr*.1:mMax(c.slice(-3).map(z=>z.high))+atr*.1;
  const sl=Number.isFinite(slOverride)?slOverride:fallback;
  const risk=Math.abs(entry-sl);
  if(!Number.isFinite(risk)||risk<atr*.15)return;
  const tp=side==='BUY'?entry+risk*MASTER_RR:entry-risk*MASTER_RR;
  const key=[id,side,x.time,round(entry,3)].join('|');
  if(MASTER_IDS.has(key))return;
  out.push({setupId:id,signalKey:key,strategy:id,direction:side,signal:side,executable:true,executionAllowed:true,
    candleTime:x.time,entry:round(entry),sl:round(sl),tp:round(tp),rr:'1:3',reason});
}

function mDetectCandles(c,atr,out){
 if(c.length<5||!atr)return;
 const n=c.length,x=c[n-1],b=c[n-2],a=c[n-3],p=c[n-4],q=c[n-5];
 const body=mBody(x),range=mRange(x),up=mUpper(x),dn=mLower(x);
 const ema20=mEmaLast(c.slice(0,-1),20);
 const downContext=ema20!==null&&b.close<ema20;
 const upContext=ema20!==null&&b.close>ema20;
 const doji=body<=range*.10, small=body<=range*.30;

 // Single-candle reversal patterns; require prior trend context.
 if(dn>=Math.max(body*2,range*.45)&&up<=range*.2&&body<=range*.4&&downContext)
   mEmit(out,'CANDLE_HAMMER','BUY',c,atr,'Long lower wick, small upper body, preceding bearish context');
 if(up>=Math.max(body*2,range*.45)&&dn<=range*.2&&body<=range*.4&&downContext)
   mEmit(out,'CANDLE_INVERTED_HAMMER','BUY',c,atr,'Long upper wick after bearish context');
 if(dn>=Math.max(body*2,range*.45)&&up<=range*.2&&body<=range*.4&&upContext)
   mEmit(out,'CANDLE_HANGING_MAN','SELL',c,atr,'Long lower wick after bullish context');
 if(up>=Math.max(body*2,range*.45)&&dn<=range*.2&&body<=range*.4&&upContext)
   mEmit(out,'CANDLE_SHOOTING_STAR','SELL',c,atr,'Long upper wick after bullish context');
 if(dn>=range*.60&&up<=range*.15&&downContext)
   mEmit(out,'CANDLE_BULLISH_PIN_BAR','BUY',c,atr,'Lower wick >=60% of range in bearish context');
 if(up>=range*.60&&dn<=range*.15&&upContext)
   mEmit(out,'CANDLE_BEARISH_PIN_BAR','SELL',c,atr,'Upper wick >=60% of range in bullish context');
 if(body>=range*.85&&mBull(x))mEmit(out,'CANDLE_BULLISH_MARUBOZU','BUY',c,atr,'Bull body >=85% of range');
 if(body>=range*.85&&mBear(x))mEmit(out,'CANDLE_BEARISH_MARUBOZU','SELL',c,atr,'Bear body >=85% of range');
 if(small&&up>=range*.2&&dn>=range*.2){
   if(x.close>b.high)mEmit(out,'CANDLE_SPINNING_TOP_BULL_BREAK','BUY',c,atr,'Small body with two wicks, then close above prior high');
   if(x.close<b.low)mEmit(out,'CANDLE_SPINNING_TOP_BEAR_BREAK','SELL',c,atr,'Small body with two wicks, then close below prior low');
 }
 if(doji){
   if(downContext&&mBull(x)&&x.close>b.high)mEmit(out,'CANDLE_DOJI_BULLISH_CONFIRM','BUY',c,atr,'Doji followed by bullish close break');
   if(upContext&&mBear(x)&&x.close<b.low)mEmit(out,'CANDLE_DOJI_BEARISH_CONFIRM','SELL',c,atr,'Doji followed by bearish close break');
   if(dn>=range*.6&&up<=range*.1)mEmit(out,'CANDLE_DRAGONFLY_DOJI','BUY',c,atr,'Dragonfly Doji geometry with bullish close confirmation');
   if(up>=range*.6&&dn<=range*.1)mEmit(out,'CANDLE_GRAVESTONE_DOJI','SELL',c,atr,'Gravestone Doji geometry with bearish close confirmation');
 }
 // Engulfing / Harami families.
 if(mBear(b)&&mBull(x)&&x.open<=b.close&&x.close>=b.open){
   mEmit(out,'CANDLE_BULLISH_ENGULFING','BUY',c,atr,'Bull body fully engulfs prior bear body');
   if(mBear(a)&&mBody(b)<mBody(a)*.7)mEmit(out,'CANDLE_THREE_OUTSIDE_UP','BUY',c,atr,'Bear, bullish engulfing, follow-through');
 }
 if(mBull(b)&&mBear(x)&&x.open>=b.close&&x.close<=b.open){
   mEmit(out,'CANDLE_BEARISH_ENGULFING','SELL',c,atr,'Bear body fully engulfs prior bull body');
   if(mBull(a)&&mBody(b)<mBody(a)*.7)mEmit(out,'CANDLE_THREE_OUTSIDE_DOWN','SELL',c,atr,'Bull, bearish engulfing, follow-through');
 }
 if(mBear(a)&&mBody(b)<=mRange(b)*.3&&mBull(x)&&x.close>mMid(a)){
   mEmit(out,'CANDLE_MORNING_STAR','BUY',c,atr,'Bear impulse, small middle candle, bull closes above first-body midpoint');
   if(mBody(b)<=mRange(b)*.1)mEmit(out,'CANDLE_MORNING_DOJI_STAR','BUY',c,atr,'Morning Star with Doji middle candle');
 }
 if(mBull(a)&&mBody(b)<=mRange(b)*.3&&mBear(x)&&x.close<mMid(a)){
   mEmit(out,'CANDLE_EVENING_STAR','SELL',c,atr,'Bull impulse, small middle candle, bear closes below first-body midpoint');
   if(mBody(b)<=mRange(b)*.1)mEmit(out,'CANDLE_EVENING_DOJI_STAR','SELL',c,atr,'Evening Star with Doji middle candle');
 }
 if(mBear(b)&&mBull(x)&&x.open>b.close&&x.close<b.open){
   mEmit(out,'CANDLE_BULLISH_HARAMI','BUY',c,atr,'Bull body contained in previous bear body');
   if(doji)mEmit(out,'CANDLE_BULLISH_HARAMI_CROSS','BUY',c,atr,'Doji contained in previous bear body');
 }
 if(mBull(b)&&mBear(x)&&x.open<b.close&&x.close>b.open){
   mEmit(out,'CANDLE_BEARISH_HARAMI','SELL',c,atr,'Bear body contained in previous bull body');
   if(doji)mEmit(out,'CANDLE_BEARISH_HARAMI_CROSS','SELL',c,atr,'Doji contained in previous bull body');
 }
 if(mNear(a.low,x.low,atr*.12)&&mBull(x)&&mBear(b))mEmit(out,'CANDLE_TWEEZER_BOTTOM','BUY',c,atr,'Two similar lows followed by bullish rejection');
 if(mNear(a.high,x.high,atr*.12)&&mBear(x)&&mBull(b))mEmit(out,'CANDLE_TWEEZER_TOP','SELL',c,atr,'Two similar highs followed by bearish rejection');
 if(mBear(b)&&mBull(x)&&x.open<b.low&&x.close>mMid(b)&&x.close<b.open)mEmit(out,'CANDLE_PIERCING_LINE','BUY',c,atr,'Bull close above midpoint of prior bear body');
 if(mBull(b)&&mBear(x)&&x.open>b.high&&x.close<mMid(b)&&x.close>b.open)mEmit(out,'CANDLE_DARK_CLOUD_COVER','SELL',c,atr,'Bear close below midpoint of prior bull body');
 if(mBull(x)&&x.open<=b.low&&x.close>b.high)mEmit(out,'CANDLE_BULLISH_KICKER','BUY',c,atr,'Bullish candle gaps/opens below prior range and closes above it');
 if(mBear(x)&&x.open>=b.high&&x.close<b.low)mEmit(out,'CANDLE_BEARISH_KICKER','SELL',c,atr,'Bearish candle opens above prior range and closes below it');
 if(mBull(x)&&body>=range*.65&&x.open<=b.low&&x.close>mMid(b))mEmit(out,'CANDLE_BULLISH_BELT_HOLD','BUY',c,atr,'Strong bullish candle opens near low');
 if(mBear(x)&&body>=range*.65&&x.open>=b.high&&x.close<mMid(b))mEmit(out,'CANDLE_BEARISH_BELT_HOLD','SELL',c,atr,'Strong bearish candle opens near high');
 if(mBull(a)&&mBull(b)&&mBull(x)&&a.close<b.close&&b.close<x.close&&[a,b,x].every(z=>mBody(z)>mRange(z)*.45))mEmit(out,'CANDLE_THREE_WHITE_SOLDIERS','BUY',c,atr,'Three consecutive strong rising bullish candles');
 if(mBear(a)&&mBear(b)&&mBear(x)&&a.close>b.close&&b.close>x.close&&[a,b,x].every(z=>mBody(z)>mRange(z)*.45))mEmit(out,'CANDLE_THREE_BLACK_CROWS','SELL',c,atr,'Three consecutive strong falling bearish candles');
 // Three inside patterns: first long candle, second inside, third breaks first body/range.
 if(mBear(a)&&b.high<a.high&&b.low>a.low&&mBull(x)&&x.close>a.high)mEmit(out,'CANDLE_THREE_INSIDE_UP','BUY',c,atr,'Inside candle after bear candle then close above mother high');
 if(mBull(a)&&b.high<a.high&&b.low>a.low&&mBear(x)&&x.close<a.low)mEmit(out,'CANDLE_THREE_INSIDE_DOWN','SELL',c,atr,'Inside candle after bull candle then close below mother low');
 // Inside/outside bar breakouts.
 if(b.high<a.high&&b.low>a.low&&x.close>a.high)mEmit(out,'CANDLE_INSIDE_BAR_BULL_BREAK','BUY',c,atr,'Close above mother candle high');
 if(b.high<a.high&&b.low>a.low&&x.close<a.low)mEmit(out,'CANDLE_INSIDE_BAR_BEAR_BREAK','SELL',c,atr,'Close below mother candle low');
 if(x.high>b.high&&x.low<b.low&&mBull(x)&&x.close>b.high)mEmit(out,'CANDLE_OUTSIDE_BAR_BULL','BUY',c,atr,'Bull outside candle closes beyond prior high');
 if(x.high>b.high&&x.low<b.low&&mBear(x)&&x.close<b.low)mEmit(out,'CANDLE_OUTSIDE_BAR_BEAR','SELL',c,atr,'Bear outside candle closes beyond prior low');
 // Continuation patterns.
 if(c.length>=5){const z=c.slice(-5);if(mBull(z[0])&&mBody(z[0])>mRange(z[0])*.55&&z.slice(1,4).every(y=>y.high<z[0].high&&y.low>z[0].low)&&mBull(z[4])&&z[4].close>z[0].close)mEmit(out,'CANDLE_RISING_THREE_METHODS','BUY',c,atr,'Strong bull impulse, three contained pullback candles, continuation close');if(mBear(z[0])&&mBody(z[0])>mRange(z[0])*.55&&z.slice(1,4).every(y=>y.high<z[0].high&&y.low>z[0].low)&&mBear(z[4])&&z[4].close<z[0].close)mEmit(out,'CANDLE_FALLING_THREE_METHODS','SELL',c,atr,'Strong bear impulse, three contained pullback candles, continuation close');}
 // Tasuki continuation (gap-dependent; frequently absent in spot gold).
 if(mBull(b)&&mBull(a)&&mBear(x)&&x.open>b.close&&x.close>a.close&&x.close<b.close)mEmit(out,'CANDLE_UPSIDE_TASUKI_GAP','BUY',c,atr,'Bull gap continuation with partial bearish fill');
 if(mBear(b)&&mBear(a)&&mBull(x)&&x.open<b.close&&x.close<a.close&&x.close>b.close)mEmit(out,'CANDLE_DOWNSIDE_TASUKI_GAP','SELL',c,atr,'Bear gap continuation with partial bullish fill');
 // Mat Hold: bull impulse, shallow contained pause, new high close; inverse for bear.
 if(mBull(q)&&mBody(q)>mRange(q)*.55&&[p,a,b].every(z=>z.low>q.low&&z.close<q.close)&&mBull(x)&&x.close>q.high)mEmit(out,'CANDLE_MAT_HOLD_BULL','BUY',c,atr,'Bull impulse, shallow pause, continuation break');
 if(mBear(q)&&mBody(q)>mRange(q)*.55&&[p,a,b].every(z=>z.high<q.high&&z.close>q.close)&&mBear(x)&&x.close<q.low)mEmit(out,'CANDLE_MAT_HOLD_BEAR','SELL',c,atr,'Bear impulse, shallow pause, continuation break');
 // Abandoned Baby proxy: isolated Doji-like middle candle and reversal close.
 if(mBear(a)&&mBody(b)<=mRange(b)*.1&&b.high<a.low&&mBull(x)&&x.low>b.high&&x.close>mMid(a))mEmit(out,'CANDLE_ABANDONED_BABY_BULL','BUY',c,atr,'Bullish separated Doji reversal; requires genuine gap');
 if(mBull(a)&&mBody(b)<=mRange(b)*.1&&b.low>a.high&&mBear(x)&&x.high<b.low&&x.close<mMid(a))mEmit(out,'CANDLE_ABANDONED_BABY_BEAR','SELL',c,atr,'Bearish separated Doji reversal; requires genuine gap');
 // Momentum candle strategies: large body, close near directional extreme.
 if(mBull(x)&&body>=range*.70&&up<=range*.15)mEmit(out,'CANDLE_BULLISH_MOMENTUM','BUY',c,atr,'Bull body >=70% and close near high');
 if(mBear(x)&&body>=range*.70&&dn<=range*.15)mEmit(out,'CANDLE_BEARISH_MOMENTUM','SELL',c,atr,'Bear body >=70% and close near low');
 // Belt Hold strict open-near-extreme form.
 if(mBull(x)&&body>=range*.65&&dn<=range*.10)mEmit(out,'CANDLE_BULLISH_BELT_HOLD','BUY',c,atr,'Bull body opens at/near low and closes strongly');
 if(mBear(x)&&body>=range*.65&&up<=range*.10)mEmit(out,'CANDLE_BEARISH_BELT_HOLD','SELL',c,atr,'Bear body opens at/near high and closes strongly');
 // Doji continuation is triggered only by a confirmed break of its range.
 if(mBody(b)<=mRange(b)*.10&&x.close>b.high)mEmit(out,'CANDLE_DOJI_CONTINUATION_BULL','BUY',c,atr,'Close breaks prior Doji high');
 if(mBody(b)<=mRange(b)*.10&&x.close<b.low)mEmit(out,'CANDLE_DOJI_CONTINUATION_BEAR','SELL',c,atr,'Close breaks prior Doji low');
}

function mDetectStructure(c,atr,out){
 if(c.length<50||!atr)return;
 const {highs,lows}=mPivots(c,3,3),x=last(c),prev=c[c.length-2];
 const h=last(highs),h2=highs.at(-2),l=last(lows),l2=lows.at(-2);
 if(h&&prev.close<=h.p&&x.close>h.p)mEmit(out,'STRUCTURE_BOS_BULL','BUY',c,atr,'Closed break above confirmed swing high');
 if(l&&prev.close>=l.p&&x.close<l.p)mEmit(out,'STRUCTURE_BOS_BEAR','SELL',c,atr,'Closed break below confirmed swing low');
 const up=!!(h&&h2&&l&&l2&&h.p>h2.p&&l.p>l2.p),down=!!(h&&h2&&l&&l2&&h.p<h2.p&&l.p<l2.p);
 if(down&&h&&x.close>h.p)mEmit(out,'STRUCTURE_CHOCH_BULL','BUY',c,atr,'Bullish close breaks swing against confirmed lower-high/lower-low structure');
 if(up&&l&&x.close<l.p)mEmit(out,'STRUCTURE_CHOCH_BEAR','SELL',c,atr,'Bearish close breaks swing against confirmed higher-high/higher-low structure');
 if(h&&x.high>h.p&&x.close<h.p)mEmit(out,'STRUCTURE_BSL_SWEEP','SELL',c,atr,'Wick takes confirmed swing high, close returns below');
 if(l&&x.low<l.p&&x.close>l.p)mEmit(out,'STRUCTURE_SSL_SWEEP','BUY',c,atr,'Wick takes confirmed swing low, close returns above');
 if(l&&x.low<=l.p+atr*.25&&x.close>l.p&&mBull(x))mEmit(out,'STRUCTURE_SUPPORT_REJECTION','BUY',c,atr,'Bullish rejection near confirmed swing low');
 if(h&&x.high>=h.p-atr*.25&&x.close<h.p&&mBear(x))mEmit(out,'STRUCTURE_RESISTANCE_REJECTION','SELL',c,atr,'Bearish rejection near confirmed swing high');
 // FVG from three closed candles.
 const a=c[c.length-3];if(a.high<x.low)mEmit(out,'STRUCTURE_BULLISH_FVG','BUY',c,atr,'Bullish three-candle fair-value gap');
 if(a.low>x.high)mEmit(out,'STRUCTURE_BEARISH_FVG','SELL',c,atr,'Bearish three-candle fair-value gap');
 // Displacement candle after opposite candle = candidate order block, not automatic retest.
 const b=prev;if(mBear(b)&&mBull(x)&&x.close>b.high&&mBody(x)>atr*.7)mEmit(out,'STRUCTURE_BULLISH_ORDER_BLOCK_BREAK','BUY',c,atr,'Bull displacement through prior bearish candle high');
 if(mBull(b)&&mBear(x)&&x.close<b.low&&mBody(x)>atr*.7)mEmit(out,'STRUCTURE_BEARISH_ORDER_BLOCK_BREAK','SELL',c,atr,'Bear displacement through prior bullish candle low');
 // EMA pullback only for pullback strategy.
 const e20=mEmaLast(c,20),e50=mEmaLast(c,50);
 if(e20&&e50&&e20>e50&&x.low<=e20&&x.close>e20&&mBull(x))mEmit(out,'STRUCTURE_BULL_TREND_PULLBACK','BUY',c,atr,'EMA20 above EMA50 and bullish pullback close above EMA20');
 if(e20&&e50&&e20<e50&&x.high>=e20&&x.close<e20&&mBear(x))mEmit(out,'STRUCTURE_BEAR_TREND_PULLBACK','SELL',c,atr,'EMA20 below EMA50 and bearish pullback close below EMA20');
 // Premium/discount approximation based on latest confirmed swing range.
 if(h&&l&&h.i>l.i){const mid=(h.p+l.p)/2;if(x.close<mid&&mBull(x)&&x.close>prev.high)mEmit(out,'STRUCTURE_DISCOUNT_BUY','BUY',c,atr,'Bullish break from lower half of latest swing range');if(x.close>mid&&mBear(x)&&x.close<prev.low)mEmit(out,'STRUCTURE_PREMIUM_SELL','SELL',c,atr,'Bearish break from upper half of latest swing range');}
 // Supply/demand zones use prior opposite candle and displacement close.
 if(c.length>=3){const z=c[c.length-2];if(mBear(z)&&mBull(x)&&x.close>z.high&&mBody(x)>atr*.6)mEmit(out,'STRUCTURE_DEMAND_RECLAIM','BUY',c,atr,'Demand candidate reclaimed by bullish displacement');if(mBull(z)&&mBear(x)&&x.close<z.low&&mBody(x)>atr*.6)mEmit(out,'STRUCTURE_SUPPLY_REJECT','SELL',c,atr,'Supply candidate rejected by bearish displacement');}
 // Break-and-retest is a separate entry: a previously broken swing is touched and held now.
 if(h&&c.length>=4&&c.slice(-4,-1).some(z=>z.close>h.p)&&x.low<=h.p+atr*.15&&x.close>h.p&&mBull(x))mEmit(out,'STRUCTURE_BOS_BULL_RETEST','BUY',c,atr,'Prior swing-high breakout followed by held retest');
 if(l&&c.length>=4&&c.slice(-4,-1).some(z=>z.close<l.p)&&x.high>=l.p-atr*.15&&x.close<l.p&&mBear(x))mEmit(out,'STRUCTURE_BOS_BEAR_RETEST','SELL',c,atr,'Prior swing-low breakdown followed by held retest');
 // Inducement proxy: a local liquidity level is swept, then price closes back through it.
 if(l&&x.low<l.p&&x.close>l.p&&mBull(x)&&mLower(x)>mBody(x))mEmit(out,'STRUCTURE_INDUCEMENT_SSL','BUY',c,atr,'Sell-side liquidity sweep with strong lower-wick reclaim');
 if(h&&x.high>h.p&&x.close<h.p&&mBear(x)&&mUpper(x)>mBody(x))mEmit(out,'STRUCTURE_INDUCEMENT_BSL','SELL',c,atr,'Buy-side liquidity sweep with strong upper-wick rejection');
 // Mitigation-block retest: detect a recent opposite candle displaced through, then retested.
 for(let j=Math.max(0,c.length-8);j<c.length-2;j++){
   const ob=c[j],breakC=c[j+1];
   if(mBear(ob)&&mBull(breakC)&&breakC.close>ob.high&&x.low<=Math.max(ob.open,ob.close)&&x.close>ob.high&&mBull(x)){
     mEmit(out,'STRUCTURE_BULLISH_MITIGATION_BLOCK','BUY',c,atr,'Retest of previously displaced bearish candle zone');break;
   }
   if(mBull(ob)&&mBear(breakC)&&breakC.close<ob.low&&x.high>=Math.min(ob.open,ob.close)&&x.close<ob.low&&mBear(x)){
     mEmit(out,'STRUCTURE_BEARISH_MITIGATION_BLOCK','SELL',c,atr,'Retest of previously displaced bullish candle zone');break;
   }
 }
}

function mDetectCharts(c,atr,out){
 if(c.length<80||!atr)return;
 const x=last(c),p=c[c.length-2],recent=c.slice(-30,-1),hi=mMax(recent.map(z=>z.high)),lo=mMin(recent.map(z=>z.low));
 if(x.close>hi)mEmit(out,'CHART_RECTANGLE_BULL_BREAK','BUY',c,atr,'Closed break above 29-candle range');
 if(x.close<lo)mEmit(out,'CHART_RECTANGLE_BEAR_BREAK','SELL',c,atr,'Closed break below 29-candle range');
 const r1=c.slice(-13,-7),r2=c.slice(-7,-1),h1=mMax(r1.map(z=>z.high)),l1=mMin(r1.map(z=>z.low)),h2=mMax(r2.map(z=>z.high)),l2=mMin(r2.map(z=>z.low));
 if(h2<h1&&l2>l1&&x.close>h1)mEmit(out,'CHART_TRIANGLE_BULL_BREAK','BUY',c,atr,'Contracting range with bullish breakout');
 if(h2<h1&&l2>l1&&x.close<l1)mEmit(out,'CHART_TRIANGLE_BEAR_BREAK','SELL',c,atr,'Contracting range with bearish breakout');
 const impulse=c[c.length-7],cons=c.slice(-6,-1),ch=mMax(cons.map(z=>z.high)),cl=mMin(cons.map(z=>z.low));
 if(impulse.close-impulse.open>atr*1.5&&x.close>ch)mEmit(out,'CHART_BULL_FLAG_BREAK','BUY',c,atr,'Strong bullish impulse, short consolidation, close breakout');
 if(impulse.open-impulse.close>atr*1.5&&x.close<cl)mEmit(out,'CHART_BEAR_FLAG_BREAK','SELL',c,atr,'Strong bearish impulse, short consolidation, close breakout');
 if(h2<h1&&l2>l1&&x.close>h2)mEmit(out,'CHART_WEDGE_BULL_BREAK','BUY',c,atr,'Contracting wedge approximation breaks upward');
 if(h2<h1&&l2>l1&&x.close<l2)mEmit(out,'CHART_WEDGE_BEAR_BREAK','SELL',c,atr,'Contracting wedge approximation breaks downward');
 // Pivot-based double/triple tops/bottoms and H&S candidates; only confirmed pivots.
 const {highs,lows}=mPivots(c,3,3),tol=atr*.35;
 if(highs.length>=2){const z=highs.slice(-2);if(mNear(z[0].p,z[1].p,tol)&&x.close<Math.min(z[0].p,z[1].p)&&x.close<p.close)mEmit(out,'CHART_DOUBLE_TOP','SELL',c,atr,'Two similar confirmed highs with bearish neckline-side close');}
 if(lows.length>=2){const z=lows.slice(-2);if(mNear(z[0].p,z[1].p,tol)&&x.close>Math.max(z[0].p,z[1].p)&&x.close>p.close)mEmit(out,'CHART_DOUBLE_BOTTOM','BUY',c,atr,'Two similar confirmed lows with bullish neckline-side close');}
 if(highs.length>=3){const z=highs.slice(-3);if(mNear(z[0].p,z[1].p,tol)&&mNear(z[1].p,z[2].p,tol)&&x.close<z[2].p)mEmit(out,'CHART_TRIPLE_TOP','SELL',c,atr,'Three similar confirmed highs and bearish close');if(z[1].p>z[0].p&&z[1].p>z[2].p&&mNear(z[0].p,z[2].p,tol)&&x.close<Math.min(z[0].p,z[2].p))mEmit(out,'CHART_HEAD_SHOULDERS','SELL',c,atr,'Pivot approximation: higher head, similar shoulders, downside close');}
 if(lows.length>=3){const z=lows.slice(-3);if(mNear(z[0].p,z[1].p,tol)&&mNear(z[1].p,z[2].p,tol)&&x.close>z[2].p)mEmit(out,'CHART_TRIPLE_BOTTOM','BUY',c,atr,'Three similar confirmed lows and bullish close');if(z[1].p<z[0].p&&z[1].p<z[2].p&&mNear(z[0].p,z[2].p,tol)&&x.close>Math.max(z[0].p,z[2].p))mEmit(out,'CHART_INVERSE_HEAD_SHOULDERS','BUY',c,atr,'Pivot approximation: lower head, similar shoulders, upside close');}
 // Separate ascending/descending/symmetrical triangle candidates from six-bar compression.
 const flatTol=atr*.30;
 if(mNear(h1,h2,flatTol)&&l2>l1&&x.close>h1)mEmit(out,'CHART_ASCENDING_TRIANGLE_BULL','BUY',c,atr,'Near-flat resistance with rising lows and close breakout');
 if(mNear(l1,l2,flatTol)&&h2<h1&&x.close<l1)mEmit(out,'CHART_DESCENDING_TRIANGLE_BEAR','SELL',c,atr,'Near-flat support with falling highs and close breakdown');
 if(h2<h1&&l2>l1&&x.close>h1)mEmit(out,'CHART_SYMMETRICAL_TRIANGLE_BULL','BUY',c,atr,'Lower highs and higher lows then upside breakout');
 if(h2<h1&&l2>l1&&x.close<l1)mEmit(out,'CHART_SYMMETRICAL_TRIANGLE_BEAR','SELL',c,atr,'Lower highs and higher lows then downside breakdown');
 // Pennant candidates require an impulse then a contracting consolidation.
 if(impulse.close-impulse.open>atr*1.5&&h2<h1&&l2>l1&&x.close>h1)mEmit(out,'CHART_BULL_PENNANT','BUY',c,atr,'Bull impulse then contracting pennant breakout');
 if(impulse.open-impulse.close>atr*1.5&&h2<h1&&l2>l1&&x.close<l1)mEmit(out,'CHART_BEAR_PENNANT','SELL',c,atr,'Bear impulse then contracting pennant breakdown');
 // Inverse cup/handle approximation.
 if(cup.length===27){const il=cup.slice(0,7),ir=cup.slice(-7),ilAvg=il.reduce((s,z)=>s+z.close,0)/il.length,irAvg=ir.reduce((s,z)=>s+z.close,0)/ir.length;if(mNear(ilAvg,irAvg,atr*1.2)&&x.close<cl&&x.close<ilAvg)mEmit(out,'CHART_INVERSE_CUP_HANDLE','SELL',c,atr,'Rounded top approximation with handle breakdown');}
 // ORB: use first 15-minute-equivalent range of the UTC day on 5m bars.
 const day=x.time?String(x.time).slice(0,10):'';const todays=c.filter(z=>String(z.time).slice(0,10)===day);if(todays.length>=4){const opening=todays.slice(0,3),oh=mMax(opening.map(z=>z.high)),ol=mMin(opening.map(z=>z.low));if(x.close>oh&&p.close<=oh)mEmit(out,'CHART_ORB_BULL_BREAK','BUY',c,atr,'Close above first three 5m candles of UTC day');if(x.close<ol&&p.close>=ol)mEmit(out,'CHART_ORB_BEAR_BREAK','SELL',c,atr,'Close below first three 5m candles of UTC day');}
}

async function masterScan(){
 const [d1,h1,m15,m5]=await Promise.all([getCandles('1day',300),getCandles('1h',500),getCandles('15min',500),getCandles('5min',1000)]);
 if(m5.length<100)throw new Error('Insufficient closed 5M candles');
 const atr=mAtrLast(m5),raw=[];
 mDetectCandles(m5,atr,raw);mDetectStructure(m5,atr,raw);mDetectCharts(m5,atr,raw);
 const seen=new Set(),setups=[];
 for(const s of raw){if(seen.has(s.signalKey))continue;seen.add(s.signalKey);setups.push({...s,instrument:OUTPUT_SYMBOL,timeframe:'5M',candleTime:last(m5).time});}
 masterLastScan={generatedAt:new Date().toISOString(),closedCandleTime:last(m5).time,count:setups.length,setups};
 masterLastError=null;
 return {success:true,strategy:'MASTER_XAUUSD',instrument:OUTPUT_SYMBOL,generatedAt:masterLastScan.generatedAt,closedCandleTime:last(m5).time,
   timeframes:{D1:last(d1)?.close??null,H1:last(h1)?.close??null,M15:last(m15)?.close??null,M5:last(m5)?.close??null},rr:'1:3',maxRiskPercent:1,
   executable:setups.length>0,executionAllowed:LIQUID_AUTO_TRADE&&setups.length>0,signal:setups.length?'MULTIPLE_SETUPS':'WAIT',setups,
   note:'Independent heuristic setup modules; all signals use closed candles. Complex chart formations are approximations and require backtesting before live use.'};
}

app.get('/master/decision',auth,async(req,res)=>{
 try{res.json(await masterScan());}catch(e){masterLastError=e.message;res.status(503).json({success:false,strategy:'MASTER_XAUUSD',executable:false,executionAllowed:false,signal:'WAIT',setups:[],error:e.message});}
});
app.get('/master/status',(req,res)=>res.json({success:true,strategy:'MASTER_XAUUSD',status:'RUNNING',lastScan:masterLastScan,lastError:masterLastError,rr:'1:3',riskCapPercent:1}));
app.get('/health',(req,res)=>res.json({success:true,instrument:OUTPUT_SYMBOL,strategies:['STRATEGY_5','MASTER_XAUUSD'],p78:false}));
app.get('/status',(req,res)=>res.json({success:true,instrument:OUTPUT_SYMBOL,strategies:{strategy5:'RUNNING',master:'RUNNING',p78:'REMOVED'},lastError,masterLastError}));

app.listen(PORT,'0.0.0.0',()=>console.log(`XAUUSD Strategy #5 + Master Strategies server listening on ${PORT}`));

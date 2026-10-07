// P78 SERVER
// Conditions ONLY:
// 1. CandleStrength != Weak
// 2. MTF_Score >= 5
// 3. RetestHeld == true
// Future 25-candle Continuation = REMOVED
//
// Backtest: 354 trades | 277W | 77L | 78.25% | +255.40R

import express from "express";

const app = express();
app.use(express.json());

app.use((req,res,next)=>{
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type,X-HF-Secret");
  if(req.method==="OPTIONS") return res.status(204).end();
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

const TF = {
  "1H":"1h",
  "15M":"15min",
  "5M":"5min"
};

const CACHE = new Map();
const CACHE_MS = 15000;

let lastScan = null;
let lastSignalKey = null;
let lastTelegram = null;
let lastError = null;
let telegramEnabled = true;

function num(v,d=null){
  const n=Number(v);
  return Number.isFinite(n)?n:d;
}

function round(v,d=5){
  return Number.isFinite(v)
    ? Math.round(v*10**d)/10**d
    : null;
}

function last(a){
  return a?.length ? a[a.length-1] : null;
}

function ema(values,period){
  if(values.length<period) return null;

  let s=0;

  for(let i=0;i<period;i++)
    s+=values[i];

  let e=s/period;
  const k=2/(period+1);

  for(let i=period;i<values.length;i++)
    e=values[i]*k+e*(1-k);

  return e;
}

function rsi(values,period=14){
  if(values.length<period+1) return null;

  let gain=0;
  let loss=0;

  for(let i=1;i<=period;i++){
    const d=values[i]-values[i-1];

    if(d>=0) gain+=d;
    else loss-=d;
  }

  let ag=gain/period;
  let al=loss/period;

  for(let i=period+1;i<values.length;i++){
    const d=values[i]-values[i-1];
    const g=Math.max(d,0);
    const l=Math.max(-d,0);

    ag=(ag*(period-1)+g)/period;
    al=(al*(period-1)+l)/period;
  }

  if(al===0) return 100;

  return 100-100/(1+ag/al);
}

function atrSeries(candles,period=14){

  const out=Array(candles.length).fill(null);

  if(candles.length<period+1)
    return out;

  const tr=[];

  for(let i=0;i<candles.length;i++){

    if(i===0){
      tr.push(candles[i].high-candles[i].low);
    }else{
      tr.push(
        Math.max(
          candles[i].high-candles[i].low,
          Math.abs(candles[i].high-candles[i-1].close),
          Math.abs(candles[i].low-candles[i-1].close)
        )
      );
    }
  }

  let a=0;

  for(let i=0;i<period;i++)
    a+=tr[i+1];

  a/=period;

  out[period]=a;

  for(let i=period+1;i<candles.length;i++)
    a=(a*(period-1)+tr[i])/period,
    out[i]=a;

  return out;
}

function normalize(values){

  return values
    .map(x=>({
      time:x.datetime,
      open:num(x.open),
      high:num(x.high),
      low:num(x.low),
      close:num(x.close),
      volume:num(x.volume)
    }))
    .filter(
      x=>x.time &&
      [x.open,x.high,x.low,x.close].every(Number.isFinite)
    )
    .sort(
      (a,b)=>new Date(a.time)-new Date(b.time)
    );
}

async function getCandles(interval,outputsize=500){

  const key=`${interval}-${outputsize}`;
  const cached=CACHE.get(key);

  if(
    cached &&
    Date.now()-cached.t<CACHE_MS
  ){
    return cached.d;
  }

  let err=null;

  if(TWELVE_DATA_API_KEY){

    try{

      const url=
        `https://api.twelvedata.com/time_series`+
        `?symbol=${encodeURIComponent(SYMBOL)}`+
        `&interval=${encodeURIComponent(interval)}`+
        `&outputsize=${outputsize}`+
        `&apikey=${encodeURIComponent(TWELVE_DATA_API_KEY)}`;

      const response=await fetch(url);
      const json=await response.json();

      if(
        !response.ok ||
        json.status==="error" ||
        !json.values
      ){
        throw new Error(
          json.message || "Twelve Data error"
        );
      }

      const candles=normalize(json.values);

      CACHE.set(key,{
        t:Date.now(),
        d:candles
      });

      return candles;

    }catch(e){
      err=e;
    }
  }

  try{

    const intervalMap={
      "1h":"1h",
      "15min":"15m",
      "5min":"5m"
    };

    const url=
      `https://biquote.io/api/XAUUSD/ohlc`+
      `?interval=${intervalMap[interval]||interval}`+
      `&limit=${Math.min(Math.max(outputsize,100),1000)}`;

    const response=await fetch(url);
    const json=await response.json();

    if(
      !response.ok ||
      !Array.isArray(json.bars)
    ){
      throw new Error(
        json.message || "Biquote error"
      );
    }

    const candles=json.bars
      .filter(x=>!x.isOpen)
      .map(x=>({
        time:x.openTime,
        open:num(x.open),
        high:num(x.high),
        low:num(x.low),
        close:num(x.close),
        volume:num(x.volume)||num(x.tickVolume)
      }))
      .filter(
        x=>x.time &&
        [x.open,x.high,x.low,x.close].every(Number.isFinite)
      )
      .sort(
        (a,b)=>new Date(a.time)-new Date(b.time)
      );

    if(candles.length<60)
      throw new Error("Insufficient candles");

    CACHE.set(key,{
      t:Date.now(),
      d:candles
    });

    return candles;

  }catch(e){

    throw new Error(
      `Data error: ${
        err?.message || "Twelve Data unavailable"
      }; ${e.message}`
    );
  }
}

function detectSwings(
  candles,
  left=2,
  right=2
){

  const highs=[];
  const lows=[];

  for(
    let i=left;
    i<candles.length-right;
    i++
  ){

    let highPivot=true;
    let lowPivot=true;

    for(
      let j=i-left;
      j<=i+right;
      j++
    ){

      if(j===i) continue;

      if(
        candles[j].high>=
        candles[i].high
      ){
        highPivot=false;
      }

      if(
        candles[j].low<=
        candles[i].low
      ){
        lowPivot=false;
      }
    }

    if(highPivot)
      highs.push({
        index:i,
        price:candles[i].high
      });

    if(lowPivot)
      lows.push({
        index:i,
        price:candles[i].low
      });
  }

  return {highs,lows};
}

function trendline(p1,p2){

  if(
    !p1 ||
    !p2 ||
    p2.index===p1.index
  ){
    return null;
  }

  const slope=
    (p2.price-p1.price)/
    (p2.index-p1.index);

  return {
    start:p1,
    end:p2,
    slope,
    priceAt:i=>
      p1.price+slope*(i-p1.index)
  };
}

function trendlineBreakouts(
  candles,
  direction
){

  const swings=
    detectSwings(candles,2,2);

  const atr=
    atrSeries(candles,14);

  const signals=[];

  const points=
    direction==="BUY"
      ? swings.highs
      : swings.lows;

  for(
    let j=1;
    j<points.length;
    j++
  ){

    const p1=points[j-1];
    const p2=points[j];

    if(
      direction==="BUY" &&
      p2.price>=p1.price
    ){
      continue;
    }

    if(
      direction==="SELL" &&
      p2.price<=p1.price
    ){
      continue;
    }

    const tl=
      trendline(p1,p2);

    if(!tl) continue;

    for(
      let k=Math.max(40,p2.index+1);
      k<candles.length;
      k++
    ){

      if(
        !Number.isFinite(atr[k]) ||
        atr[k]<=0
      ){
        continue;
      }

      const line=tl.priceAt(k);
      const prevLine=tl.priceAt(k-1);
      const tolerance=atr[k]*0.08;

      const breakout=
        direction==="BUY"
          ?
          candles[k].close >
            line+tolerance*0.15 &&
          candles[k-1].close <=
            prevLine+tolerance*0.15
          :
          candles[k].close <
            line-tolerance*0.15 &&
          candles[k-1].close >=
            prevLine-tolerance*0.15;

      if(breakout){

        signals.push({
          index:k,
          price:candles[k].close,
          atr:atr[k],
          trendline:tl
        });

        break;
      }
    }
  }

  return signals;
}

function candleStrength(
  candles,
  index,
  direction,
  atr
){

  const candle=candles[index];

  const range=
    candle.high-candle.low;

  const body=
    Math.abs(
      candle.close-candle.open
    );

  const bodyRatio=
    range>0
      ? body/range
      : 0;

  const closeLocation=
    direction==="BUY"
      ?
      (
        range>0
          ? (candle.close-candle.low)/range
          : 0
      )
      :
      (
        range>0
          ? (candle.high-candle.close)/range
          : 0
      );

  const strong=
    bodyRatio>=0.55 &&
    closeLocation>=0.65;

  const displacement=
    atr[index]>0 &&
    range>=atr[index]*1.10 &&
    bodyRatio>=0.60;

  return {
    strength:
      displacement
        ? "Strong"
        : strong
          ? "Valid"
          : "Weak",

    bodyRatio,
    closeLocation,
    displacement
  };
}

function valueAtOrBefore(
  candles,
  time,
  callback
){

  const target=
    new Date(time).getTime();

  let low=0;
  let high=candles.length-1;
  let best=-1;

  while(low<=high){

    const mid=
      (low+high)>>1;

    const t=
      new Date(
        candles[mid].time
      ).getTime();

    if(t<=target){
      best=mid;
      low=mid+1;
    }else{
      high=mid-1;
    }
  }

  return best>=0
    ? callback(candles[best],best)
    : null;
}

function mtfScore(
  candles1H,
  candles15M,
  time,
  direction
){

  const h1=
    valueAtOrBefore(
      candles1H,
      time,
      (_,i)=>{

        const closes=
          candles1H
            .slice(0,i+1)
            .map(x=>x.close);

        return {
          ema20:ema(closes,20),
          ema50:ema(closes,50),
          rsi:rsi(closes,14)
        };
      }
    );

  const m15=
    valueAtOrBefore(
      candles15M,
      time,
      (_,i)=>{

        const closes=
          candles15M
            .slice(0,i+1)
            .map(x=>x.close);

        return {
          ema20:ema(closes,20),
          ema50:ema(closes,50),
          rsi:rsi(closes,14)
        };
      }
    );

  if(!h1 || !m15)
    return {
      score:0,
      h1,
      m15
    };

  let score=0;

  if(direction==="BUY"){

    if(h1.ema20>h1.ema50)
      score+=2;

    if(h1.rsi>50)
      score+=1;

    if(m15.ema20>m15.ema50)
      score+=2;

    if(m15.rsi>50)
      score+=1;

  }else{

    if(h1.ema20<h1.ema50)
      score+=2;

    if(h1.rsi<50)
      score+=1;

    if(m15.ema20<m15.ema50)
      score+=2;

    if(m15.rsi<50)
      score+=1;
  }

  return {
    score,
    h1,
    m15
  };
}

function retestHeld(
  candles,
  breakoutIndex,
  direction,
  breakoutPrice,
  atr
){

  const end=
    Math.min(
      breakoutIndex+25,
      candles.length
    );

  const tolerance=
    atr[breakoutIndex]*0.08;

  for(
    let j=breakoutIndex+1;
    j<end;
    j++
  ){

    const touched=
      direction==="BUY"
        ?
        candles[j].low <=
        breakoutPrice+tolerance
        :
        candles[j].high >=
        breakoutPrice-tolerance;

    if(touched){

      return {
        touched:true,
        held:
          direction==="BUY"
            ?
            candles[j].close>breakoutPrice
            :
            candles[j].close<breakoutPrice,

        index:j,
        price:candles[j].close
      };
    }
  }

  return {
    touched:false,
    held:false,
    index:null,
    price:null
  };
}

async function p78Scan(){

  const [
    candles1H,
    candles15M,
    candles5M
  ]=await Promise.all([
    getCandles(TF["1H"],500),
    getCandles(TF["15M"],500),
    getCandles(TF["5M"],500)
  ]);

  const atr=
    atrSeries(candles5M,14);

  const candidates=[];

  for(
    const direction of
    ["BUY","SELL"]
  ){

    const breakouts=
      trendlineBreakouts(
        candles5M,
        direction
      );

    for(
      const breakout of breakouts
    ){

      const k=
        breakout.index;

      if(
        k>=candles5M.length-1
      ){
        continue;
      }

      if(
        candles5M.length-1-k>25
      ){
        continue;
      }

      const candle=
        candleStrength(
          candles5M,
          k,
          direction,
          atr
        );

      /*
        P78 CONDITION 1
        CandleStrength != Weak
      */
      if(
        candle.strength==="Weak"
      ){
        continue;
      }

      const mtf=
        mtfScore(
          candles1H,
          candles15M,
          candles5M[k].time,
          direction
        );

      /*
        P78 CONDITION 2
        MTF_Score >= 5
      */
      if(mtf.score<5){
        continue;
      }

      const retest=
        retestHeld(
          candles5M,
          k,
          direction,
          candles5M[k].close,
          atr
        );

      /*
        P78 CONDITION 3
        RetestHeld == true
      */
      if(!retest.held){
        continue;
      }

      const entry=
        candles5M[k].close;

      const risk=
        atr[k]*0.50;

      const stopLoss=
        direction==="BUY"
          ? entry-risk
          : entry+risk;

      const takeProfit=
        direction==="BUY"
          ? entry+risk*1.20
          : entry-risk*1.20;

      candidates.push({
        index:k,
        direction,
        entry,
        stopLoss,
        takeProfit,
        risk,
        mtfScore:mtf.score,
        candle,
        retest,
        trendline:{
          start:breakout.trendline.start,
          end:breakout.trendline.end,
          slope:round(
            breakout.trendline.slope,
            8
          )
        }
      });
    }
  }

  candidates.sort(
    (a,b)=>b.index-a.index
  );

  const selected=
    candidates[0]||null;

  const currentPrice=
    last(candles5M)?.close||null;

  return {

    success:true,

    strategy:"P78",

    strategyName:
      "XAUUSD P78 — Exact Backtested Strategy",

    instrument:"XAUUSD",

    executionTimeframe:"5M",

    contextTimeframes:[
      "1H",
      "15M"
    ],

    generatedAt:
      new Date().toISOString(),

    currentPrice,

    status:
      selected
        ? "CONFIRMED"
        : "WAITING",

    executable:
      !!selected,

    signal:
      selected
        ? {
            direction:
              selected.direction,

            status:
              "P78 CONFIRMED",

            score:
              selected.mtfScore,

            maxScore:6,

            signalTime:
              candles5M[
                selected.index
              ].time,

            candleStrength:
              selected.candle.strength
          }
        : {
            direction:null,
            status:"WAITING",
            score:0,
            maxScore:6
          },

    tradeLevels:
      selected
        ? {
            entry:
              round(
                selected.entry,
                5
              ),

            stopLoss:
              round(
                selected.stopLoss,
                5
              ),

            takeProfit:
              round(
                selected.takeProfit,
                5
              ),

            risk:
              round(
                selected.risk,
                5
              )
          }
        : null,

    components:
      selected
        ? {
            candleStrength:
              selected.candle,

            mtfScore:
              selected.mtfScore,

            retestHeld:
              selected.retest,

            trendline:
              selected.trendline,

            future25Continuation:
              false
          }
        : null,

    backtest:{
      trades:354,
      wins:277,
      losses:77,
      winRate:78.25,
      netR:255.40
    },

    note:
      "P78 = CandleStrength != Weak + MTF_Score >= 5 + RetestHeld. Future 25-candle Continuation condition is NOT USED."
  };
}

function telegramText(x){

  const s=x.signal||{};
  const l=x.tradeLevels||{};

  return [
    "━━━━━━━━━━━━━━━━━━━━",
    "🚨 XAUUSD P78 SIGNAL",
    "━━━━━━━━━━━━━━━━━━━━",
    `Direction: ${s.direction||"WAIT"}`,
    `Status: ${s.status||"WAITING"}`,
    `MTF Score: ${s.score??0}/6`,
    `Price: ${x.currentPrice??"N/A"}`,
    "",
    "TRADE LEVELS",
    `Entry: ${l.entry??"N/A"}`,
    `SL: ${l.stopLoss??"N/A"}`,
    `TP: ${l.takeProfit??"N/A"}`,
    "",
    "P78 CONDITIONS",
    "• CandleStrength != Weak",
    "• MTF Score >= 5",
    "• RetestHeld = TRUE",
    "• Future 25-candle Continuation = NOT USED",
    "",
    "Backtest: 354 trades | 277W | 77L | 78.25% | +255.40R",
    "━━━━━━━━━━━━━━━━━━━━"
  ].join("\n");
}

async function sendTelegram(message){

  if(
    !telegramEnabled ||
    !TELEGRAM_BOT_TOKEN ||
    !TELEGRAM_CHAT_ID
  ){
    return {
      sent:false,
      reason:"Telegram disabled/not configured"
    };
  }

  try{

    const response=
      await fetch(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method:"POST",
          headers:{
            "Content-Type":
              "application/json"
          },
          body:JSON.stringify({
            chat_id:
              TELEGRAM_CHAT_ID,
            text:
              String(message)
          })
        }
      );

    const json=
      await response.json();

    if(
      !response.ok ||
      !json.ok
    ){
      throw new Error(
        json.description||
        "Telegram failed"
      );
    }

    return {
      sent:true
    };

  }catch(e){

    return {
      sent:false,
      error:e.message
    };
  }
}

async function scanAndAlert(){

  try{

    const result=
      await p78Scan();

    lastScan=result;
    lastError=null;

    if(result.executable){

      const levels=
        result.tradeLevels||{};

      const key=[
        result.signal.direction,
        levels.entry,
        levels.stopLoss,
        levels.takeProfit,
        result.signal.signalTime
      ].join("|");

      if(key!==lastSignalKey){

        lastTelegram={
          ...await sendTelegram(
            telegramText(result)
          ),

          attemptedAt:
            new Date().toISOString(),

          signalKey:key
        };

        if(lastTelegram.sent)
          lastSignalKey=key;
      }
    }

    return result;

  }catch(e){

    lastError=e.message;

    return {
      success:false,
      strategy:"P78",
      status:"ERROR",
      error:e.message
    };
  }
}

function auth(req,res,next){

  if(
    HF_SECRET &&
    String(
      req.headers["x-hf-secret"]||""
    )!==HF_SECRET
  ){
    return res.status(401).json({
      success:false,
      error:"Unauthorized"
    });
  }

  next();
}

app.get(
  "/p78/decision",
  auth,
  async(req,res)=>{

    const result=
      await scanAndAlert();

    res
      .status(
        result?.success===false
          ? 500
          : 200
      )
      .json({
        ...result,
        liquidAutoTrade:
          LIQUID_AUTO_TRADE,

        executionAllowed:
          LIQUID_AUTO_TRADE &&
          !!result.executable
      });
  }
);

app.get(
  "/signal",
  auth,
  async(req,res)=>{

    const result=
      await scanAndAlert();

    res
      .status(
        result?.success===false
          ? 500
          : 200
      )
      .json({
        ...result,
        liquidAutoTrade:
          LIQUID_AUTO_TRADE,

        executionAllowed:
          LIQUID_AUTO_TRADE &&
          !!result.executable
      });
  }
);

app.get(
  "/p78/status",
  (req,res)=>{

    res.json({

      success:true,

      strategy:"P78",

      status:"RUNNING",

      liquidAutoTrade:
        LIQUID_AUTO_TRADE,

      telegramEnabled,

      telegramConfigured:
        !!(
          TELEGRAM_BOT_TOKEN &&
          TELEGRAM_CHAT_ID
        ),

      lastScanAt:
        lastScan?.generatedAt||null,

      lastSignalKey,

      lastTelegram,

      lastError,

      backtest:{
        trades:354,
        wins:277,
        losses:77,
        winRate:78.25,
        netR:255.40
      }
    });
  }
);

app.get(
  "/status",
  (req,res)=>
    res.json({
      success:true,
      instrument:OUTPUT_SYMBOL,
      strategy:"P78",
      liquidAutoTrade:
        LIQUID_AUTO_TRADE,
      lastScan,
      lastError
    })
);

app.post(
  "/p78/telegram",
  (req,res)=>{

    telegramEnabled=
      !!req.body?.enabled;

    res.json({
      success:true,
      telegramEnabled
    });
  }
);

app.get(
  "/health",
  (req,res)=>
    res.json({
      success:true,
      instrument:OUTPUT_SYMBOL,
      strategy:"P78"
    })
);

setTimeout(
  scanAndAlert,
  20000
);

setInterval(
  scanAndAlert,
  60000
);

app.listen(
  PORT,
  "0.0.0.0",
  ()=>{
    console.log(
      `P78 XAUUSD server running on ${PORT}`
    );
  }
);

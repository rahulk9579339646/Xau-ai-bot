/* =========================================================
   XAUUSD THREE-STRATEGY RENDER SERVER
   SECTION 1: Strategy #5 — Support/Resistance Rejection
   SECTION 2: P78 — exact existing conditions retained
   SECTION 3: Order Flow — original wick/delta/absorption conditions retained
   SECTION 4: Order Block — independent 5M / 15M / 1H engine
   SECTION 5+: independent Telegram switches + separate lot compounding

   Required packages: express, ws
   Required Render env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
   Optional: TWELVE_DATA_API_KEY, HF_SECRET, EXECUTION_SECRET, LIQUID_AUTO_TRADE
   Lot defaults: Strategy #5 0.01, P78 0.01, Order Flow 0.05.
   Report closed outcomes to POST /risk/{strategy}/result:
     {"result":"WIN","pnl":12.5} or {"result":"LOSS","pnl":-5}
   This server does not directly place broker orders.
   ========================================================= */

import express from "express";
import WebSocket from "ws";
import fs from "node:fs";

const app = express();
app.use(express.json());
app.use((req,res,next)=>{
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type,X-HF-Secret,X-Execution-Secret");
  if(req.method === "OPTIONS") return res.status(204).end();
  next();
});

const PORT=process.env.PORT||10000;
const TWELVE_DATA_API_KEY=process.env.TWELVE_DATA_API_KEY||"";
const TELEGRAM_BOT_TOKEN=process.env.TELEGRAM_BOT_TOKEN||"";
const TELEGRAM_CHAT_ID=process.env.TELEGRAM_CHAT_ID||"";
const LIQUID_AUTO_TRADE=String(process.env.LIQUID_AUTO_TRADE||"false").toLowerCase()==="true";
const HF_SECRET=process.env.HF_SECRET||"";
const SYMBOL="XAU/USD";
const OUTPUT_SYMBOL="XAUUSD";
const TF={"1H":"1h","15M":"15min","5M":"5min"};
const CACHE=new Map();
const CACHE_MS=15000;
let lastScan=null,lastSignalKey=null,lastTelegram=null,lastError=null;
// P78 execution deduplication is server-side, so Liquid OFF/ON or script reloads
// cannot make the same confirmed candle signal executable again.
const P78_STATE_FILE=process.env.P78_STATE_FILE||""; // set to a Render persistent-disk path to survive service restarts
const p78ConsumedSignalKeys=new Set();
let p78StatePersisted=false;
function loadP78ConsumedKeys(){
  if(!P78_STATE_FILE)return;
  try{
    if(fs.existsSync(P78_STATE_FILE)){
      const saved=JSON.parse(fs.readFileSync(P78_STATE_FILE,"utf8"));
      if(Array.isArray(saved.consumedKeys)){
        for(const key of saved.consumedKeys.slice(-2000))p78ConsumedSignalKeys.add(String(key));
      }
    }
    p78StatePersisted=true;
  }catch(e){console.error("P78 state load error:",e.message);}
}
function saveP78ConsumedKeys(){
  if(!P78_STATE_FILE)return false;
  try{
    fs.writeFileSync(P78_STATE_FILE,JSON.stringify({consumedKeys:Array.from(p78ConsumedSignalKeys).slice(-2000)}),"utf8");
    p78StatePersisted=true;return true;
  }catch(e){p78StatePersisted=false;console.error("P78 state save error:",e.message);return false;}
}
loadP78ConsumedKeys();
const telegramEnabledByStrategy = { strategy5: true, p78: true, orderflow: true, orderblock: true };

function num(v,d=null){const n=Number(v);return Number.isFinite(n)?n:d;}
function round(v,d=5){return Number.isFinite(v)?Math.round(v*10**d)/10**d:null;}
function last(a){return a?.length?a[a.length-1]:null;}

function emaSeries(values,period){
  const out=Array(values.length).fill(null);
  if(values.length<period)return out;
  let s=0;for(let i=0;i<period;i++)s+=values[i];
  let e=s/period;out[period-1]=e;const k=2/(period+1);
  for(let i=period;i<values.length;i++){e=values[i]*k+e*(1-k);out[i]=e;}
  return out;
}
function rsiSeries(values,period=14){
  const out=Array(values.length).fill(null);
  if(values.length<=period)return out;
  let gain=0,loss=0;
  for(let i=1;i<=period;i++){const d=values[i]-values[i-1];if(d>=0)gain+=d;else loss-=d;}
  gain/=period;loss/=period;out[period]=loss===0?100:100-100/(1+gain/loss);
  for(let i=period+1;i<values.length;i++){const d=values[i]-values[i-1],g=Math.max(d,0),l=Math.max(-d,0);gain=(gain*(period-1)+g)/period;loss=(loss*(period-1)+l)/period;out[i]=loss===0?100:100-100/(1+gain/loss);}
  return out;
}
function atrSeries(candles,period=14){
  const out=Array(candles.length).fill(null);if(candles.length<period+1)return out;
  const tr=Array(candles.length);for(let i=0;i<candles.length;i++)tr[i]=i===0?candles[i].high-candles[i].low:Math.max(candles[i].high-candles[i].low,Math.abs(candles[i].high-candles[i-1].close),Math.abs(candles[i].low-candles[i-1].close));
  let a=0;for(let i=1;i<=period;i++)a+=tr[i];a/=period;out[period]=a;
  for(let i=period+1;i<candles.length;i++){a=(a*(period-1)+tr[i])/period;out[i]=a;}
  return out;
}
function normalize(values){return values.map(x=>({time:x.datetime,open:num(x.open),high:num(x.high),low:num(x.low),close:num(x.close),volume:num(x.volume)})).filter(x=>x.time&&[x.open,x.high,x.low,x.close].every(Number.isFinite)).sort((a,b)=>new Date(a.time)-new Date(b.time));}

async function getCandles(interval,outputsize=5000){
  const key=`${interval}-${outputsize}`;const cached=CACHE.get(key);if(cached&&Date.now()-cached.t<CACHE_MS)return cached.d;
  let err=null;
  if(TWELVE_DATA_API_KEY){
    try{
      const u=`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(SYMBOL)}&interval=${encodeURIComponent(interval)}&outputsize=${Math.min(outputsize,5000)}&apikey=${encodeURIComponent(TWELVE_DATA_API_KEY)}&format=JSON`;
      const r=await fetch(u);const j=await r.json();
      if(!r.ok||j.status==="error"||!j.values)throw new Error(j.message||"Twelve Data error");
      const d=normalize(j.values);CACHE.set(key,{t:Date.now(),d});return d;
    }catch(e){err=e;}
  }
  try{
    const biInterval=interval==="1h"?"1h":interval==="15min"?"15m":"5m";
    const u=`https://biquote.io/api/XAUUSD/ohlc?interval=${biInterval}&limit=${Math.min(Math.max(outputsize,100),5000)}`;
    const r=await fetch(u);const j=await r.json();
    if(!r.ok||!Array.isArray(j.bars))throw new Error(j.message||"Biquote error");
    const d=j.bars.filter(x=>!x.isOpen).map(x=>({time:x.openTime,open:num(x.open),high:num(x.high),low:num(x.low),close:num(x.close),volume:num(x.volume)||num(x.tickVolume)})).filter(x=>x.time&&[x.open,x.high,x.low,x.close].every(Number.isFinite)).sort((a,b)=>new Date(a.time)-new Date(b.time));
    if(d.length<100)throw new Error("Insufficient candles");CACHE.set(key,{t:Date.now(),d});return d;
  }catch(e){throw new Error(`Data error: ${err?.message||"Twelve Data unavailable"}; ${e.message}`);}
}

function addIndicators(candles){
  const close=candles.map(x=>x.close),e20=emaSeries(close,20),e50=emaSeries(close,50),r=rsiSeries(close,14),a=atrSeries(candles,14);
  return candles.map((x,i)=>({...x,EMA20:e20[i],EMA50:e50[i],RSI14:r[i],ATR14:a[i]}));
}

/* EXACT BACKTEST TRENDLINE SCAN */
function rawTrendlineSignals(candles){
  const df=addIndicators(candles),h=df.map(x=>x.high),l=df.map(x=>x.low),c=df.map(x=>x.close),atr=df.map(x=>x.ATR14),n=df.length;
  const ph_i=[],ph_v=[],pl_i=[],pl_v=[];
  for(let i=2;i<n-2;i++){
    if(h[i]>Math.max(h[i-2],h[i-1])&&h[i]>Math.max(h[i+1],h[i+2])){ph_i.push(i);ph_v.push(h[i]);}
    if(l[i]<Math.min(l[i-2],l[i-1])&&l[i]<Math.min(l[i+1],l[i+2])){pl_i.push(i);pl_v.push(l[i]);}
  }
  const signals=[];
  // BUY: exact backtest condition = descending swing-high line broken upward.
  for(let j=1;j<ph_i.length;j++){
    const i1=ph_i[j-1],i2=ph_i[j],v1=ph_v[j-1],v2=ph_v[j];
    if(v2>=v1)continue;
    const slope=(v2-v1)/(i2-i1);
    for(let k=Math.max(40,i2+1);k<n;k++){
      if(!Number.isFinite(atr[k])||atr[k]<=0)continue;
      const ln=v1+slope*(k-i1),lp=v1+slope*(k-1-i1),tol=atr[k]*0.08;
      if(c[k]>ln+tol*0.15&&c[k-1]<=lp+tol*0.15){signals.push({idx:k,Time:df[k].time,Direction:"BUY",Price:c[k],ATR14:atr[k]});break;}
    }
  }
  // SELL: exact backtest condition = ascending swing-low line broken downward.
  for(let j=1;j<pl_i.length;j++){
    const i1=pl_i[j-1],i2=pl_i[j],v1=pl_v[j-1],v2=pl_v[j];
    if(v2<=v1)continue;
    const slope=(v2-v1)/(i2-i1);
    for(let k=Math.max(40,i2+1);k<n;k++){
      if(!Number.isFinite(atr[k])||atr[k]<=0)continue;
      const ln=v1+slope*(k-i1),lp=v1+slope*(k-1-i1),tol=atr[k]*0.08;
      if(c[k]<ln-tol*0.15&&c[k-1]>=lp-tol*0.15){signals.push({idx:k,Time:df[k].time,Direction:"SELL",Price:c[k],ATR14:atr[k]});break;}
    }
  }
  signals.sort((a,b)=>a.idx-b.idx);
  const seen=new Set();return signals.filter(s=>{const key=`${s.Time}|${s.Direction}`;if(seen.has(key))return false;seen.add(key);return true;});
}

function nearestAtOrBefore(candles,time){
  let lo=0,hi=candles.length-1,best=-1,t=new Date(time).getTime();
  while(lo<=hi){const m=(lo+hi)>>1,mt=new Date(candles[m].time).getTime();if(mt<=t){best=m;lo=m+1;}else hi=m-1;}
  return best;
}
function mtfScore(c1,c15,time,direction){
  const i1=nearestAtOrBefore(c1,time),i15=nearestAtOrBefore(c15,time);if(i1<0||i15<0)return{score:0};
  const a1=c1[i1],a15=c15[i15];if(!Number.isFinite(a1.EMA20)||!Number.isFinite(a1.EMA50)||!Number.isFinite(a1.RSI14)||!Number.isFinite(a15.EMA20)||!Number.isFinite(a15.EMA50)||!Number.isFinite(a15.RSI14))return{score:0};
  let score=0;
  let h1Ema=false,h1Rsi=false,m15Ema=false,m15Rsi=false;
  if(direction==="BUY"){
    h1Ema=a1.EMA20>a1.EMA50;if(h1Ema)score+=2;
    h1Rsi=a1.RSI14>50;if(h1Rsi)score+=1;
    m15Ema=a15.EMA20>a15.EMA50;if(m15Ema)score+=2;
    m15Rsi=a15.RSI14>50;if(m15Rsi)score+=1;
  }
  else{
    h1Ema=a1.EMA20<a1.EMA50;if(h1Ema)score+=2;
    h1Rsi=a1.RSI14<50;if(h1Rsi)score+=1;
    m15Ema=a15.EMA20<a15.EMA50;if(m15Ema)score+=2;
    m15Rsi=a15.RSI14<50;if(m15Rsi)score+=1;
  }
  return{score,a1,a15,mtfBreakdown:{direction,h1Ema,h1Rsi,m15Ema,m15Rsi}};
}
function candleStrength(c,k,direction,atr){
  const o=c[k].open,h=c[k].high,l=c[k].low,cl=c[k].close,rng=h-l,body=Math.abs(cl-o);
  const bodyRatio=rng>0?body/rng:0;
  const bullClose=rng>0?(cl-l)/rng:0,bearClose=rng>0?(h-cl)/rng:0;
  const bullStrong=bodyRatio>=0.55&&bullClose>=0.65,bearStrong=bodyRatio>=0.55&&bearClose>=0.65;
  const displacement=atr[k]>0&&rng>=atr[k]*1.10&&bodyRatio>=0.60;
  const strong=direction==="BUY"?bullStrong:bearStrong;
  return{strength:displacement?"Strong":(strong?"Valid":"Weak"),bodyRatio,closeLocation:direction==="BUY"?bullClose:bearClose,displacement};
}
function retestHeld(c,k,direction,breakout,atr){
  const end=Math.min(k+25,c.length);if(end<=k+1||!Number.isFinite(atr[k]))return{touched:false,held:false,index:null,price:null};
  const tolerance=atr[k]*0.08;
  for(let j=k+1;j<end;j++){
    const touched=direction==="BUY"?c[j].low<=breakout+tolerance:c[j].high>=breakout-tolerance;
    if(touched)return{touched:true,held:direction==="BUY"?c[j].close>breakout:c[j].close<breakout,index:j,price:c[j].close};
  }
  return{touched:false,held:false,index:null,price:null};
}

/* P78 = ONLY these 3 conditions. Future 25-candle continuation is NOT used.
   Execution is allowed only on the candle where the first retest is confirmed.
   Old historical candidates are never returned as fresh executable signals. */
async function p78Scan(){
  const [raw1,raw15,raw5]=await Promise.all([getCandles(TF["1H"],5000),getCandles(TF["15M"],5000),getCandles(TF["5M"],5000)]);
  const c1=addIndicators(raw1),c15=addIndicators(raw15),c5=addIndicators(raw5),atr=c5.map(x=>x.ATR14);
  const raw=rawTrendlineSignals(c5);
  const latestIndex=c5.length-1;
  const current=last(c5)?.close??null;
  const candidates=[];
  for(const s of raw){
    const k=s.idx;
    // Breakout must precede the latest candle; retest confirmation must happen now.
    if(k>=latestIndex)continue;
    const cs=candleStrength(c5,k,s.Direction,atr);if(cs.strength==="Weak")continue;
    const mtf=mtfScore(c1,c15,s.Time,s.Direction);if(mtf.score<5)continue;
    const rt=retestHeld(c5,k,s.Direction,s.Price,atr);
    if(!rt.held||rt.index!==latestIndex)continue;
    const entry=rt.price;
    const risk=atr[k]*0.50;
    if(!Number.isFinite(entry)||!Number.isFinite(risk)||risk<=0)continue;
    const sl=s.Direction==="BUY"?entry-risk:entry+risk;
    const tp=s.Direction==="BUY"?entry+risk*2:entry-risk*2;
    candidates.push({signal:s,k,entry,sl,tp,risk,score:mtf.score,mtfBreakdown:mtf.mtfBreakdown,strength:cs,retest:rt,trendlineSource:"EXACT P78 BACKTEST ENGINE"});
  }
  candidates.sort((a,b)=>b.k-a.k);
  const x=candidates[0]||null;
  const confirmationTime=x?c5[x.retest.index].time:null;
  const signalKey=x?[OUTPUT_SYMBOL,"P78",x.signal.Direction,confirmationTime].join("|"):null;
  const consumed=!!signalKey&&p78ConsumedSignalKeys.has(signalKey);
  return{
    success:true,strategy:"P78",strategyName:"XAUUSD P78 — Exact Backtested Strategy",instrument:OUTPUT_SYMBOL,
    executionTimeframe:"5M",contextTimeframes:["1H","15M"],generatedAt:new Date().toISOString(),currentPrice:current,
    status:x?(consumed?"ALREADY CONSUMED":"CONFIRMED"):"WAITING",
    executable:!!x&&!consumed,signalKey,signalConsumed:consumed,
    signal:x?{direction:x.signal.Direction,status:consumed?"P78 SIGNAL ALREADY USED":"P78 CONFIRMED",score:x.score,maxScore:6,
      signalIndex:x.retest.index,signalTime:confirmationTime,breakoutTime:x.signal.Time,candleStrength:x.strength.strength}:
      {direction:null,status:"WAITING",score:0,maxScore:6,signalTime:null},
    mtfBreakdown:x?.mtfBreakdown||null,
    tradeLevels:x?{entry:round(x.entry),stopLoss:round(x.sl),takeProfit:round(x.tp),risk:round(x.risk),rr:"1:2"}:null,
    components:x?{candleStrength:x.strength,mtfScore:x.score,mtfBreakdown:x.mtfBreakdown,
      retestHeld:{...x.retest,time:confirmationTime},trendline:x.signal,continuation:"NOT USED"}:null,
    backtest:{trades:354,wins:277,losses:77,winRate:78.25,netR:255.40},
    note:"P78 = CandleStrength != Weak + MTF_Score >= 5 + RetestHeld. Future 25-candle Continuation condition is NOT USED. Only the latest retest-confirmation candle is executable; RR 1:2."
  };
}

function telegramText(x){const s=x.signal||{},l=x.tradeLevels||{};return ["━━━━━━━━━━━━━━━━━━━━","🚨 XAUUSD P78 SIGNAL","━━━━━━━━━━━━━━━━━━━━",`Direction: ${s.direction||"WAIT"}`,`Status: ${s.status||"WAITING"}`,`MTF Score: ${s.score??0}/6`,`Current: ${x.currentPrice??"N/A"}`,"","TRADE LEVELS",`Entry: ${l.entry??"N/A"}`,`SL: ${l.stopLoss??"N/A"}`,`TP: ${l.takeProfit??"N/A"}`,"","Risk/Reward: 1:2","","Conditions","• CandleStrength != Weak","• MTF Score >= 5","• RetestHeld = TRUE","• Future 25-candle Continuation = NOT USED","","Backtest: 354 trades | 277W | 77L | 78.25% | +255.40R","━━━━━━━━━━━━━━━━━━━━"].join("\n");}
async function sendTelegram(strategy,message){if(!telegramEnabledByStrategy[strategy]||!TELEGRAM_BOT_TOKEN||!TELEGRAM_CHAT_ID)return{sent:false,reason:"Telegram disabled/not configured for "+strategy};try{const r=await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:TELEGRAM_CHAT_ID,text:String(message)})});const j=await r.json();if(!r.ok||!j.ok)throw new Error(j.description||"Telegram failed");return{sent:true};}catch(e){return{sent:false,error:e.message};}}
async function scanAndAlert(){
  try{
    const x=await p78Scan();lastScan=x;lastError=null;
    if(x.executable&&x.signalKey&&x.signalKey!==lastSignalKey){
      // Claim the alert key before awaiting Telegram to prevent overlapping scans.
      lastSignalKey=x.signalKey;
      lastTelegram={...(await sendTelegram("p78",telegramText(x))),attemptedAt:new Date().toISOString(),signalKey:x.signalKey};
    }
    return x;
  }catch(e){lastError=e.message;return{success:false,strategy:"P78",status:"ERROR",error:e.message};}
}
function auth(req,res,next){if(HF_SECRET&&String(req.headers["x-hf-secret"]||"")!==HF_SECRET)return res.status(401).json({success:false,error:"Unauthorized"});next();}



/* =========================================================
   STRATEGY #5 — SUPPORT / RESISTANCE REJECTION
   Independent of P78. Original rules preserved:
   swing L/R = 3, ATR SMA = 14, tolerance = 0.25 ATR,
   minimum SL distance = 1 ATR, target = 2R.
   ========================================================= */
function strategy5AtrSma(candles, period=14) {
  const tr = candles.map((c, i) => i === 0
    ? c.high - c.low
    : Math.max(c.high - c.low,
        Math.abs(c.high - candles[i-1].close),
        Math.abs(c.low - candles[i-1].close)));
  return candles.map((_, i) => {
    if (i < period - 1) return null;
    const slice = tr.slice(i - period + 1, i + 1);
    return slice.reduce((a, b) => a + b, 0) / period;
  });
}

function strategy5ScanCandles(candles) {
  const n = candles.length;
  const atr = strategy5AtrSma(candles, 14);
  let support = null, resistance = null;
  let supportTested = false, resistanceTested = false;
  let latestSignal = null;
  const left = 3, right = 3, toleranceAtr = 0.25;

  for (let k = 0; k < n; k++) {
    // A swing becomes confirmed only after 3 candles to its right.
    const pivot = k - right;
    if (pivot >= left && pivot + right < n) {
      const ph = candles[pivot].high;
      const pl = candles[pivot].low;
      let isHigh = true, isLow = true;
      for (let j = pivot-left; j < pivot; j++) {
        if (!(ph > candles[j].high)) isHigh = false;
        if (!(pl < candles[j].low)) isLow = false;
      }
      for (let j = pivot+1; j <= pivot+right; j++) {
        if (!(ph >= candles[j].high)) isHigh = false;
        if (!(pl <= candles[j].low)) isLow = false;
      }
      if (isHigh) { resistance = ph; resistanceTested = false; }
      if (isLow) { support = pl; supportTested = false; }
    }

    if (k < 14 || !Number.isFinite(atr[k]) || atr[k] <= 0) continue;
    const c = candles[k], tol = atr[k] * toleranceAtr;

    if (support !== null && !supportTested &&
        c.low <= support + tol && c.close > support && c.close > c.open) {
      let entry = c.close, sl = c.low;
      if (entry - sl < atr[k]) sl = entry - atr[k];
      const risk = entry - sl;
      latestSignal = {
        index:k, time:c.time, direction:"BUY", entry, stopLoss:sl,
        takeProfit:entry + risk * 2, support, resistance,
        rejection:"SUPPORT BULLISH REJECTION", atr:atr[k], risk
      };
      supportTested = true;
    } else if (resistance !== null && !resistanceTested &&
        c.high >= resistance - tol && c.close < resistance && c.close < c.open) {
      let entry = c.close, sl = c.high;
      if (sl - entry < atr[k]) sl = entry + atr[k];
      const risk = sl - entry;
      latestSignal = {
        index:k, time:c.time, direction:"SELL", entry, stopLoss:sl,
        takeProfit:entry - risk * 2, support, resistance,
        rejection:"RESISTANCE BEARISH REJECTION", atr:atr[k], risk
      };
      resistanceTested = true;
    }
  }

  const lastIndex = n - 1;
  const currentAtr = lastIndex >= 0 ? atr[lastIndex] : null;
  // Only a rejection on the newest available candle is actionable.
  const active = latestSignal && latestSignal.index === lastIndex ? latestSignal : null;
  return {
    success:true,
    strategy:"STRATEGY_5",
    strategyName:"XAUUSD Strategy #5 — Support / Resistance Rejection",
    instrument:OUTPUT_SYMBOL,
    executionTimeframe:"5M",
    generatedAt:new Date().toISOString(),
    currentPrice:last(candles)?.close ?? null,
    status:active ? "CONFIRMED" : "WAITING",
    executable:!!active,
    signal:active ? {
      direction:active.direction,
      status:active.rejection,
      signalTime:active.time
    } : { direction:null, status:"WAITING", signalTime:null },
    tradeLevels:active ? {
      entry:round(active.entry),
      stopLoss:round(active.stopLoss),
      takeProfit:round(active.takeProfit),
      risk:round(active.risk), rr:"1:2"
    } : null,
    components:{
      support:support === null ? null : round(support),
      resistance:resistance === null ? null : round(resistance),
      rejection:active ? active.rejection : "NONE",
      direction:active ? active.direction : "-",
      atr:round(currentAtr),
      swingLeft:left,
      swingRight:right,
      toleranceATR:toleranceAtr,
      tested:{support:supportTested,resistance:resistanceTested}
    },
    note:"Strategy #5 only: 3/3 swing levels, rejection candle, ATR(14) SMA, 0.25 ATR tolerance, minimum 1 ATR SL, TP 2R. No P78 conditions."
  };
}

async function strategy5Scan() {
  const candles = await getCandles(TF["5M"], 5000);
  if (!candles || candles.length < 30) throw new Error("Strategy #5: insufficient XAUUSD 5M candles");
  return strategy5ScanCandles(candles);
}

/* =========================================================
   ORDER BLOCK STRATEGY — independent of Strategy #5, P78 and Order Flow.
   Bullish/bearish displacement body >= 1 ATR and close beyond prior 10-bar
   structure; displacement candle defines the OB zone; first return touch only.
   ========================================================= */
const OB_TIMEFRAMES = { "5M":"5min", "15M":"15min", "1H":"1h" };
const OB_LOOKBACK = 100;
const OB_MAX_ZONES = 10;
const OB_ATR_MULTIPLE = 1.0;
const OB_CONTRACT_SIZE = Math.max(1, Number(process.env.ORDERBLOCK_CONTRACT_SIZE || 100));
const OB_LOT_STEP = Math.max(0.001, Number(process.env.ORDERBLOCK_LOT_STEP || process.env.LOT_STEP || 0.01));
const OB_MIN_LOT = Math.max(OB_LOT_STEP, Number(process.env.ORDERBLOCK_MIN_LOT || 0.01));
const OB_MAX_LOT = Math.max(OB_MIN_LOT, Number(process.env.ORDERBLOCK_MAX_LOT || process.env.LOT_MAX || 10));
const OB_SL_BUFFER = Math.max(0, Number(process.env.ORDERBLOCK_SL_BUFFER || 0.10));
const orderBlockState = Object.fromEntries(Object.keys(OB_TIMEFRAMES).map(tf => [tf, {
  zones: [], usedZoneIds: new Set(), activeTrade: null, lastSignalKey: null,
  lastScanAt: null, lastError: null, lastAlert: null
}]));
function obRoundLot(lot) {
  const steps = Math.floor((lot + 1e-10) / OB_LOT_STEP);
  return Number((steps * OB_LOT_STEP).toFixed(6));
}
function obRiskSizing(equity, entry, stopLoss) {
  if (!Number.isFinite(equity) || equity <= 0) return { valid:false, reason:"A positive live equity query/body value is required.", lots:0 };
  const riskPerLot = Math.abs(entry - stopLoss) * OB_CONTRACT_SIZE;
  if (!(riskPerLot > 0)) return { valid:false, reason:"Invalid stop-loss distance.", lots:0 };
  const riskCap = equity * 0.01;
  const rawLots = riskCap / riskPerLot;
  const lots = Math.min(OB_MAX_LOT, obRoundLot(rawLots));
  if (lots < OB_MIN_LOT || lots * riskPerLot > riskCap + 1e-8) {
    return { valid:false, reason:"Minimum lot would risk more than 1% of equity; trade skipped.", lots:0, riskCap:round(riskCap,2), riskPerLot:round(riskPerLot,4) };
  }
  return { valid:true, lots, riskCap:round(riskCap,2), estimatedRisk:round(lots*riskPerLot,2), riskPercent:round((lots*riskPerLot/equity)*100,4), riskPerLot:round(riskPerLot,4) };
}
function obBuildZones(candles, timeframe) {
  const c = candles.slice(-OB_LOOKBACK), n = c.length;
  if (n < 25) return [];
  const atr = atrSeries(c, 14), zones = [];
  // Only use already-closed candles before the latest candle as displacement candidates.
  for (let i = 10; i < n - 1; i++) {
    if (!Number.isFinite(atr[i]) || atr[i] <= 0) continue;
    const candle = c[i], body = Math.abs(candle.close - candle.open);
    if (body < atr[i] * OB_ATR_MULTIPLE) continue;
    const prior = c.slice(Math.max(0, i - 10), i);
    const priorHigh = Math.max(...prior.map(x => x.high));
    const priorLow = Math.min(...prior.map(x => x.low));
    const bullish = candle.close > candle.open && candle.close > priorHigh;
    const bearish = candle.close < candle.open && candle.close < priorLow;
    if (!bullish && !bearish) continue;
    // User rule: no preceding opposite-colour candle is required.
    // The confirmed displacement candle itself defines the OB touch zone.
    const ob = candle;
    const zone = {
      id: `OB|${timeframe}|${bullish ? "BUY" : "SELL"}|${ob.time}`,
      timeframe, direction:bullish ? "BUY" : "SELL", createdAt:ob.time,
      displacementTime:candle.time, displacementClose:candle.close,
      zoneHigh:ob.high, zoneLow:ob.low, atr:atr[i], body, touched:false
    };
    zones.push(zone);
  }
  const unique = new Map();
  for (const z of zones) unique.set(z.id, z);
  return Array.from(unique.values()).slice(-OB_MAX_ZONES).reverse();
}
async function orderBlockScan(timeframe, equity) {
  const tf = String(timeframe || "5M").toUpperCase();
  if (!OB_TIMEFRAMES[tf]) throw new Error("timeframe must be 5M, 15M, or 1H.");
  const state = orderBlockState[tf];
  const candles = await getCandles(OB_TIMEFRAMES[tf], 500);
  if (!candles || candles.length < 30) throw new Error(`Order Block: insufficient ${tf} candles.`);
  const zones = obBuildZones(candles, tf);
  state.zones = zones;
  state.lastScanAt = new Date().toISOString();
  state.lastError = null;
  const current = last(candles);
  const active = state.activeTrade;
  if (active) return {
    success:true, strategy:"ORDER_BLOCK", timeframe:tf, status:"ACTIVE_TRADE",
    executable:false, reason:"This timeframe already has its own active Order Block trade.",
    currentPrice:current.close, activeTrade:active, zones:zones.map(z=>({...z,used:state.usedZoneIds.has(z.id)})), generatedAt:new Date().toISOString()
  };
  // The entry is the first candle after the OB/displacement sequence that overlaps the zone.
  for (const z of zones) {
    if (state.usedZoneIds.has(z.id)) continue;
    const displacementIndex = candles.findIndex(x => x.time === z.displacementTime);
    if (displacementIndex < 0 || displacementIndex >= candles.length - 1) continue;
    // Enforce FIRST touch: if any completed candle after displacement already
    // overlapped this zone, do not enter on a later retest.
    let firstTouchIndex = -1;
    for (let j = displacementIndex + 1; j < candles.length; j++) {
      if (candles[j].low <= z.zoneHigh && candles[j].high >= z.zoneLow) { firstTouchIndex = j; break; }
    }
    if (firstTouchIndex !== candles.length - 1) continue;
    const entry = current.close;
    const stopLoss = z.direction === "BUY" ? z.zoneLow - OB_SL_BUFFER : z.zoneHigh + OB_SL_BUFFER;
    if ((z.direction === "BUY" && stopLoss >= entry) || (z.direction === "SELL" && stopLoss <= entry)) continue;
    const risk = Math.abs(entry - stopLoss);
    const sizing = obRiskSizing(Number(equity), entry, stopLoss);
    const candidate = {
      success:true, strategy:"ORDER_BLOCK", strategyName:"XAUUSD Order Block First-Touch Retest",
      instrument:OUTPUT_SYMBOL, timeframe:tf, generatedAt:new Date().toISOString(),
      status:sizing.valid ? "FIRST_TOUCH_CONFIRMED" : "SKIPPED_RISK_CAP",
      executable:sizing.valid, signalKey:z.id, zone:z,
      signal:{direction:z.direction, signalTime:current.time, displacementTime:z.displacementTime,
        status:"First touch of displacement-candle Order Block zone"},
      tradeLevels:{entry:round(entry),stopLoss:round(stopLoss),takeProfit:null,risk:round(risk),rr:"trailing by equity milestones"},
      sizing, currentPrice:current.close,
      trailingRule:"At +1% equity profit SL moves to entry; each additional +1% milestone locks the previous +1% milestone. Continues above +3%; no fixed +3% close.",
      note:"Server emits levels and trailing instructions only; broker SL changes require the Liquid Chart execution bridge."
    };
    if (!sizing.valid) return candidate;
    state.usedZoneIds.add(z.id);
    state.lastSignalKey = z.id;
    state.activeTrade = {
      tradeId:z.id, timeframe:tf, direction:z.direction, entry:round(entry), originalStopLoss:round(stopLoss),
      stopLoss:round(stopLoss), lots:sizing.lots, equityAtEntry:Number(equity), zoneId:z.id,
      openedAt:new Date().toISOString(), highestMilestone:0, status:"ACTIVE"
    };
    candidate.activeTrade = state.activeTrade;
    return candidate;
  }
  return {
    success:true, strategy:"ORDER_BLOCK", timeframe:tf, status:"WAITING", executable:false,
    currentPrice:current.close, activeTrade:null,
    zones:zones.map(z=>({...z,used:state.usedZoneIds.has(z.id)})),
    note:"Waiting for the first return touch of the displacement-candle OB zone. Provide live equity as ?equity=...", generatedAt:new Date().toISOString()
  };
}
function obManagePosition(timeframe, currentPrice, equity) {
  const tf=String(timeframe||"").toUpperCase();
  if(!OB_TIMEFRAMES[tf]) throw new Error("timeframe must be 5M, 15M, or 1H.");
  const state=orderBlockState[tf], trade=state.activeTrade;
  if(!trade) throw new Error(`No active Order Block trade for ${tf}.`);
  const price=Number(currentPrice), liveEquity=Number(equity);
  if(!Number.isFinite(price)||price<=0||!Number.isFinite(liveEquity)||liveEquity<=0) throw new Error("currentPrice and positive live equity are required.");
  const priceMove=(trade.direction==="BUY"?price-trade.entry:trade.entry-price);
  const profit=priceMove*trade.lots*OB_CONTRACT_SIZE;
  const profitPct=profit/Number(trade.equityAtEntry||liveEquity)*100;
  const reached=Math.max(0,Math.floor(profitPct+1e-9));
  if(reached>=1 && reached>trade.highestMilestone){
    trade.highestMilestone=reached;
    const lockedPct=Math.max(0,reached-1);
    const lockedPriceDistance=(liveEquity*(lockedPct/100))/(trade.lots*OB_CONTRACT_SIZE);
    const proposed=trade.direction==="BUY"?trade.entry+lockedPriceDistance:trade.entry-lockedPriceDistance;
    // Never loosen an existing stop.
    trade.stopLoss=trade.direction==="BUY"?Math.max(Number(trade.stopLoss),proposed):Math.min(Number(trade.stopLoss),proposed);
    trade.lastTrailAt=new Date().toISOString();
  }
  return {success:true,strategy:"ORDER_BLOCK",timeframe:tf,tradeId:trade.tradeId,direction:trade.direction,
    entry:trade.entry,currentPrice:price,lots:trade.lots,liveEquity:round(liveEquity,2),unrealizedProfit:round(profit,2),
    profitPercentOfEquity:round(profitPct,4),highestMilestone:trade.highestMilestone,stopLoss:round(Number(trade.stopLoss)),
    brokerStopLossUpdated:false,actionRequired:"Execution bridge must apply returned stopLoss to broker position."};
}
async function scanOrderBlockAndAlert() {
  for (const tf of Object.keys(OB_TIMEFRAMES)) {
    try {
      const state=orderBlockState[tf];
      // Periodic scan finds zones; a trade is not opened without a supplied live equity.
      const candles=await getCandles(OB_TIMEFRAMES[tf],500);
      state.zones=obBuildZones(candles,tf); state.lastScanAt=new Date().toISOString(); state.lastError=null;
    } catch(e) { orderBlockState[tf].lastError=e.message; }
  }
}


/* =========================================================
   SECTION 0 — INDEPENDENT LOT COMPOUNDING
   Actual closed-trade outcomes must be reported by the execution bridge.
   Win: multiply current lot by LOT_WIN_MULTIPLIER.
   Loss: multiply current lot by LOT_LOSS_MULTIPLIER.
   ========================================================= */
const LOT_STEP = Math.max(0.001, Number(process.env.LOT_STEP || 0.01));
const LOT_WIN_MULTIPLIER = Math.max(1, Number(process.env.LOT_WIN_MULTIPLIER || 1.20));
const LOT_LOSS_MULTIPLIER = Math.min(1, Math.max(0.01, Number(process.env.LOT_LOSS_MULTIPLIER || 0.80)));
const LOT_MIN = Math.max(LOT_STEP, Number(process.env.LOT_MIN || 0.01));
const LOT_MAX = Math.max(LOT_MIN, Number(process.env.LOT_MAX || 10));

const lotBook = {
  strategy5: { base: Math.max(LOT_MIN, Number(process.env.STRATEGY5_BASE_LOT || 0.01)), current: null, wins: 0, losses: 0, lastResult: null, updatedAt: null },
  p78:      { base: Math.max(LOT_MIN, Number(process.env.P78_BASE_LOT || 0.01)), current: null, wins: 0, losses: 0, lastResult: null, updatedAt: null },
  orderflow: { base: Math.max(LOT_MIN, Number(process.env.ORDERFLOW_BASE_LOT || 0.05)), current: null, wins: 0, losses: 0, lastResult: null, updatedAt: null },
  orderblock: { base: Math.max(LOT_MIN, Number(process.env.ORDERBLOCK_BASE_LOT || 0.01)), current: null, wins: 0, losses: 0, lastResult: null, updatedAt: null }
};
for (const book of Object.values(lotBook)) book.current = book.base;

function roundLot(value) {
  const steps = Math.round(value / LOT_STEP);
  return Math.min(LOT_MAX, Math.max(LOT_MIN, Number((steps * LOT_STEP).toFixed(6))));
}
function getDynamicLot(strategy) {
  return roundLot(lotBook[strategy]?.current ?? LOT_MIN);
}
function applyTradeResult(strategy, result, pnl = null) {
  const book = lotBook[strategy];
  if (!book) throw new Error("Unknown strategy. Use strategy5, p78, orderflow, or orderblock.");
  const normalized = String(result || "").trim().toUpperCase();
  if (!["WIN", "LOSS"].includes(normalized)) throw new Error("result must be WIN or LOSS.");
  if (normalized === "WIN") {
    book.wins += 1;
    book.current = roundLot(book.current * LOT_WIN_MULTIPLIER);
  } else {
    book.losses += 1;
    book.current = roundLot(book.current * LOT_LOSS_MULTIPLIER);
  }
  book.lastResult = { result: normalized, pnl: Number.isFinite(Number(pnl)) ? Number(pnl) : null };
  book.updatedAt = new Date().toISOString();
  return { strategy, ...book, nextLot: getDynamicLot(strategy) };
}
function lotBookOutput() {
  return Object.fromEntries(Object.entries(lotBook).map(([key, value]) => [key, {
    baseLot: value.base, currentLot: getDynamicLot(key), wins: value.wins, losses: value.losses,
    lastResult: value.lastResult, updatedAt: value.updatedAt
  }]));
}
function resultAuth(req) {
  const supplied = String(req.headers["x-hf-secret"] || req.headers["x-execution-secret"] || "");
  const expected = HF_SECRET || process.env.EXECUTION_SECRET || "";
  return !expected || supplied === expected;
}

/* =========================================================
   SECTION 3 — ORDER FLOW STRATEGY (isolated state)
   Original delta / wick / absorption signal rules preserved.
   ========================================================= */
const orderFlow = (() => {
const SYMBOL = "XAUUSDT";
const BINANCE_WS_URL = "wss://fstream.binance.com/market/ws/xauusdt@aggTrade";

// Execution hand-off configuration.
// The server never places a broker order by itself. It exposes a deterministic
// signal endpoint for Liquid Chart / an execution bridge to consume.
const DRY_RUN = String(process.env.DRY_RUN ?? "true").toLowerCase() === "true";
const EXECUTION_SECRET = process.env.EXECUTION_SECRET || "";
const LOTS = Number(process.env.LOTS || 0.05); // fallback only; live output uses independent compounding.
const SL_BUFFER = Number(process.env.SL_BUFFER || 0.20);
const TP_RR = Number(process.env.TP_RR || 1.25);
const MIN_DELTA_PERCENT = Number(process.env.MIN_DELTA_PERCENT || 20);
const ABSORPTION_RATIO = Number(process.env.ABSORPTION_RATIO || 1.20);


let binanceWs = null;
let reconnectTimer = null;
let reconnectCount = 0;

const state = {
  service: "XAU Footprint Order Flow Engine",
  instrument: SYMBOL,
  dataSource: "Binance Futures public aggTrade stream",
  dataType: "Live exchange trade stream",
  websocketConnected: false,
  ticks: 0,
  lastTradeAt: null,
  lastPrice: null,
  lastQuantity: null,
  lastSide: null,
  totalBuyVolume: 0,
  totalSellVolume: 0,
  totalDelta: 0,
  currentCandle: {
    minute: null,
    open: null,
    high: null,
    low: null,
    close: null,
    buyVolume: 0,
    sellVolume: 0,
    delta: 0,
    trades: 0
  },
  priceLevels: new Map(),
  recentTrades: [],
  lastSignal: null,
  lastError: null
};

function resetCandle(minute, price) {
  state.currentCandle = {
    minute,
    open: price,
    high: price,
    low: price,
    close: price,
    buyVolume: 0,
    sellVolume: 0,
    delta: 0,
    trades: 0
  };
  state.priceLevels.clear();
}

function ensureCandle(timestamp, price) {
  const minute = Math.floor(timestamp / 60000);
  if (state.currentCandle.minute === null) {
    resetCandle(minute, price);
    return;
  }
  if (minute !== state.currentCandle.minute) resetCandle(minute, price);
}

function addPriceLevel(price, side, quantity) {
  const key = price.toFixed(2);
  if (!state.priceLevels.has(key)) {
    state.priceLevels.set(key, {
      price,
      buyVolume: 0,
      sellVolume: 0,
      delta: 0,
      trades: 0
    });
  }
  const level = state.priceLevels.get(key);
  if (side === "BUY") {
    level.buyVolume += quantity;
    level.delta += quantity;
  } else {
    level.sellVolume += quantity;
    level.delta -= quantity;
  }
  level.trades += 1;
}

function processTrade(data) {
  const price = Number(data.p);
  const quantity = Number(data.q);
  const timestamp = Number(data.T || Date.now());
  if (!Number.isFinite(price) || !Number.isFinite(quantity)) return;

  // m=true: buyer is maker, so seller was aggressive -> SELL.
  // m=false: buyer is taker, so buyer was aggressive -> BUY.
  const side = data.m === true ? "SELL" : "BUY";
  ensureCandle(timestamp, price);

  const candle = state.currentCandle;
  candle.high = Math.max(candle.high, price);
  candle.low = Math.min(candle.low, price);
  candle.close = price;
  candle.trades += 1;

  if (side === "BUY") {
    candle.buyVolume += quantity;
    state.totalBuyVolume += quantity;
    state.totalDelta += quantity;
  } else {
    candle.sellVolume += quantity;
    state.totalSellVolume += quantity;
    state.totalDelta -= quantity;
  }

  candle.delta = candle.buyVolume - candle.sellVolume;
  addPriceLevel(price, side, quantity);

  state.ticks += 1;
  state.lastTradeAt = new Date(timestamp).toISOString();
  state.lastPrice = price;
  state.lastQuantity = quantity;
  state.lastSide = side;
  state.lastError = null;

  state.recentTrades.push({
    time: state.lastTradeAt,
    price,
    quantity,
    side
  });
  if (state.recentTrades.length > 100) state.recentTrades.shift();
}

function calculateSignal() {
  const c = state.currentCandle;
  if (c.open === null || c.close === null || c.trades < 1) {
    return { signal: "WAIT", setup: "NO_DATA", reason: "Waiting for live trade data" };
  }

  const totalVolume = c.buyVolume + c.sellVolume;
  if (totalVolume <= 0) return { signal: "WAIT", setup: "NO_VOLUME", reason: "No live volume available" };

  const deltaPercent = (c.delta / totalVolume) * 100;
  const range = Math.max(c.high - c.low, 0.00001);
  const body = Math.abs(c.close - c.open);
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  const red = c.close < c.open;
  const green = c.close > c.open;

  // Wick requirement: the rejection wick must be material relative to candle range.
  const upperWickPct = (upperWick / range) * 100;
  const lowerWickPct = (lowerWick / range) * 100;
  const upperWickOk = upperWick > body * 0.50 && upperWickPct >= 15;
  const lowerWickOk = lowerWick > body * 0.50 && lowerWickPct >= 15;

  const levels = getFootprintLevels();
  const levelCount = levels.length;
  const topCount = Math.max(1, Math.ceil(levelCount * 0.25));
  const bottomCount = Math.max(1, Math.ceil(levelCount * 0.25));
  const topLevels = levels.slice(0, topCount);
  const bottomLevels = levels.slice(Math.max(0, levelCount - bottomCount));

  const topBuy = topLevels.reduce((n, x) => n + x.buyVolume, 0);
  const topSell = topLevels.reduce((n, x) => n + x.sellVolume, 0);
  const bottomBuy = bottomLevels.reduce((n, x) => n + x.buyVolume, 0);
  const bottomSell = bottomLevels.reduce((n, x) => n + x.sellVolume, 0);

  // Price-level absorption proxy: aggressive flow is concentrated at the rejected extreme.
  const bearishAbsorption = topBuy > 0 && topBuy >= topSell * ABSORPTION_RATIO;
  const bullishAbsorption = bottomSell > 0 && bottomSell >= bottomBuy * ABSORPTION_RATIO;

  const bearishDelta = deltaPercent >= MIN_DELTA_PERCENT;
  const bullishDelta = deltaPercent <= -MIN_DELTA_PERCENT;

  if (red && upperWickOk && bearishDelta && bearishAbsorption) {
    const entry = c.close;
    const stopLoss = c.high + SL_BUFFER;
    const risk = Math.max(stopLoss - entry, 0.01);
    const takeProfit = entry - risk * TP_RR;
    return {
      signal: "SELL",
      setup: "FOOTPRINT_BUYER_ABSORPTION",
      confidence: "CONFIRMED_RULESET",
      candle: "RED",
      deltaPercent: Number(deltaPercent.toFixed(2)),
      upperWickPct: Number(upperWickPct.toFixed(2)),
      absorption: { topBuy: Number(topBuy.toFixed(6)), topSell: Number(topSell.toFixed(6)), ratio: Number((topBuy / Math.max(topSell, 0.000001)).toFixed(2)) },
      levels: { entry, stopLoss: Number(stopLoss.toFixed(2)), takeProfit: Number(takeProfit.toFixed(2)), risk: Number(risk.toFixed(2)), rr: TP_RR },
      reason: "Red candle + material upper wick + positive delta + buy-flow concentration at the upper footprint levels."
    };
  }

  if (green && lowerWickOk && bullishDelta && bullishAbsorption) {
    const entry = c.close;
    const stopLoss = Math.max(c.low - SL_BUFFER, 0.01);
    const risk = Math.max(entry - stopLoss, 0.01);
    const takeProfit = entry + risk * TP_RR;
    return {
      signal: "BUY",
      setup: "FOOTPRINT_SELLER_ABSORPTION",
      confidence: "CONFIRMED_RULESET",
      candle: "GREEN",
      deltaPercent: Number(deltaPercent.toFixed(2)),
      lowerWickPct: Number(lowerWickPct.toFixed(2)),
      absorption: { bottomBuy: Number(bottomBuy.toFixed(6)), bottomSell: Number(bottomSell.toFixed(6)), ratio: Number((bottomSell / Math.max(bottomBuy, 0.000001)).toFixed(2)) },
      levels: { entry, stopLoss: Number(stopLoss.toFixed(2)), takeProfit: Number(takeProfit.toFixed(2)), risk: Number(risk.toFixed(2)), rr: TP_RR },
      reason: "Green candle + material lower wick + negative delta + sell-flow concentration at the lower footprint levels."
    };
  }

  return {
    signal: "WAIT",
    setup: "NONE",
    confidence: "NO_SETUP",
    deltaPercent: Number(deltaPercent.toFixed(2)),
    upperWickPct: Number(upperWickPct.toFixed(2)),
    lowerWickPct: Number(lowerWickPct.toFixed(2)),
    absorption: { bearish: bearishAbsorption, bullish: bullishAbsorption },
    reason: "All required footprint conditions are not aligned."
  };
}

function authorized(req) {
  if (!EXECUTION_SECRET) return true;
  return String(req.headers["x-execution-secret"] || "") === EXECUTION_SECRET;
}

function buildExecutionSignal() {
  const diagnostic = calculateSignal();
  const executable = diagnostic.signal === "BUY" || diagnostic.signal === "SELL";
  const id = `${diagnostic.signal}_${state.currentCandle.minute ?? "NA"}`;
  return {
    success: true,
    instrument: "XAUUSD",
    sourceInstrument: SYMBOL,
    generatedAt: new Date().toISOString(),
    signalId: id,
    signal: diagnostic.signal,
    setup: diagnostic.setup,
    executable,
    dryRun: DRY_RUN,
    autoTrade: false,
    lots: getDynamicLot("orderflow"),
    priceSource: "Binance Futures XAUUSDT aggTrade",
    currentPrice: state.lastPrice,
    levels: diagnostic.levels || null,
    diagnostic
  };
}
function connectBinance() {
  if (binanceWs) {
    try { binanceWs.removeAllListeners(); binanceWs.close(); } catch {}
  }
  state.websocketConnected = false;
  console.log("Connecting to Binance:", BINANCE_WS_URL);
  binanceWs = new WebSocket(BINANCE_WS_URL);

  binanceWs.on("open", () => {
    state.websocketConnected = true;
    state.lastError = null;
    reconnectCount = 0;
    console.log("BINANCE WEBSOCKET CONNECTED");
  });

  binanceWs.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (message && message.e === "aggTrade" && message.s === SYMBOL) processTrade(message);
    } catch (error) {
      state.lastError = `Message parse error: ${error.message}`;
      console.error(state.lastError);
    }
  });

  binanceWs.on("error", (error) => {
    state.lastError = `WebSocket error: ${error.message}`;
    console.error(state.lastError);
  });

  binanceWs.on("close", (code, reason) => {
    state.websocketConnected = false;
    console.log("BINANCE WEBSOCKET CLOSED:", code, reason ? reason.toString() : "");
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectCount += 1;
  const delay = Math.min(30000, 2000 * reconnectCount);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectBinance();
  }, delay);
}

function getCandleOutput() {
  const c = state.currentCandle;
  return {
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    buyVolume: Number(c.buyVolume.toFixed(8)),
    sellVolume: Number(c.sellVolume.toFixed(8)),
    delta: Number(c.delta.toFixed(8)),
    trades: c.trades
  };
}

function getFootprintLevels() {
  return Array.from(state.priceLevels.values())
    .sort((a, b) => b.price - a.price)
    .map(level => ({
      price: level.price,
      buyVolume: Number(level.buyVolume.toFixed(8)),
      sellVolume: Number(level.sellVolume.toFixed(8)),
      delta: Number(level.delta.toFixed(8)),
      trades: level.trades
    }));
}


return { SYMBOL, BINANCE_WS_URL, DRY_RUN, state, calculateSignal, buildExecutionSignal, connectBinance, getCandleOutput, getFootprintLevels, authorized };
})();


/* =========================================================
   SECTION 4 — STRATEGY #5 HTTP + independent Telegram alerting
   ========================================================= */
let lastS5SignalKey = null;
let lastS5Alert = null;
async function scanStrategy5AndAlert() {
  try {
    const x = await strategy5Scan();
    if (x.executable) {
      const l = x.tradeLevels || {}, s = x.signal || {};
      const key = [s.direction, s.signalTime, l.entry, l.stopLoss, l.takeProfit].join("|");
      if (key !== lastS5SignalKey) {
        const message = [
          "━━━━━━━━━━━━━━━━━━━━", "🚨 XAUUSD STRATEGY #5", "━━━━━━━━━━━━━━━━━━━━",
          `Direction: ${s.direction || "WAIT"}`, `Status: ${s.status || "WAITING"}`,
          `Current: ${x.currentPrice ?? "N/A"}`, "", "TRADE LEVELS",
          `Entry: ${l.entry ?? "N/A"}`, `SL: ${l.stopLoss ?? "N/A"}`, `TP: ${l.takeProfit ?? "N/A"}`,
          "", "Rules: Support/Resistance Rejection | RR 1:2", "━━━━━━━━━━━━━━━━━━━━"
        ].join("\n");
        lastS5Alert = { ...(await sendTelegram("strategy5", message)), attemptedAt: new Date().toISOString(), signalKey: key };
        if (lastS5Alert.sent) lastS5SignalKey = key;
      }
    }
    return x;
  } catch (e) {
    lastError = e.message;
    return { success:false, strategy:"STRATEGY_5", status:"ERROR", error:e.message };
  }
}

/* =========================================================
   SECTION 5 — P78 HTTP + its own Telegram ON/OFF
   ========================================================= */
app.get("/strategy5/decision", auth, async (req,res) => {
  try {
    const x = await strategy5Scan();
    res.status(200).json({
      ...x, lots:getDynamicLot("strategy5"), telegramEnabled:telegramEnabledByStrategy.strategy5,
      liquidAutoTrade:LIQUID_AUTO_TRADE, executionAllowed:LIQUID_AUTO_TRADE && !!x.executable
    });
  } catch(e) {
    lastError=e.message;
    res.status(500).json({success:false,strategy:"STRATEGY_5",status:"ERROR",error:e.message});
  }
});
app.get("/strategy5/status", (req,res) => res.json({
  success:true, strategy:"STRATEGY_5", status:"RUNNING", telegramEnabled:telegramEnabledByStrategy.strategy5,
  lastAlert:lastS5Alert, lastSignalKey:lastS5SignalKey, lot:lotBookOutput().strategy5, lastError
}));

app.get("/p78/decision", auth, async (req,res) => {
  const x=await scanAndAlert();
  const consumed=!!x.signalKey&&p78ConsumedSignalKeys.has(x.signalKey);
  res.status(x.success===false?500:200).json({
    ...x, signalConsumed:consumed, lots:getDynamicLot("p78"), telegramEnabled:telegramEnabledByStrategy.p78,
    liquidAutoTrade:LIQUID_AUTO_TRADE,
    executionAllowed:LIQUID_AUTO_TRADE && !!x.executable && !consumed
  });
});
app.post("/p78/consume", auth, (req,res) => {
  const key=String(req.body?.signalKey||"").trim();
  if(!key)return res.status(400).json({success:false,error:"signalKey is required"});
  if(p78ConsumedSignalKeys.has(key))return res.json({success:true,accepted:false,alreadyConsumed:true,persisted:p78StatePersisted});
  p78ConsumedSignalKeys.add(key);
  // Keep the in-memory list bounded; optional Render persistent disk can survive restarts.
  while(p78ConsumedSignalKeys.size>2000)p78ConsumedSignalKeys.delete(p78ConsumedSignalKeys.values().next().value);
  const persisted=saveP78ConsumedKeys();
  res.json({success:true,accepted:true,alreadyConsumed:false,persisted});
});
app.get("/p78/status", (req,res) => res.json({
  success:true, strategy:"P78", status:"RUNNING", liquidAutoTrade:LIQUID_AUTO_TRADE,
  telegramEnabled:telegramEnabledByStrategy.p78, telegramConfigured:!!(TELEGRAM_BOT_TOKEN&&TELEGRAM_CHAT_ID),
  lastScanAt:lastScan?.generatedAt||null,lastSignalKey,lastTelegram,lastError,
  consumedSignalCount:p78ConsumedSignalKeys.size,consumedStateFileConfigured:!!P78_STATE_FILE,persisted:p78StatePersisted,
  lot:lotBookOutput().p78, backtest:{trades:354,wins:277,losses:77,winRate:78.25,netR:255.40}
}));

/* =========================================================
   SECTION 6 — ORDER FLOW HTTP + independent Telegram alerting
   ========================================================= */
let lastOFSignalKey = null;
let lastOFAlert = null;
function orderFlowTelegramText(result) {
  const d=result.diagnostic||result, l=d.levels||{};
  return [
    "━━━━━━━━━━━━━━━━━━━━","🚨 XAUUSD ORDER FLOW SIGNAL","━━━━━━━━━━━━━━━━━━━━",
    `Direction: ${d.signal || "WAIT"}`,`Setup: ${d.setup || "NONE"}`,
    `Current: ${result.currentPrice ?? orderFlow.state.lastPrice ?? "N/A"}`,
    "", "TRADE LEVELS", `Entry: ${l.entry ?? "N/A"}`, `SL: ${l.stopLoss ?? "N/A"}`, `TP: ${l.takeProfit ?? "N/A"}`,
    "", `Delta: ${d.deltaPercent ?? "N/A"}%`, "━━━━━━━━━━━━━━━━━━━━"
  ].join("\n");
}
async function scanOrderFlowAndAlert() {
  const result = orderFlow.buildExecutionSignal();
  orderFlow.state.lastSignal = result.diagnostic;
  if (result.executable) {
    const key = [result.signalId,result.signal,result.levels?.entry,result.levels?.stopLoss,result.levels?.takeProfit].join("|");
    if (key !== lastOFSignalKey) {
      lastOFAlert = { ...(await sendTelegram("orderflow", orderFlowTelegramText(result))), attemptedAt:new Date().toISOString(), signalKey:key };
      if (lastOFAlert.sent) lastOFSignalKey=key;
    }
  }
  return result;
}
app.get("/orderflow/execution-signal", (req,res) => {
  if (!orderFlow.authorized(req)) return res.status(401).json({success:false,error:"Unauthorized"});
  const result=orderFlow.buildExecutionSignal();
  res.json({...result, telegramEnabled:telegramEnabledByStrategy.orderflow, lot:lotBookOutput().orderflow});
});
app.get("/orderflow/signal", (req,res) => {
  const signal=orderFlow.calculateSignal();
  orderFlow.state.lastSignal=signal;
  res.json({
    success:true, strategy:"ORDER_FLOW", instrument:"XAUUSD", generatedAt:new Date().toISOString(),
    dataReady:orderFlow.state.ticks>0, websocketConnected:orderFlow.state.websocketConnected,
    ticks:orderFlow.state.ticks, signal:signal.signal, setup:signal.setup||"NONE",
    candle:orderFlow.getCandleOutput(), diagnostic:signal, lots:getDynamicLot("orderflow"),
    telegramEnabled:telegramEnabledByStrategy.orderflow
  });
});
app.get("/orderflow/status", (req,res) => res.json({
  success:true, service:orderFlow.state.service, instrument:orderFlow.SYMBOL,
  websocket:{connected:orderFlow.state.websocketConnected,endpoint:orderFlow.BINANCE_WS_URL},
  ticks:orderFlow.state.ticks,lastTradeAt:orderFlow.state.lastTradeAt,lastPrice:orderFlow.state.lastPrice,
  lastError:orderFlow.state.lastError,telegramEnabled:telegramEnabledByStrategy.orderflow,
  lastAlert:lastOFAlert,lot:lotBookOutput().orderflow
}));
app.get("/orderflow/footprint", (req,res) => {
  const candle=orderFlow.getCandleOutput();
  const totalVolume=candle.buyVolume+candle.sellVolume;
  res.json({
    success:true,service:orderFlow.state.service,symbol:orderFlow.SYMBOL,generatedAt:new Date().toISOString(),
    dataSource:orderFlow.state.dataSource,dataType:orderFlow.state.dataType,
    websocket:{connected:orderFlow.state.websocketConnected},ticks:orderFlow.state.ticks,
    lastTradeAt:orderFlow.state.lastTradeAt,lastPrice:orderFlow.state.lastPrice,
    totalBuyVolume:Number(orderFlow.state.totalBuyVolume.toFixed(8)),
    totalSellVolume:Number(orderFlow.state.totalSellVolume.toFixed(8)),
    totalDelta:Number(orderFlow.state.totalDelta.toFixed(8)),candle,
    footprint:orderFlow.getFootprintLevels(),
    summary:{buyVolume:candle.buyVolume,sellVolume:candle.sellVolume,delta:candle.delta,
      deltaPercent:totalVolume>0?Number((candle.delta/totalVolume*100).toFixed(2)):0,totalTrades:candle.trades},
    recentTrades:orderFlow.state.recentTrades.slice(-20),lastError:orderFlow.state.lastError
  });
});

/* =========================================================
   SECTION 6B — ORDER BLOCK HTTP endpoints (isolated per timeframe)
   ========================================================= */
let lastOBAlertKey = new Set();
function orderBlockTelegramText(x) {
  const z=x.zone||{},l=x.tradeLevels||{},s=x.signal||{},q=x.sizing||{};
  return ["━━━━━━━━━━━━━━━━━━━━","🚨 XAUUSD ORDER BLOCK",`Timeframe: ${x.timeframe}`,"━━━━━━━━━━━━━━━━━━━━",
    `Direction: ${s.direction||"WAIT"}`,`Entry: ${l.entry??"N/A"}`,`SL: ${l.stopLoss??"N/A"}`,
    `Zone: ${z.zoneLow??"N/A"} - ${z.zoneHigh??"N/A"}`,`Lots: ${q.lots??"N/A"}`,
    `Estimated risk: ${q.estimatedRisk??"N/A"} (${q.riskPercent??"N/A"}% equity)`,
    "First touch only | displacement candle defines OB zone | body >= 1 ATR | close breaks prior 10-candle structure",
    "Trail: +1% equity => SL entry; +2% => lock +1%; +3% => lock +2%; continues beyond +3%.",
    "Broker order/SL modification requires Liquid Chart execution bridge.","━━━━━━━━━━━━━━━━━━━━"].join("\n");
}
app.get("/orderblock/decision", auth, async (req,res) => {
  try {
    const timeframe=String(req.query.timeframe||"5M").toUpperCase();
    const equity=Number(req.query.equity);
    const x=await orderBlockScan(timeframe,equity);
    if(x.executable && x.signalKey && !lastOBAlertKey.has(x.signalKey)){
      lastOBAlertKey.add(x.signalKey);
      const alert=await sendTelegram("orderblock",orderBlockTelegramText(x));
      orderBlockState[timeframe].lastAlert={...alert,signalKey:x.signalKey,attemptedAt:new Date().toISOString()};
    }
    res.status(200).json({...x,telegramEnabled:telegramEnabledByStrategy.orderblock,contractSize:OB_CONTRACT_SIZE,
      equityProvided:Number.isFinite(equity)&&equity>0,activeTrades:Object.fromEntries(Object.entries(orderBlockState).map(([tf,v])=>[tf,v.activeTrade]))});
  } catch(e) {
    const tf=String(req.query.timeframe||"5M").toUpperCase(); if(orderBlockState[tf])orderBlockState[tf].lastError=e.message;
    res.status(400).json({success:false,strategy:"ORDER_BLOCK",status:"ERROR",error:e.message});
  }
});
app.get("/orderblock/status", (req,res) => res.json({success:true,strategy:"ORDER_BLOCK",timeframes:orderBlockState,
  rules:{lookbackCandles:OB_LOOKBACK,maxActiveZones:OB_MAX_ZONES,displacementBodyATR:OB_ATR_MULTIPLE,
    structureLookback:10,firstTouchOnly:true,oneActiveTradePerTimeframe:true,maxEquityRiskPercent:1,
    contractSize:OB_CONTRACT_SIZE,lotStep:OB_LOT_STEP,minLot:OB_MIN_LOT,maxLot:OB_MAX_LOT,
    trailing:"+1% => entry; +2% => lock +1%; +3% => lock +2%; continue every +1%, no fixed profit close"},
  telegramEnabled:telegramEnabledByStrategy.orderblock,lot:lotBookOutput().orderblock}));
app.post("/orderblock/manage", auth, (req,res) => {
  try { res.json(obManagePosition(req.body?.timeframe,req.body?.currentPrice,req.body?.equity)); }
  catch(e) { res.status(400).json({success:false,error:e.message}); }
});
app.post("/orderblock/close", auth, (req,res) => {
  const tf=String(req.body?.timeframe||"").toUpperCase();
  if(!OB_TIMEFRAMES[tf])return res.status(400).json({success:false,error:"timeframe must be 5M, 15M, or 1H."});
  const trade=orderBlockState[tf].activeTrade;
  if(!trade)return res.status(400).json({success:false,error:`No active Order Block trade for ${tf}.`});
  orderBlockState[tf].activeTrade=null;
  res.json({success:true,closedTrade:trade,timeframe:tf});
});

/* =========================================================
   SECTION 7 — independent Telegram switches and compounding results
   ========================================================= */
app.post("/telegram/:strategy", auth, (req,res) => {
  const key=String(req.params.strategy||"").toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(telegramEnabledByStrategy,key)) {
    return res.status(400).json({success:false,error:"Use strategy5, p78, orderflow, or orderblock."});
  }
  telegramEnabledByStrategy[key]=!!req.body?.enabled;
  res.json({success:true,strategy:key,telegramEnabled:telegramEnabledByStrategy[key]});
});
app.get("/telegram/status", (req,res) => res.json({
  success:true,configured:!!(TELEGRAM_BOT_TOKEN&&TELEGRAM_CHAT_ID),strategies:{...telegramEnabledByStrategy}
}));

// Execution bridge must report each closed trade once to compound the matching strategy only.
// POST /risk/strategy5/result, /risk/p78/result, /risk/orderflow/result
// JSON body: {"result":"WIN","pnl":12.5} or {"result":"LOSS","pnl":-5}
app.post("/risk/:strategy/result", (req,res) => {
  if (!resultAuth(req)) return res.status(401).json({success:false,error:"Unauthorized"});
  const strategy=String(req.params.strategy||"").toLowerCase();
  try {
    const result=applyTradeResult(strategy,req.body?.result,req.body?.pnl);
    let closedOrderBlockTrade=null;
    if(strategy==="orderblock" && req.body?.timeframe){
      const tf=String(req.body.timeframe).toUpperCase();
      if(!OB_TIMEFRAMES[tf])throw new Error("timeframe must be 5M, 15M, or 1H.");
      closedOrderBlockTrade=orderBlockState[tf].activeTrade;
      orderBlockState[tf].activeTrade=null;
    }
    res.json({success:true,...result,closedOrderBlockTrade,lotBook:lotBookOutput()});
  } catch(e) {
    res.status(400).json({success:false,error:e.message});
  }
});
app.get("/risk/status", (req,res) => res.json({
  success:true,lotStep:LOT_STEP,winMultiplier:LOT_WIN_MULTIPLIER,lossMultiplier:LOT_LOSS_MULTIPLIER,
  minLot:LOT_MIN,maxLot:LOT_MAX,strategies:lotBookOutput()
}));

/* =========================================================
   SECTION 8 — Telegram command controls
   Commands: /start_s5 /stop_s5 /status_s5
             /start_p78 /stop_p78 /status_p78
             /start_orderflow /stop_orderflow /status_orderflow
             /start_orderblock /stop_orderblock /status_orderblock /status_all
   ========================================================= */
let telegramUpdateOffset=0;
let telegramPollingBusy=false;
async function pollTelegramCommands() {
  if (telegramPollingBusy || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  telegramPollingBusy=true;
  try {
    const url=`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${telegramUpdateOffset}&timeout=0`;
    const response=await fetch(url);
    const payload=await response.json();
    if (!response.ok || !payload.ok || !Array.isArray(payload.result)) return;
    for (const update of payload.result) {
      telegramUpdateOffset=Math.max(telegramUpdateOffset,Number(update.update_id)+1);
      const message=update.message;
      if (!message?.text || String(message.chat?.id)!==String(TELEGRAM_CHAT_ID)) continue;
      const command=message.text.trim().split(/\s+/)[0].toLowerCase();
      const controls={
        "/start_s5":["strategy5",true],"/stop_s5":["strategy5",false],
        "/start_p78":["p78",true],"/stop_p78":["p78",false],
        "/start_orderflow":["orderflow",true],"/stop_orderflow":["orderflow",false],
        "/start_orderblock":["orderblock",true],"/stop_orderblock":["orderblock",false]
      };
      if (controls[command]) {
        const [strategy,enabled]=controls[command];
        telegramEnabledByStrategy[strategy]=enabled;
        await sendTelegramRaw(`✅ ${strategy} Telegram signals ${enabled?"ON":"OFF"}`);
      } else if (command==="/status_s5") {
        await sendTelegramRaw(`Strategy #5 Telegram: ${telegramEnabledByStrategy.strategy5?"ON":"OFF"} | Lot: ${getDynamicLot("strategy5")}`);
      } else if (command==="/status_p78") {
        await sendTelegramRaw(`P78 Telegram: ${telegramEnabledByStrategy.p78?"ON":"OFF"} | Lot: ${getDynamicLot("p78")}`);
      } else if (command==="/status_orderflow") {
        await sendTelegramRaw(`Order Flow Telegram: ${telegramEnabledByStrategy.orderflow?"ON":"OFF"} | Lot: ${getDynamicLot("orderflow")}`);
      } else if (command==="/status_orderblock") {
        await sendTelegramRaw(`Order Block Telegram: ${telegramEnabledByStrategy.orderblock?"ON":"OFF"} | Lot: ${getDynamicLot("orderblock")} | Active: ${Object.entries(orderBlockState).filter(([tf,v])=>v.activeTrade).map(([tf])=>tf).join(",")||"NONE"}`);
      } else if (command==="/status_all") {
        await sendTelegramRaw([
          `Strategy #5: ${telegramEnabledByStrategy.strategy5?"ON":"OFF"} | Lot ${getDynamicLot("strategy5")}`,
          `P78: ${telegramEnabledByStrategy.p78?"ON":"OFF"} | Lot ${getDynamicLot("p78")}`,
          `Order Flow: ${telegramEnabledByStrategy.orderflow?"ON":"OFF"} | Lot ${getDynamicLot("orderflow")}`,
          `Order Block: ${telegramEnabledByStrategy.orderblock?"ON":"OFF"} | Lot ${getDynamicLot("orderblock")}`
        ].join("\n"));
      }
    }
  } catch(e) {
    console.error("Telegram command poll error:",e.message);
  } finally {
    telegramPollingBusy=false;
  }
}
async function sendTelegramRaw(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return {sent:false,reason:"Telegram not configured"};
  try {
    const r=await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({chat_id:TELEGRAM_CHAT_ID,text:String(message)})
    });
    const j=await r.json();
    return {sent:!!(r.ok&&j.ok),error:j.description||null};
  } catch(e) { return {sent:false,error:e.message}; }
}

/* =========================================================
   SECTION 9 — Common health/root routes and one server listener
   ========================================================= */
app.get("/", (req,res) => res.json({
  success:true,service:"XAUUSD Four-Strategy Signal Server",port:PORT,
  strategies:["strategy5","p78","orderflow","orderblock"],
  endpoints:[
    "/strategy5/decision","/strategy5/status","/p78/decision","POST /p78/consume","/p78/status",
    "/orderflow/signal","/orderflow/execution-signal","/orderflow/status","/orderflow/footprint",
    "/orderblock/decision?timeframe=5M&equity=1000","/orderblock/status","POST /orderblock/manage","POST /orderblock/close",
    "/telegram/status","POST /telegram/:strategy","POST /risk/:strategy/result","/risk/status","/health"
  ]
}));
app.get("/health", (req,res) => res.json({
  success:true,status:"ok",service:"XAUUSD Four-Strategy Signal Server",
  orderFlowWebSocketConnected:orderFlow.state.websocketConnected,
  orderFlowTicks:orderFlow.state.ticks,
  orderBlockActiveTrades:Object.fromEntries(Object.entries(orderBlockState).map(([tf,v])=>[tf,!!v.activeTrade])),
  lastP78Error:lastError
}));

/* Independent periodic scans; a Telegram toggle only disables that strategy's messages. */
setTimeout(() => { scanStrategy5AndAlert(); scanAndAlert(); }, 20000);
setInterval(scanStrategy5AndAlert, 30000);
setInterval(scanAndAlert, 60000);
setInterval(scanOrderFlowAndAlert, 5000);
setInterval(scanOrderBlockAndAlert, 15000);
setInterval(pollTelegramCommands, 4000);

app.listen(PORT,"0.0.0.0",() => {
  console.log(`XAUUSD Four-Strategy Server listening on ${PORT}`);
  console.log(`Order Flow Binance stream: ${orderFlow.BINANCE_WS_URL}`);
  orderFlow.connectBinance();
});

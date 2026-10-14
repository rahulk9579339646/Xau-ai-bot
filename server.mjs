/* =========================================================
   XAUUSD THREE-STRATEGY RENDER SERVER
   SECTION 1: Strategy #5 — Support/Resistance Rejection
   SECTION 2: P78 — exact existing conditions retained
   SECTION 3: Order Flow — original wick/delta/absorption conditions retained
   SECTION 4+: independent Telegram switches + separate lot compounding

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
const telegramEnabledByStrategy = { strategy5: true, p78: true, orderflow: true };

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

/* P78 = ONLY these 3 conditions. Future 25-candle continuation is NOT used. */
async function p78Scan(){
  const [raw1,raw15,raw5]=await Promise.all([getCandles(TF["1H"],5000),getCandles(TF["15M"],5000),getCandles(TF["5M"],5000)]);
  const c1=addIndicators(raw1),c15=addIndicators(raw15),c5=addIndicators(raw5),atr=c5.map(x=>x.ATR14);
  const raw=rawTrendlineSignals(c5);
  const candidates=[];
  for(const s of raw){
    const k=s.idx;if(k>=c5.length-1)continue;
    const cs=candleStrength(c5,k,s.Direction,atr);if(cs.strength==="Weak")continue;
    const mtf=mtfScore(c1,c15,s.Time,s.Direction);if(mtf.score<5)continue;
    const rt=retestHeld(c5,k,s.Direction,s.Price,atr);if(!rt.held)continue;
    const risk=atr[k]*0.50,entry=s.Price;
    const sl=s.Direction==="BUY"?entry-risk:entry+risk;
    const tp=s.Direction==="BUY"?entry+risk*2.50:entry-risk*2.50;
    candidates.push({signal:s,k,entry,sl,tp,risk,score:mtf.score,mtfBreakdown:mtf.mtfBreakdown,strength:cs,retest:rt,trendlineSource:"EXACT P78 BACKTEST ENGINE"});
  }
  candidates.sort((a,b)=>b.k-a.k);const x=candidates[0]||null;const current=last(c5)?.close??null;if(x){x.entry=current;x.sl=x.signal.Direction==="BUY"?current-x.risk:current+x.risk;x.tp=x.signal.Direction==="BUY"?current+x.risk*2.50:current-x.risk*2.50;}
  return{success:true,strategy:"P78",strategyName:"XAUUSD P78 — Exact Backtested Strategy",instrument:OUTPUT_SYMBOL,executionTimeframe:"5M",contextTimeframes:["1H","15M"],generatedAt:new Date().toISOString(),currentPrice:current,status:x?"CONFIRMED":"WAITING",executable:!!x,signal:x?{direction:x.signal.Direction,status:"P78 CONFIRMED",score:x.score,maxScore:6,signalIndex:x.k,signalTime:x.signal.Time,candleStrength:x.strength.strength}: {direction:null,status:"WAITING",score:0,maxScore:6},mtfBreakdown:x?.mtfBreakdown||null,tradeLevels:x?{entry:round(x.entry),stopLoss:round(x.sl),takeProfit:round(x.tp),risk:round(x.risk),rr:"1:2.50"}:null,components:x?{candleStrength:x.strength,mtfScore:x.score,mtfBreakdown:x.mtfBreakdown,retestHeld:x.retest,trendline:x.signal,continuation:"NOT USED"}:null,backtest:{trades:354,wins:277,losses:77,winRate:78.25,netR:255.40},note:"P78 = CandleStrength != Weak + MTF_Score >= 5 + RetestHeld. Future 25-candle Continuation condition is NOT USED."};
}

function telegramText(x){const s=x.signal||{},l=x.tradeLevels||{};return ["━━━━━━━━━━━━━━━━━━━━","🚨 XAUUSD P78 SIGNAL","━━━━━━━━━━━━━━━━━━━━",`Direction: ${s.direction||"WAIT"}`,`Status: ${s.status||"WAITING"}`,`MTF Score: ${s.score??0}/6`,`Current: ${x.currentPrice??"N/A"}`,"","TRADE LEVELS",`Entry: ${l.entry??"N/A"}`,`SL: ${l.stopLoss??"N/A"}`,`TP: ${l.takeProfit??"N/A"}`,"","Conditions","• CandleStrength != Weak","• MTF Score >= 5","• RetestHeld = TRUE","• Future 25-candle Continuation = NOT USED","","Backtest: 354 trades | 277W | 77L | 78.25% | +255.40R","━━━━━━━━━━━━━━━━━━━━"].join("\n");}
async function sendTelegram(strategy,message){if(!telegramEnabledByStrategy[strategy]||!TELEGRAM_BOT_TOKEN||!TELEGRAM_CHAT_ID)return{sent:false,reason:"Telegram disabled/not configured for "+strategy};try{const r=await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:TELEGRAM_CHAT_ID,text:String(message)})});const j=await r.json();if(!r.ok||!j.ok)throw new Error(j.description||"Telegram failed");return{sent:true};}catch(e){return{sent:false,error:e.message};}}
async function scanAndAlert(){try{const x=await p78Scan();lastScan=x;lastError=null;if(x.executable){const l=x.tradeLevels||{},key=[x.signal.direction,l.entry,l.stopLoss,l.takeProfit,x.signal.signalTime].join("|");if(key!==lastSignalKey){lastTelegram={...(await sendTelegram("p78",telegramText(x))),attemptedAt:new Date().toISOString(),signalKey:key};if(lastTelegram.sent)lastSignalKey=key;}}return x;}catch(e){lastError=e.message;return{success:false,strategy:"P78",status:"ERROR",error:e.message};}}
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
  orderflow: { base: Math.max(LOT_MIN, Number(process.env.ORDERFLOW_BASE_LOT || 0.05)), current: null, wins: 0, losses: 0, lastResult: null, updatedAt: null }
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
  if (!book) throw new Error("Unknown strategy. Use strategy5, p78, or orderflow.");
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
   SECTION 3 — ORDER FLOW STRATEGY
   CLOSED M1 + CLOSED M5 CONFIRMATION
   RR 1:2 | Existing delta/wick/absorption rules retained
   ========================================================= */

const orderFlow = (() => {
  const SYMBOL = "XAUUSDT";
  const BINANCE_WS_URL = "wss://fstream.binance.com/ws/xauusdt@aggTrade";

  const DRY_RUN = String(process.env.DRY_RUN ?? "true").toLowerCase() === "true";
  const EXECUTION_SECRET = process.env.EXECUTION_SECRET || "";
  const SL_BUFFER_MODE = String(process.env.SL_BUFFER_MODE || "fixed").toLowerCase();
  const SL_BUFFER = Number(process.env.SL_BUFFER || 0.20);
  const ATR_BUFFER_MULTIPLIER = Number(process.env.ATR_BUFFER_MULTIPLIER || 0.10);
  const TP_RR = 2.0;
  const MIN_DELTA_PERCENT = Number(process.env.MIN_DELTA_PERCENT || 20);
  const ABSORPTION_RATIO = Number(process.env.ABSORPTION_RATIO || 1.20);
  const MIN_M1_TOTAL_VOLUME = Number(process.env.MIN_M1_TOTAL_VOLUME ?? 0.05);

  let binanceWs = null;
  let reconnectTimer = null;
  let reconnectCount = 0;
  let lastLoggedSignalKey = "";

  const state = {
    service: "XAU Footprint Order Flow Engine",
    instrument: SYMBOL,
    dataSource: "Binance Futures public aggTrade stream",
    dataType: "Closed M1 entry + closed M5 confirmation",
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
    closedM1: null,
    closedM1PriceLevels: [],
    closedM1History: [],
    currentM5: null,
    closedM5: null,
    priceLevels: new Map(),
    recentTrades: [],
    lastSignal: null,
    lastError: null
  };

  function newCandle(bucket, price) {
    return {
      bucket,
      minute: bucket,
      open: price,
      high: price,
      low: price,
      close: price,
      buyVolume: 0,
      sellVolume: 0,
      delta: 0,
      trades: 0
    };
  }

  function cloneCandle(c) {
    return c ? { ...c } : null;
  }

  function cloneLevels() {
    return Array.from(state.priceLevels.values()).map(x => ({ ...x }));
  }

  function resetM1(minute, price) {
    state.currentCandle = newCandle(minute, price);
    state.priceLevels.clear();
  }

  function ensureCandle(timestamp, price) {
    const minute = Math.floor(timestamp / 60000);

    if (state.currentCandle.minute === null) {
      resetM1(minute, price);
      return;
    }

    if (minute !== state.currentCandle.minute) {
      const closed = cloneCandle(state.currentCandle);
      const levels = cloneLevels();

      if (closed && closed.trades > 0) {
        state.closedM1 = closed;
        state.closedM1PriceLevels = levels;
        state.closedM1History.push(closed);

        if (state.closedM1History.length > 100) {
          state.closedM1History.shift();
        }
      }

      resetM1(minute, price);
    }
  }

  function ensureM5(timestamp, price) {
    const bucket = Math.floor(timestamp / 300000);

    if (!state.currentM5) {
      state.currentM5 = newCandle(bucket, price);
      return;
    }

    if (bucket !== state.currentM5.bucket) {
      if (state.currentM5.trades > 0) {
        state.closedM5 = cloneCandle(state.currentM5);
      }

      state.currentM5 = newCandle(bucket, price);
    }
  }

  function updateCandle(candle, side, price, quantity) {
    candle.high = Math.max(candle.high, price);
    candle.low = Math.min(candle.low, price);
    candle.close = price;
    candle.trades += 1;

    if (side === "BUY") {
      candle.buyVolume += quantity;
    } else {
      candle.sellVolume += quantity;
    }

    candle.delta = candle.buyVolume - candle.sellVolume;
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

    if (
      !Number.isFinite(price) ||
      !Number.isFinite(quantity) ||
      quantity <= 0
    ) {
      return;
    }

    const side = data.m === true ? "SELL" : "BUY";

    ensureM5(timestamp, price);
    ensureCandle(timestamp, price);

    updateCandle(state.currentCandle, side, price, quantity);
    updateCandle(state.currentM5, side, price, quantity);

    if (side === "BUY") {
      state.totalBuyVolume += quantity;
      state.totalDelta += quantity;
    } else {
      state.totalSellVolume += quantity;
      state.totalDelta -= quantity;
    }

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

    if (state.recentTrades.length > 100) {
      state.recentTrades.shift();
    }
  }

  function getFootprintLevels() {
    return state.closedM1PriceLevels
      .map(level => ({
        price: level.price,
        buyVolume: Number(level.buyVolume.toFixed(8)),
        sellVolume: Number(level.sellVolume.toFixed(8)),
        delta: Number(level.delta.toFixed(8)),
        trades: level.trades
      }))
      .sort((a, b) => b.price - a.price);
  }

  function getBuffer(candle) {
    if (SL_BUFFER_MODE !== "atr") {
      return SL_BUFFER;
    }

    const history = state.closedM1History.slice(-14);
    const ranges = history
      .map(x => Math.max(0, x.high - x.low))
      .filter(Number.isFinite);

    if (ranges.length < 5) {
      return SL_BUFFER;
    }

    const atr = ranges.reduce((a, b) => a + b, 0) / ranges.length;

    return Math.max(
      SL_BUFFER * 0.25,
      atr * ATR_BUFFER_MULTIPLIER
    );
  }

  function calculateSignal() {
    const c = state.closedM1;
    const m5 = state.closedM5;

    if (!c || c.open == null || c.close == null || c.trades < 1) {
      return {
        signal: "WAIT",
        setup: "WAIT_M1_CLOSE",
        reason: "Waiting for a completed M1 footprint candle"
      };
    }

    if (!m5 || m5.open == null || m5.close == null || m5.trades < 1) {
      return {
        signal: "WAIT",
        setup: "WAIT_M5_CLOSE",
        reason: "Waiting for a completed M5 confirmation candle",
        m1: c
      };
    }

    const totalVolume = c.buyVolume + c.sellVolume;

    if (totalVolume <= 0) {
      return {
        signal: "WAIT",
        setup: "NO_VOLUME",
        reason: "Closed M1 candle has no volume"
      };
    }

    const deltaPercent = (c.delta / totalVolume) * 100;
    const range = Math.max(c.high - c.low, 0.00001);
    const body = Math.abs(c.close - c.open);

    const upperWick = c.high - Math.max(c.open, c.close);
    const lowerWick = Math.min(c.open, c.close) - c.low;

    const red = c.close < c.open;
    const green = c.close > c.open;

    const upperWickPct = (upperWick / range) * 100;
    const lowerWickPct = (lowerWick / range) * 100;

    const upperWickOk =
      upperWick > body * 0.50 && upperWickPct >= 15;

    const lowerWickOk =
      lowerWick > body * 0.50 && lowerWickPct >= 15;

    const levels = getFootprintLevels();
    const levelCount = levels.length;
    const topCount = Math.max(1, Math.ceil(levelCount * 0.25));
    const bottomCount = Math.max(1, Math.ceil(levelCount * 0.25));

    const topLevels = levels.slice(0, topCount);
    const bottomLevels = levels.slice(
      Math.max(0, levelCount - bottomCount)
    );

    const topBuy = topLevels.reduce((n, x) => n + x.buyVolume, 0);
    const topSell = topLevels.reduce((n, x) => n + x.sellVolume, 0);
    const bottomBuy = bottomLevels.reduce((n, x) => n + x.buyVolume, 0);
    const bottomSell = bottomLevels.reduce((n, x) => n + x.sellVolume, 0);

    const bearishAbsorption =
      topBuy > 0 && topBuy >= topSell * ABSORPTION_RATIO;

    const bullishAbsorption =
      bottomSell > 0 && bottomSell >= bottomBuy * ABSORPTION_RATIO;

    const bearishDelta = deltaPercent >= MIN_DELTA_PERCENT;
    const bullishDelta = deltaPercent <= -MIN_DELTA_PERCENT;
    const volumeOk = totalVolume >= MIN_M1_TOTAL_VOLUME;

    const m5Bullish = m5.close > m5.open;
    const m5Bearish = m5.close < m5.open;

    const buffer = getBuffer(c);

    const common = {
      deltaPercent: Number(deltaPercent.toFixed(2)),
      totalVolume: Number(totalVolume.toFixed(8)),
      minVolumeRequired: MIN_M1_TOTAL_VOLUME,
      volumeOk,
      m1Minute: c.minute,
      m5Bucket: m5.bucket,
      m5Direction: m5Bullish
        ? "BULLISH"
        : m5Bearish
          ? "BEARISH"
          : "FLAT",
      m5Open: m5.open,
      m5High: m5.high,
      m5Low: m5.low,
      m5Close: m5.close,
      upperWickPct: Number(upperWickPct.toFixed(2)),
      lowerWickPct: Number(lowerWickPct.toFixed(2)),
      absorptionRatioRequired: ABSORPTION_RATIO,
      deltaThresholdRequired: MIN_DELTA_PERCENT,
      slBuffer: Number(buffer.toFixed(5)),
      slBufferMode: SL_BUFFER_MODE
    };

    if (
      volumeOk &&
      red &&
      upperWickOk &&
      bearishDelta &&
      bearishAbsorption &&
      m5Bearish
    ) {
      const entry = c.close;
      const stopLoss = c.high + buffer;
      const risk = Math.max(stopLoss - entry, 0.01);
      const takeProfit = entry - risk * TP_RR;

      return {
        signal: "SELL",
        setup: "M5_BEARISH_M1_BUYER_ABSORPTION",
        confidence: "CLOSED_M1_M5_CONFIRMED",
        candle: "RED",
        ...common,
        absorption: {
          topBuy: Number(topBuy.toFixed(6)),
          topSell: Number(topSell.toFixed(6)),
          ratio: Number(
            (topBuy / Math.max(topSell, 0.000001)).toFixed(2)
          )
        },
        levels: {
          entry,
          stopLoss: Number(stopLoss.toFixed(2)),
          takeProfit: Number(takeProfit.toFixed(2)),
          risk: Number(risk.toFixed(2)),
          rr: TP_RR
        },
        reason:
          "Closed bearish M5 + closed red M1 rejection wick + positive delta + buyer absorption + volume gate."
      };
    }

    if (
      volumeOk &&
      green &&
      lowerWickOk &&
      bullishDelta &&
      bullishAbsorption &&
      m5Bullish
    ) {
      const entry = c.close;
      const stopLoss = Math.max(c.low - buffer, 0.01);
      const risk = Math.max(entry - stopLoss, 0.01);
      const takeProfit = entry + risk * TP_RR;

      return {
        signal: "BUY",
        setup: "M5_BULLISH_M1_SELLER_ABSORPTION",
        confidence: "CLOSED_M1_M5_CONFIRMED",
        candle: "GREEN",
        ...common,
        absorption: {
          bottomBuy: Number(bottomBuy.toFixed(6)),
          bottomSell: Number(bottomSell.toFixed(6)),
          ratio: Number(
            (bottomSell / Math.max(bottomBuy, 0.000001)).toFixed(2)
          )
        },
        levels: {
          entry,
          stopLoss: Number(stopLoss.toFixed(2)),
          takeProfit: Number(takeProfit.toFixed(2)),
          risk: Number(risk.toFixed(2)),
          rr: TP_RR
        },
        reason:
          "Closed bullish M5 + closed green M1 rejection wick + negative delta + seller absorption + volume gate."
      };
    }

    let reason = "Closed M1/M5 conditions not aligned.";

    if (!volumeOk) {
      reason = "M1 absolute volume below MIN_M1_TOTAL_VOLUME.";
    } else if (
      red &&
      upperWickOk &&
      bearishDelta &&
      bearishAbsorption &&
      !m5Bearish
    ) {
      reason = "SELL blocked: latest closed M5 is not bearish.";
    } else if (
      green &&
      lowerWickOk &&
      bullishDelta &&
      bullishAbsorption &&
      !m5Bullish
    ) {
      reason = "BUY blocked: latest closed M5 is not bullish.";
    }

    return {
      signal: "WAIT",
      setup: "NONE",
      confidence: "NO_SETUP",
      ...common,
      absorption: {
        bearish: bearishAbsorption,
        bullish: bullishAbsorption,
        topBuy: Number(topBuy.toFixed(6)),
        topSell: Number(topSell.toFixed(6)),
        bottomBuy: Number(bottomBuy.toFixed(6)),
        bottomSell: Number(bottomSell.toFixed(6))
      },
      reason
    };
  }

  function authorized(req) {
    if (!EXECUTION_SECRET) return true;
    return String(req.headers["x-execution-secret"] || "") === EXECUTION_SECRET;
  }

  function buildExecutionSignal() {
    const diagnostic = calculateSignal();
    const executable =
      diagnostic.signal === "BUY" || diagnostic.signal === "SELL";

    const id =
      `${diagnostic.signal}_${diagnostic.m1Minute ?? state.closedM1?.minute ?? "NA"}_${diagnostic.m5Bucket ?? state.closedM5?.bucket ?? "NA"}`;

    const result = {
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
      liveFlow: {
        M1: state.currentCandle,
        M5: state.currentM5
      },
      levels: diagnostic.levels || null,
      diagnostic,
      executionRules: {
        entryCandle: "closed M1",
        confirmation: "latest closed M5 same direction",
        rr: TP_RR,
        minDeltaPercent: MIN_DELTA_PERCENT,
        absorptionRatio: ABSORPTION_RATIO,
        minM1TotalVolume: MIN_M1_TOTAL_VOLUME
      }
    };

    if (executable && id !== lastLoggedSignalKey) {
      lastLoggedSignalKey = id;
      console.log(
        "ORDERFLOW SIGNAL AUDIT",
        JSON.stringify({
          at: result.generatedAt,
          id,
          signal: result.signal,
          m1: diagnostic.m1Minute,
          m5: diagnostic.m5Bucket,
          deltaPercent: diagnostic.deltaPercent,
          absorption: diagnostic.absorption,
          volume: diagnostic.totalVolume,
          entry: diagnostic.levels?.entry,
          sl: diagnostic.levels?.stopLoss,
          tp: diagnostic.levels?.takeProfit
        })
      );
    }

    return result;
  }

  function connectBinance() {
    if (binanceWs) {
      try {
        binanceWs.removeAllListeners();
        binanceWs.close();
      } catch {}
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

    binanceWs.on("message", raw => {
      try {
        const parsed = JSON.parse(raw.toString());
        const message = parsed && parsed.data ? parsed.data : parsed;

        if (message && message.e === "aggTrade" && message.s === SYMBOL) {
          processTrade(message);
        }
      } catch (error) {
        state.lastError = `Message parse error: ${error.message}`;
        console.error(state.lastError);
      }
    });

    binanceWs.on("error", error => {
      state.lastError = `WebSocket error: ${error.message}`;
      console.error(state.lastError);
    });

    binanceWs.on("close", (code, reason) => {
      state.websocketConnected = false;
      console.log(
        "BINANCE WEBSOCKET CLOSED:",
        code,
        reason ? reason.toString() : ""
      );
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
      minute: c.minute,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      buyVolume: Number(c.buyVolume.toFixed(8)),
      sellVolume: Number(c.sellVolume.toFixed(8)),
      delta: Number(c.delta.toFixed(8)),
      trades: c.trades,
      lastClosedM1: state.closedM1,
      lastClosedM5: state.closedM5
    };
  }

  return {
    SYMBOL,
    BINANCE_WS_URL,
    DRY_RUN,
    state,
    calculateSignal,
    buildExecutionSignal,
    connectBinance,
    getCandleOutput,
    getFootprintLevels,
    authorized
  };
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
  res.status(x.success===false?500:200).json({
    ...x, lots:getDynamicLot("p78"), telegramEnabled:telegramEnabledByStrategy.p78,
    liquidAutoTrade:LIQUID_AUTO_TRADE, executionAllowed:LIQUID_AUTO_TRADE && !!x.executable
  });
});
app.get("/p78/status", (req,res) => res.json({
  success:true, strategy:"P78", status:"RUNNING", liquidAutoTrade:LIQUID_AUTO_TRADE,
  telegramEnabled:telegramEnabledByStrategy.p78, telegramConfigured:!!(TELEGRAM_BOT_TOKEN&&TELEGRAM_CHAT_ID),
  lastScanAt:lastScan?.generatedAt||null,lastSignalKey,lastTelegram,lastError,
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
   SECTION 7 — independent Telegram switches and compounding results
   ========================================================= */
app.post("/telegram/:strategy", auth, (req,res) => {
  const key=String(req.params.strategy||"").toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(telegramEnabledByStrategy,key)) {
    return res.status(400).json({success:false,error:"Use strategy5, p78, or orderflow."});
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
    res.json({success:true,...result,lotBook:lotBookOutput()});
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
             /start_orderflow /stop_orderflow /status_orderflow /status_all
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
        "/start_orderflow":["orderflow",true],"/stop_orderflow":["orderflow",false]
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
      } else if (command==="/status_all") {
        await sendTelegramRaw([
          `Strategy #5: ${telegramEnabledByStrategy.strategy5?"ON":"OFF"} | Lot ${getDynamicLot("strategy5")}`,
          `P78: ${telegramEnabledByStrategy.p78?"ON":"OFF"} | Lot ${getDynamicLot("p78")}`,
          `Order Flow: ${telegramEnabledByStrategy.orderflow?"ON":"OFF"} | Lot ${getDynamicLot("orderflow")}`
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
  success:true,service:"XAUUSD Three-Strategy Signal Server",port:PORT,
  strategies:["strategy5","p78","orderflow"],
  endpoints:[
    "/strategy5/decision","/strategy5/status","/p78/decision","/p78/status",
    "/orderflow/signal","/orderflow/execution-signal","/orderflow/status","/orderflow/footprint",
    "/telegram/status","POST /telegram/:strategy","POST /risk/:strategy/result","/risk/status","/health"
  ]
}));
app.get("/health", (req,res) => res.json({
  success:true,status:"ok",service:"XAUUSD Three-Strategy Signal Server",
  orderFlowWebSocketConnected:orderFlow.state.websocketConnected,
  orderFlowTicks:orderFlow.state.ticks,
  lastP78Error:lastError
}));

/* Independent periodic scans; a Telegram toggle only disables that strategy's messages. */
setTimeout(() => { scanStrategy5AndAlert(); scanAndAlert(); }, 20000);
setInterval(scanStrategy5AndAlert, 30000);
setInterval(scanAndAlert, 60000);
setInterval(scanOrderFlowAndAlert, 5000);
setInterval(pollTelegramCommands, 4000);

app.listen(PORT,"0.0.0.0",() => {
  console.log(`XAUUSD Three-Strategy Server listening on ${PORT}`);
  console.log(`Order Flow Binance stream: ${orderFlow.BINANCE_WS_URL}`);
  orderFlow.connectBinance();
});

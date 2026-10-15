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
const CACHE_MS=3000;
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
      const durationMs=interval==="1h"?60*60*1000:interval==="15min"?15*60*1000:5*60*1000;
      // Drop any still-forming candle so signals use closed candles only.
      const now=Date.now();
      const d=normalize(j.values).filter(c=>new Date(c.time).getTime()+durationMs<=now);
      if(d.length<100)throw new Error("Insufficient CLOSED candles from Twelve Data");
      CACHE.set(key,{t:Date.now(),d});return d;
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
const consumedP78Signals = new Set();

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
    const rt=retestHeld(c5,k,s.Direction,s.Price,atr);
    // A signal is actionable only when the retest-hold candle is the latest CLOSED 5M candle.
    // Historical retests are not allowed to become fresh trades after startup/restart.
    if(!rt.held || rt.index !== c5.length-1)continue;
    const risk=atr[k]*0.50,entry=s.Price;
    const sl=s.Direction==="BUY"?entry-risk:entry+risk;
    const tp=s.Direction==="BUY"?entry+risk*2.50:entry-risk*2.50;
    candidates.push({signal:s,k,entry,sl,tp,risk,score:mtf.score,mtfBreakdown:mtf.mtfBreakdown,strength:cs,retest:rt,retestTime:c5[rt.index].time,trendlineSource:"EXACT P78 BACKTEST ENGINE"});
  }
  candidates.sort((a,b)=>b.retest.index-a.retest.index);const x=candidates[0]||null;const current=last(c5)?.close??null;
  if(x){x.entry=current;x.sl=x.signal.Direction==="BUY"?current-x.risk:current+x.risk;x.tp=x.signal.Direction==="BUY"?current+x.risk*2.50:current-x.risk*2.50;}
  const signalKey=x?[x.signal.Direction,x.retestTime,round(x.entry),round(x.sl),round(x.tp)].join("|"):null;
  const signalConsumed=!!signalKey && consumedP78Signals.has(signalKey);
  const executable=!!x && !signalConsumed;
  return{success:true,strategy:"P78",strategyName:"XAUUSD P78 — Exact Backtested Strategy",instrument:OUTPUT_SYMBOL,executionTimeframe:"5M",contextTimeframes:["1H","15M"],generatedAt:new Date().toISOString(),currentPrice:current,status:signalConsumed?"CONSUMED":(executable?"CONFIRMED":"WAITING"),executable,signalKey,signalConsumed,signal:x?{direction:x.signal.Direction,status:signalConsumed?"CONSUMED":"P78 CONFIRMED",score:x.score,maxScore:6,signalIndex:x.retest.index,signalTime:x.retestTime,candleStrength:x.strength.strength}: {direction:null,status:"WAITING",score:0,maxScore:6,signalTime:null},mtfBreakdown:x?.mtfBreakdown||null,tradeLevels:x?{entry:round(x.entry),stopLoss:round(x.sl),takeProfit:round(x.tp),risk:round(x.risk),rr:"1:2.50"}:null,components:x?{candleStrength:x.strength,mtfScore:x.score,mtfBreakdown:x.mtfBreakdown,retestHeld:x.retest,trendline:x.signal,continuation:"NOT USED"}:null,backtest:{trades:354,wins:277,losses:77,winRate:78.25,netR:255.40},note:"P78 = CandleStrength != Weak + MTF_Score >= 5 + RetestHeld. Only the latest closed retest-confirmation candle is executable; historical signals are not re-fired. Future 25-candle Continuation condition is NOT USED."};
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
   SECTION 3 — ORDER FLOW STRATEGY (isolated state)
   Original delta / wick / absorption signal rules preserved.
   ========================================================= */
const orderFlow = (() => {
const SYMBOL = "XAUUSDT";
const BINANCE_WS_URL = "wss://fstream.binance.com/ws/xauusdt@aggTrade";

// Execution hand-off configuration.
// The server never places a broker order by itself. It exposes a deterministic
// signal endpoint for Liquid Chart / an execution bridge to consume.
const DRY_RUN = String(process.env.DRY_RUN ?? String(!LIQUID_AUTO_TRADE)).toLowerCase() === "true";
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
    autoTrade: LIQUID_AUTO_TRADE,
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
  res.status(x.success===false?500:200).json({
    ...x, lots:getDynamicLot("p78"), telegramEnabled:telegramEnabledByStrategy.p78,
    liquidAutoTrade:LIQUID_AUTO_TRADE, executionAllowed:LIQUID_AUTO_TRADE && !!x.executable
  });
});

// One-time reservation endpoint used by the Liquid Chart P78 executor.
app.post("/p78/consume", auth, async (req,res) => {
  try {
    const requestedKey=String(req.body?.signalKey||"");
    if(!requestedKey) return res.status(400).json({success:false,reservation:{accepted:false,reason:"signalKey is required"}});
    const x=await p78Scan();
    if(!x.executable || x.signalKey!==requestedKey) {
      return res.json({success:true,reservation:{accepted:false,reason:"Signal is no longer executable or signalKey does not match"}});
    }
    if(consumedP78Signals.has(requestedKey)) {
      return res.json({success:true,reservation:{accepted:false,reason:"Signal already consumed",signalKey:requestedKey}});
    }
    consumedP78Signals.add(requestedKey);
    return res.json({success:true,reservation:{accepted:true,signalKey:requestedKey}});
  } catch(e) {
    return res.status(500).json({success:false,reservation:{accepted:false,reason:e.message}});
  }
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
   SECTION 8B — MASTER PATTERN SIGNAL ENGINE
   Only the selected profitable candlestick patterns plus Hammer are enabled.
   All other candlestick patterns are filtered out. Chart/structure modules
   remain unchanged. Uses closed candles and existing separate strategy routes.
   ========================================================= */
const MASTER_ALLOWED_CANDLE_IDS = new Set([
  // Previously identified profitable setups
  'CANDLE_HANGING_MAN',
  'CANDLE_TWEEZER_TOP',
  'CANDLE_SPINNING_TOP_BEAR_BREAK',
  'CANDLE_BEARISH_ENGULFING',
  'CANDLE_EVENING_DOJI_STAR',
  'CANDLE_EVENING_STAR',
  'CANDLE_DARK_CLOUD_COVER',
  'CANDLE_DOJI_CONTINUATION_BEAR',
  'CANDLE_ABANDONED_BABY_BEAR',
  'CANDLE_DOWNSIDE_TASUKI_GAP',
  // Additional positive candlestick families from the saved RR2 results
  'CANDLE_THREE_BLACK_CROWS',
  'CANDLE_OUTSIDE_BAR_BEAR',
  'CANDLE_OUTSIDE_BAR_BULL',
  'CANDLE_SPINNING_TOP_BULL_BREAK',
  'CANDLE_BULLISH_MARUBOZU',
  'CANDLE_BEARISH_MARUBOZU',
  'CANDLE_INVERTED_HAMMER',
  'CANDLE_MORNING_STAR',
  'CANDLE_THREE_WHITE_SOLDIERS',
  'CANDLE_SHOOTING_STAR',
  'CANDLE_PIERCING_LINE',
  'CANDLE_DOJI_BULLISH_CONFIRM',
  'CANDLE_DOJI_BEARISH_CONFIRM',
  'CANDLE_INSIDE_BAR_BULL_BREAK',
  'CANDLE_INSIDE_BAR_BEAR_BREAK',
  // Hammer is the one additional exception requested
  'CANDLE_HAMMER'
]);

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
function mRRFor(id){
 const s=String(id||'').toUpperCase();
 if(s.includes('ORB'))return 2.0;
 // Reversal chart formations use 1:2.5; continuation formations use 1:3.
 if(/^CHART_/.test(s)&&/(DOUBLE_TOP|DOUBLE_BOTTOM|TRIPLE_TOP|TRIPLE_BOTTOM|HEAD_SHOULDERS|INVERSE_HEAD_SHOULDERS|ROUNDING_TOP|ROUNDING_BOTTOM)/.test(s))return 2.5;
 // Liquidity, OB, mitigation and FVG setups use the zone-based 1:2 plan.
 if(/LIQUIDITY|SWEEP|INDUCEMENT|ORDER_BLOCK|MITIGATION_BLOCK|BREAKER_BLOCK|FVG|FAIR_VALUE_GAP|IMBALANCE|DEMAND_RECLAIM|SUPPLY_REJECT/.test(s))return 2.0;
 // Candlestick continuation families get 1:3; remaining candle patterns are reversals at 1:2.
 if(/^CANDLE_/.test(s)){
   if(/THREE_WHITE_SOLDIERS|THREE_BLACK_CROWS|RISING_THREE_METHODS|FALLING_THREE_METHODS|MAT_HOLD|TASUKI_GAP|THREE_LINE_STRIKE|MARUBOZU|INSIDE_BAR_.*BREAK|OUTSIDE_BAR_.*BREAK|SPINNING_TOP_.*BREAK/.test(s))return 3.0;
   return 2.0;
 }
 if(/^CHART_/.test(s))return 3.0;
 // Market structure and trend-following setups use 1:3.
 return 3.0;
}
function mRiskRuleFor(id){
 const s=String(id||'').toUpperCase();
 if(s.includes('ORB'))return 'SL beyond opposite opening-range boundary; TP by 1:2 RR';
 if(/^CANDLE_/.test(s))return 'SL beyond pattern candle(s) extreme + ATR buffer; TP by family RR';
 if(/^CHART_/.test(s)&&/(DOUBLE_TOP|DOUBLE_BOTTOM|TRIPLE_TOP|TRIPLE_BOTTOM|HEAD_SHOULDERS|INVERSE_HEAD_SHOULDERS)/.test(s))return 'SL beyond pattern shoulder/peak/trough; TP by 1:2.5 RR';
 if(/LIQUIDITY|SWEEP|INDUCEMENT|ORDER_BLOCK|MITIGATION_BLOCK|BREAKER_BLOCK|FVG|FAIR_VALUE_GAP|IMBALANCE/.test(s))return 'SL beyond zone/sweep invalidation + ATR buffer; TP by 1:2 RR';
 if(/^CHART_/.test(s))return 'SL beyond pattern structure/signal extreme; TP by 1:3 RR';
 return 'SL beyond confirmed swing/structure invalidation; TP by 1:3 RR';
}
function mEmit(out,id,side,c,atr,reason,slOverride=null){
  // Only the selected profitable candlestick setups are allowed through.
  if (String(id).startsWith('CANDLE_') && !MASTER_ALLOWED_CANDLE_IDS.has(id)) return;
  const x=last(c); if(!x||!atr||atr<=0||c.length<25)return;
  const entry=x.close;
  // Avoid entries on weak close-only pokes; breakout candles need meaningful body and close near the extreme.
  const body=mBody(x),range=mRange(x),upper=mUpper(x),lower=mLower(x);
  const isBreak=/BREAK|BOS|CHOCH|OUTSIDE|THREE_LINE_STRIKE|MOMENTUM|ORB|PENNANT|FLAG|TRIANGLE|RECTANGLE|CUP_HANDLE|HEAD_SHOULDERS|DOUBLE_TOP|DOUBLE_BOTTOM|TRIPLE_TOP|TRIPLE_BOTTOM|FVG_RETEST|ORDER_BLOCK_BREAK|DEMAND_RECLAIM|SUPPLY_REJECT|MITIGATION_BLOCK|INDUCEMENT/.test(id);
  if(isBreak && body<atr*.12)return;
  if(isBreak && side==='BUY' && x.close < x.low+range*.55)return;
  if(isBreak && side==='SELL' && x.close > x.high-range*.55)return;
  // Reversal patterns need a location: within 1.25 ATR of a previously confirmed swing or a sweep of that level.
  const reversal=/CANDLE_(HAMMER|INVERTED_HAMMER|HANGING_MAN|SHOOTING_STAR|PIN_BAR|DRAGONFLY|GRAVESTONE|BULLISH_ENGULFING|BEARISH_ENGULFING|MORNING_STAR|EVENING_STAR|HARAMI|PIERCING_LINE|DARK_CLOUD_COVER|TWEEZER|ABANDONED_BABY|COUNTERATTACK|MATCHING_LOW|MATCHING_HIGH|HOMING_PIGEON|STICK_SANDWICH)/.test(id);
  if(reversal){
    const hist=c.slice(0,-1),piv=mPivots(hist,3,3),sh=last(piv.highs),sl=last(piv.lows);
    const nearLow=!!(sl&&Math.abs(x.low-sl.p)<=atr*1.25);
    const nearHigh=!!(sh&&Math.abs(x.high-sh.p)<=atr*1.25);
    const sweptLow=!!(sl&&x.low<sl.p&&x.close>sl.p);
    const sweptHigh=!!(sh&&x.high>sh.p&&x.close<sh.p);
    if(side==='BUY'&&!nearLow&&!sweptLow)return;
    if(side==='SELL'&&!nearHigh&&!sweptHigh)return;
  }
  const recent3=c.slice(-3),recent10=c.slice(-10),recent40=c.slice(-40);
  const fallback=side==='BUY'?mMin(recent3.map(z=>z.low))-atr*.1:mMax(recent3.map(z=>z.high))+atr*.1;
  let sl=Number.isFinite(slOverride)?slOverride:fallback;
  // Setup-specific invalidation levels rather than one universal SL.
  if(/ORB/.test(id)){
    const day=String(x.time||'').slice(0,10),today=c.filter(z=>String(z.time||'').slice(0,10)===day);
    if(today.length>=3){const opening=today.slice(0,3);sl=side==='BUY'?mMin(opening.map(z=>z.low))-atr*.1:mMax(opening.map(z=>z.high))+atr*.1;}
  } else if(/^CHART_/.test(id)&&/(DOUBLE_TOP|DOUBLE_BOTTOM|TRIPLE_TOP|TRIPLE_BOTTOM|HEAD_SHOULDERS|INVERSE_HEAD_SHOULDERS|ROUNDING_TOP|ROUNDING_BOTTOM)/.test(id)){
    sl=side==='BUY'?mMin(recent40.map(z=>z.low))-atr*.1:mMax(recent40.map(z=>z.high))+atr*.1;
  } else if(!Number.isFinite(slOverride)&&/LIQUIDITY|SWEEP|INDUCEMENT|ORDER_BLOCK|MITIGATION_BLOCK|BREAKER_BLOCK|FVG|FAIR_VALUE_GAP|IMBALANCE/.test(id)){
    sl=side==='BUY'?mMin(recent10.map(z=>z.low))-atr*.1:mMax(recent10.map(z=>z.high))+atr*.1;
  } else if(!Number.isFinite(slOverride)&&/^CHART_/.test(id)){
    const formation=c.slice(-12,-1);
    if(formation.length){sl=side==='BUY'?mMin(formation.map(z=>z.low))-atr*.1:mMax(formation.map(z=>z.high))+atr*.1;}
  }
  // Always keep SL beyond the signal candle extreme with a small volatility buffer.
  if(side==='BUY')sl=Math.min(sl,x.low-atr*.05);else sl=Math.max(sl,x.high+atr*.05);
  const risk=Math.abs(entry-sl);
  if(!Number.isFinite(risk)||risk<atr*.15||risk>atr*5)return;
  const rr=mRRFor(id);
  const tp=side==='BUY'?entry+risk*rr:entry-risk*rr;
  const key=[id,side,x.time,round(entry,3)].join('|');
  if(MASTER_IDS.has(key))return;
  out.push({setupId:id,signalKey:key,strategy:id,direction:side,signal:side,executable:true,executionAllowed:true,
    candleTime:x.time,entry:round(entry),sl:round(sl),tp:round(tp),rr,rrText:'1:'+rr,reason,
    stopRule:mRiskRuleFor(id),takeProfitRule:'Entry-to-SL risk multiplied by '+rr,
    trailingRule:'At +1R move SL to breakeven; then each additional +0.5R locks another +0.5R',
    confirmation:{closedCandle:true,breakoutClose:isBreak,locationRequired:reversal,slBeyondSignalExtreme:true,rr}});
}

function mDetectCandles(c,atr,out){
 if(c.length<5||!atr)return;
 const n=c.length,x=c[n-1],b=c[n-2],a=c[n-3],p=c[n-4],q=c[n-5];
 const body=mBody(x),range=mRange(x),up=mUpper(x),dn=mLower(x);
 const ema20=mEmaLast(c.slice(0,-1),20);
 const downContext=ema20!==null&&b.close<ema20;
 const upContext=ema20!==null&&b.close>ema20;
 const doji=body<=range*.10, small=body<=range*.30;

 // One-candle reversal candidates use the previous candle; the latest CLOSED candle must confirm by breaking its extreme.
 const cb=mBody(b),cr=mRange(b),cu=mUpper(b),cd=mLower(b);
 const priorEma=mEmaLast(c.slice(0,-2),20);
 const priorDown=priorEma!==null&&a.close<priorEma;
 const priorUp=priorEma!==null&&a.close>priorEma;
 if(cd>=Math.max(cb*2,cr*.45)&&cu<=cr*.2&&cb<=cr*.4&&priorDown&&mBull(x)&&x.close>b.high)
   mEmit(out,'CANDLE_HAMMER','BUY',c,atr,'Hammer candidate after bearish context; confirmed only by next closed candle breaking hammer high');
 if(cu>=Math.max(cb*2,cr*.45)&&cd<=cr*.2&&cb<=cr*.4&&priorDown&&mBull(x)&&x.close>b.high)
   mEmit(out,'CANDLE_INVERTED_HAMMER','BUY',c,atr,'Inverted-hammer candidate after bearish context; next closed candle breaks high');
 if(cd>=Math.max(cb*2,cr*.45)&&cu<=cr*.2&&cb<=cr*.4&&priorUp&&mBear(x)&&x.close<b.low)
   mEmit(out,'CANDLE_HANGING_MAN','SELL',c,atr,'Hanging-man candidate after bullish context; next closed candle breaks low');
 if(cu>=Math.max(cb*2,cr*.45)&&cd<=cr*.2&&cb<=cr*.4&&priorUp&&mBear(x)&&x.close<b.low)
   mEmit(out,'CANDLE_SHOOTING_STAR','SELL',c,atr,'Shooting-star candidate after bullish context; next closed candle breaks low');
 if(cd>=cr*.60&&cu<=cr*.15&&priorDown&&mBull(x)&&x.close>b.high)
   mEmit(out,'CANDLE_BULLISH_PIN_BAR','BUY',c,atr,'Pin-bar candidate at bearish context; confirmed by close above candidate high');
 if(cu>=cr*.60&&cd<=cr*.15&&priorUp&&mBear(x)&&x.close<b.low)
   mEmit(out,'CANDLE_BEARISH_PIN_BAR','SELL',c,atr,'Pin-bar candidate at bullish context; confirmed by close below candidate low');
 if(body>=range*.85&&mBull(x))mEmit(out,'CANDLE_BULLISH_MARUBOZU','BUY',c,atr,'Bull body >=85% of range');
 if(body>=range*.85&&mBear(x))mEmit(out,'CANDLE_BEARISH_MARUBOZU','SELL',c,atr,'Bear body >=85% of range');
 if(small&&up>=range*.2&&dn>=range*.2){
   if(x.close>b.high)mEmit(out,'CANDLE_SPINNING_TOP_BULL_BREAK','BUY',c,atr,'Small body with two wicks, then close above prior high');
   if(x.close<b.low)mEmit(out,'CANDLE_SPINNING_TOP_BEAR_BREAK','SELL',c,atr,'Small body with two wicks, then close below prior low');
 }
 if(mBody(b)<=mRange(b)*.10){
   if(downContext&&mBull(x)&&x.close>b.high)mEmit(out,'CANDLE_DOJI_BULLISH_CONFIRM','BUY',c,atr,'Prior Doji after bearish context; current close breaks Doji high');
   if(upContext&&mBear(x)&&x.close<b.low)mEmit(out,'CANDLE_DOJI_BEARISH_CONFIRM','SELL',c,atr,'Prior Doji after bullish context; current close breaks Doji low');
   if(mLower(b)>=mRange(b)*.6&&mUpper(b)<=mRange(b)*.1&&mBull(x)&&x.close>b.high)mEmit(out,'CANDLE_DRAGONFLY_DOJI','BUY',c,atr,'Dragonfly Doji geometry followed by close above its high');
   if(mUpper(b)>=mRange(b)*.6&&mLower(b)<=mRange(b)*.1&&mBear(x)&&x.close<b.low)mEmit(out,'CANDLE_GRAVESTONE_DOJI','SELL',c,atr,'Gravestone Doji geometry followed by close below its low');
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
 // More classical candle families. Gap-dependent names are emitted only when the feed has a real gap.
 // Long-legged Doji / high-wave: neutral candle, trade only after range breakout.
 if(mBody(b)<=mRange(b)*.10&&mUpper(b)>=mRange(b)*.30&&mLower(b)>=mRange(b)*.30&&x.close>b.high)
   mEmit(out,'CANDLE_LONG_LEGGED_DOJI_BULL_BREAK','BUY',c,atr,'Long-legged Doji range broken by a closed bullish candle');
 if(mBody(b)<=mRange(b)*.10&&mUpper(b)>=mRange(b)*.30&&mLower(b)>=mRange(b)*.30&&x.close<b.low)
   mEmit(out,'CANDLE_LONG_LEGGED_DOJI_BEAR_BREAK','SELL',c,atr,'Long-legged Doji range broken by a closed bearish candle');
 if(mRange(b)>0&&mBody(b)<=mRange(b)*.25&&mUpper(b)>=mRange(b)*.35&&mLower(b)>=mRange(b)*.35&&x.close>b.high)
   mEmit(out,'CANDLE_HIGH_WAVE_BULL_BREAK','BUY',c,atr,'High-wave indecision followed by close above its high');
 if(mRange(b)>0&&mBody(b)<=mRange(b)*.25&&mUpper(b)>=mRange(b)*.35&&mLower(b)>=mRange(b)*.35&&x.close<b.low)
   mEmit(out,'CANDLE_HIGH_WAVE_BEAR_BREAK','SELL',c,atr,'High-wave indecision followed by close below its low');
 // Counterattack lines: strong opposite candle closes near prior close, then next candle breaks trigger range.
 if(mBear(a)&&mBull(b)&&mNear(b.close,a.close,atr*.12)&&x.close>b.high&&mBull(x))
   mEmit(out,'CANDLE_BULLISH_COUNTERATTACK','BUY',c,atr,'Near-equal closing counterattack followed by bullish range break');
 if(mBull(a)&&mBear(b)&&mNear(b.close,a.close,atr*.12)&&x.close<b.low&&mBear(x))
   mEmit(out,'CANDLE_BEARISH_COUNTERATTACK','SELL',c,atr,'Near-equal closing counterattack followed by bearish range break');
 // Matching lows/highs need the following candle to break the pair's trigger.
 if(mBear(a)&&mBear(b)&&mNear(a.low,b.low,atr*.10)&&mBull(x)&&x.close>b.high)
   mEmit(out,'CANDLE_MATCHING_LOW_CONFIRM','BUY',c,atr,'Matching lows then close above second candle high');
 if(mBull(a)&&mBull(b)&&mNear(a.high,b.high,atr*.10)&&mBear(x)&&x.close<b.low)
   mEmit(out,'CANDLE_MATCHING_HIGH_CONFIRM','SELL',c,atr,'Matching highs then close below second candle low');
 // Homing pigeon / stick sandwich: require the pattern plus breakout confirmation.
 if(mBear(a)&&mBear(b)&&b.open<a.open&&b.close>a.close&&x.close>a.high&&mBull(x))
   mEmit(out,'CANDLE_HOMING_PIGEON_CONFIRM','BUY',c,atr,'Small bearish body inside prior bearish body then bullish break');
 if(mBear(a)&&mBull(b)&&mBear(x)&&mNear(a.close,x.close,atr*.12)&&b.close>a.high)
   mEmit(out,'CANDLE_STICK_SANDWICH','BUY',c,atr,'Bear-bull-bear closes near equal lows with bullish recovery condition');
 // Separating lines and thrusting/in-neck/on-neck: require a subsequent range break.
 if(mBear(a)&&mBull(b)&&mNear(a.open,b.open,atr*.10)&&x.close>b.high)
   mEmit(out,'CANDLE_BULLISH_SEPARATING_LINES','BUY',c,atr,'Similar opens then bullish continuation break');
 if(mBull(a)&&mBear(b)&&mNear(a.open,b.open,atr*.10)&&x.close<b.low)
   mEmit(out,'CANDLE_BEARISH_SEPARATING_LINES','SELL',c,atr,'Similar opens then bearish continuation break');
 if(mBear(b)&&mBull(x)&&x.open<b.low&&x.close> b.close&&x.close<mMid(b))
   mEmit(out,'CANDLE_THRUSTING_LINE','BUY',c,atr,'Bull close penetrates prior bear body but not midpoint; informational low-confidence setup');
 // Three-line strike: three candles trend, then opposite candle fully engulfs the three-candle body range.
 if(c.length>=4){const z=c.slice(-4);if(z[0].close>z[0].open&&z[1].close>z[1].open&&z[2].close>z[2].open&&mBear(x)&&x.open>z[2].close&&x.close<z[0].open&&x.close<z[1].open&&x.close<z[2].open)mEmit(out,'CANDLE_BEARISH_THREE_LINE_STRIKE','SELL',c,atr,'Bearish strike engulfs prior three bullish bodies');if(z[0].close<z[0].open&&z[1].close<z[1].open&&z[2].close<z[2].open&&mBull(x)&&x.open<z[2].close&&x.close>z[0].open&&x.close>z[1].open&&x.close>z[2].open)mEmit(out,'CANDLE_BULLISH_THREE_LINE_STRIKE','BUY',c,atr,'Bullish strike engulfs prior three bearish bodies');}
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
 // FVG is NOT an entry by itself: require a previously formed gap to be revisited and rejected on a closed candle.
 for(let j=Math.max(0,c.length-20);j<c.length-3;j++){
   const left=c[j],middle=c[j+1],right=c[j+2];
   if(left.high<right.low){const zlo=left.high,zhi=right.low;if(x.low<=zhi&&x.high>=zlo&&mBull(x)&&x.close>zhi&&x.close>middle.close){mEmit(out,'STRUCTURE_BULLISH_FVG_RETEST','BUY',c,atr,'Previously formed bullish FVG retested; closed bullish rejection above gap');break;}}
   if(left.low>right.high){const zlo=right.high,zhi=left.low;if(x.high>=zlo&&x.low<=zhi&&mBear(x)&&x.close<zlo&&x.close<middle.close){mEmit(out,'STRUCTURE_BEARISH_FVG_RETEST','SELL',c,atr,'Previously formed bearish FVG retested; closed bearish rejection below gap');break;}}
 }
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
 // Pivot-based double/triple tops/bottoms and H&S: the neckline must break on a closed candle.
 const {highs,lows}=mPivots(c,3,3),tol=atr*.35;
 function rangeMin(from,to){const a=c.slice(from+1,to);return a.length?mMin(a.map(z=>z.low)):null;}
 function rangeMax(from,to){const a=c.slice(from+1,to);return a.length?mMax(a.map(z=>z.high)):null;}
 if(highs.length>=2){const z=highs.slice(-2),neck=rangeMin(z[0].i,z[1].i);if(neck!==null&&mNear(z[0].p,z[1].p,tol)&&p.close>=neck&&x.close<neck)mEmit(out,'CHART_DOUBLE_TOP','SELL',c,atr,'Two similar confirmed peaks; neckline between peaks broken by closed candle',neck+atr*.1);}
 if(lows.length>=2){const z=lows.slice(-2),neck=rangeMax(z[0].i,z[1].i);if(neck!==null&&mNear(z[0].p,z[1].p,tol)&&p.close<=neck&&x.close>neck)mEmit(out,'CHART_DOUBLE_BOTTOM','BUY',c,atr,'Two similar confirmed troughs; neckline between troughs broken by closed candle',neck-atr*.1);}
 if(highs.length>=3){const z=highs.slice(-3),neck1=rangeMin(z[0].i,z[1].i),neck2=rangeMin(z[1].i,z[2].i);if(neck1!==null&&neck2!==null&&mNear(z[0].p,z[1].p,tol)&&mNear(z[1].p,z[2].p,tol)&&p.close>=Math.min(neck1,neck2)&&x.close<Math.min(neck1,neck2))mEmit(out,'CHART_TRIPLE_TOP','SELL',c,atr,'Three similar confirmed peaks; support neckline broken on close',Math.min(neck1,neck2)+atr*.1);
   if(z[1].p>z[0].p&&z[1].p>z[2].p&&mNear(z[0].p,z[2].p,tol)&&neck1!==null&&neck2!==null){const neck=Math.min(neck1,neck2);if(p.close>=neck&&x.close<neck)mEmit(out,'CHART_HEAD_SHOULDERS','SELL',c,atr,'Confirmed left shoulder, higher head, similar right shoulder; neckline close-break',neck+atr*.1);}}
 if(lows.length>=3){const z=lows.slice(-3),neck1=rangeMax(z[0].i,z[1].i),neck2=rangeMax(z[1].i,z[2].i);if(neck1!==null&&neck2!==null&&mNear(z[0].p,z[1].p,tol)&&mNear(z[1].p,z[2].p,tol)&&p.close<=Math.max(neck1,neck2)&&x.close>Math.max(neck1,neck2))mEmit(out,'CHART_TRIPLE_BOTTOM','BUY',c,atr,'Three similar confirmed troughs; resistance neckline broken on close',Math.max(neck1,neck2)-atr*.1);
   if(z[1].p<z[0].p&&z[1].p<z[2].p&&mNear(z[0].p,z[2].p,tol)&&neck1!==null&&neck2!==null){const neck=Math.max(neck1,neck2);if(p.close<=neck&&x.close>neck)mEmit(out,'CHART_INVERSE_HEAD_SHOULDERS','BUY',c,atr,'Confirmed inverse head-and-shoulders; neckline close-break',neck-atr*.1);}}
 // Separate ascending/descending/symmetrical triangle candidates from six-bar compression.
 const flatTol=atr*.30;
 if(mNear(h1,h2,flatTol)&&l2>l1&&x.close>h1)mEmit(out,'CHART_ASCENDING_TRIANGLE_BULL','BUY',c,atr,'Near-flat resistance with rising lows and close breakout');
 if(mNear(l1,l2,flatTol)&&h2<h1&&x.close<l1)mEmit(out,'CHART_DESCENDING_TRIANGLE_BEAR','SELL',c,atr,'Near-flat support with falling highs and close breakdown');
 if(h2<h1&&l2>l1&&x.close>h1)mEmit(out,'CHART_SYMMETRICAL_TRIANGLE_BULL','BUY',c,atr,'Lower highs and higher lows then upside breakout');
 if(h2<h1&&l2>l1&&x.close<l1)mEmit(out,'CHART_SYMMETRICAL_TRIANGLE_BEAR','SELL',c,atr,'Lower highs and higher lows then downside breakdown');
 // Pennant candidates require an impulse then a contracting consolidation.
 if(impulse.close-impulse.open>atr*1.5&&h2<h1&&l2>l1&&x.close>h1)mEmit(out,'CHART_BULL_PENNANT','BUY',c,atr,'Bull impulse then contracting pennant breakout');
 if(impulse.open-impulse.close>atr*1.5&&h2<h1&&l2>l1&&x.close<l1)mEmit(out,'CHART_BEAR_PENNANT','SELL',c,atr,'Bear impulse then contracting pennant breakdown');
 // Cup-and-handle and inverse cup-and-handle: rounded rim similarity, deep cup, shallow handle, then closed breakout.
 const cup=c.slice(-28,-1);
 if(cup.length===27){
   const leftRim=cup.slice(0,5),middle=cup.slice(8,20),rightRim=cup.slice(21,27),handle=c.slice(-6,-1);
   const leftAvg=leftRim.reduce((s,z)=>s+z.close,0)/leftRim.length,rightAvg=rightRim.reduce((s,z)=>s+z.close,0)/rightRim.length;
   const cupLow=mMin(middle.map(z=>z.low)),cupHigh=mMax(middle.map(z=>z.high));
   const handleHigh=mMax(handle.map(z=>z.high)),handleLow=mMin(handle.map(z=>z.low));
   const rimTol=atr*1.2;
   if(mNear(leftAvg,rightAvg,rimTol)&&cupLow<Math.min(leftAvg,rightAvg)-atr*1.5&&handleLow>cupLow+atr*.5&&x.close>handleHigh&&x.close>rightAvg)
     mEmit(out,'CHART_CUP_HANDLE','BUY',c,atr,'Rounded cup with similar rims, shallow handle and closed upside breakout');
   if(mNear(leftAvg,rightAvg,rimTol)&&cupHigh>Math.max(leftAvg,rightAvg)+atr*1.5&&handleHigh<cupHigh-atr*.5&&x.close<handleLow&&x.close<rightAvg)
     mEmit(out,'CHART_INVERSE_CUP_HANDLE','SELL',c,atr,'Rounded inverse cup with similar rims, shallow handle and closed downside breakdown');
 }
 // ORB: use first 15-minute-equivalent range of the UTC day on 5m bars.
 const day=x.time?String(x.time).slice(0,10):'';const todays=c.filter(z=>String(z.time).slice(0,10)===day);if(todays.length>=4){const opening=todays.slice(0,3),oh=mMax(opening.map(z=>z.high)),ol=mMin(opening.map(z=>z.low));if(todays.length>3&&x.close>oh&&p.close<=oh)mEmit(out,'CHART_ORB_BULL_BREAK','BUY',c,atr,'Close above first three 5m candles of UTC day');if(todays.length>3&&x.close<ol&&p.close>=ol)mEmit(out,'CHART_ORB_BEAR_BREAK','SELL',c,atr,'Close below first three 5m candles of UTC day');}
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
   confirmationPolicy:{closedCandlesOnly:true,reversalNeedsConfirmedLocation:true,breakoutsNeedStrongClose:true,slBeyondSignalExtreme:true,complexChartPatternsAreHeuristic:true},
   executable:setups.length>0,executionAllowed:LIQUID_AUTO_TRADE&&setups.length>0,signal:setups.length?'MULTIPLE_SETUPS':'WAIT',setups,
   rrPolicy:{candlestickReversal:'1:2',candlestickContinuation:'1:3',chartReversal:'1:2.5',chartContinuation:'1:3',orb:'1:2',liquidityOrderBlockFVG:'1:2',marketStructureTrend:'1:3'},
   trailingPolicy:'At +1R SL to breakeven; thereafter each +0.5R in open profit advances SL by +0.5R',
   note:'Independent heuristic setup modules; all signals use closed candles. Complex chart formations are approximations and require backtesting before live use.'};
}


app.get('/master/decision', auth, async (req,res) => {
  try {
    res.json(await masterScan());
  } catch (e) {
    masterLastError = e.message;
    res.status(503).json({success:false,strategy:'MASTER_XAUUSD',instrument:OUTPUT_SYMBOL,
      executable:false,executionAllowed:false,signal:'WAIT',setups:[],error:e.message});
  }
});
app.get('/master/status', (req,res) => res.json({success:true,strategy:'MASTER_XAUUSD',
  status:'RUNNING',lastScan:masterLastScan,lastError:masterLastError,
  allowedCandlestickPatterns:[...MASTER_ALLOWED_CANDLE_IDS],
  note:'All other candlestick patterns filtered out; chart and market-structure detectors retained.'}));

/* =========================================================
   SECTION 9 — Common health/root routes and one server listener
   ========================================================= */
app.get("/", (req,res) => res.json({
  success:true,service:"XAUUSD Three-Strategy Signal Server",port:PORT,
  strategies:["strategy5","p78","orderflow","master"],
  endpoints:[
    "/strategy5/decision","/strategy5/status","/p78/decision","/p78/status",
    "/orderflow/signal","/orderflow/execution-signal","/orderflow/status","/orderflow/footprint",
    "/master/decision","/master/status",
    "/telegram/status","POST /telegram/:strategy","POST /risk/:strategy/result","/risk/status","/health"
  ]
}));
app.get("/health", (req,res) => res.json({
  success:true,status:"ok",service:"XAUUSD Three-Strategy Signal Server + Master Pattern Engine",
  masterPatternEngine:true,
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

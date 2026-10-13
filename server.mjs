
import express from "express";

const app = express();
app.use(express.json());
app.use((req,res,next)=>{
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type,X-HF-Secret");
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
let telegramEnabled=true;

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
  } else {
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

/* P78: original 3 conditions preserved */
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
  candidates.sort((a,b)=>b.k-a.k);const x=candidates[0]||null;const current=last(c5)?.close??null;
  if(x){x.entry=current;x.sl=x.signal.Direction==="BUY"?current-x.risk:current+x.risk;x.tp=x.signal.Direction==="BUY"?current+x.risk*2.50:current-x.risk*2.50;}
  return{success:true,strategy:"P78",strategyName:"XAUUSD P78 — Exact Backtested Strategy",instrument:OUTPUT_SYMBOL,executionTimeframe:"5M",contextTimeframes:["1H","15M"],generatedAt:new Date().toISOString(),currentPrice:current,status:x?"CONFIRMED":"WAITING",executable:!!x,signal:x?{direction:x.signal.Direction,status:"P78 CONFIRMED",score:x.score,maxScore:6,signalIndex:x.k,signalTime:x.signal.Time,candleStrength:x.strength.strength}:{direction:null,status:"WAITING",score:0,maxScore:6},mtfBreakdown:x?.mtfBreakdown||null,tradeLevels:x?{entry:round(x.entry),stopLoss:round(x.sl),takeProfit:round(x.tp),risk:round(x.risk),rr:"1:2.50"}:null,components:x?{candleStrength:x.strength,mtfScore:x.score,mtfBreakdown:x.mtfBreakdown,retestHeld:x.retest,trendline:x.signal,continuation:"NOT USED"}:null,backtest:{trades:354,wins:277,losses:77,winRate:78.25,netR:255.40},note:"P78 = CandleStrength != Weak + MTF_Score >= 5 + RetestHeld. Future 25-candle Continuation condition is NOT USED."};
}

function telegramText(x){
  const s=x.signal||{},l=x.tradeLevels||{};
  return [
    "━━━━━━━━━━━━━━━━━━━━",
    "🚨 XAUUSD P78 SIGNAL",
    "━━━━━━━━━━━━━━━━━━━━",
    `Direction: ${s.direction||"WAIT"}`,
    `Status: ${s.status||"WAITING"}`,
    `MTF Score: ${s.score??0}/6`,
    `Current: ${x.currentPrice??"N/A"}`,
    "",
    "TRADE LEVELS",
    `Entry: ${l.entry??"N/A"}`,
    `SL: ${l.stopLoss??"N/A"}`,
    `TP: ${l.takeProfit??"N/A"}`,
    "",
    "Conditions",
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
  if(!telegramEnabled||!TELEGRAM_BOT_TOKEN||!TELEGRAM_CHAT_ID)return{sent:false,reason:"Telegram disabled/not configured"};
  try{
    const r=await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:TELEGRAM_CHAT_ID,text:String(message)})});
    const j=await r.json();if(!r.ok||!j.ok)throw new Error(j.description||"Telegram failed");
    return{sent:true};
  }catch(e){return{sent:false,error:e.message};}
}

async function scanAndAlert(){
  try{
    const x=await p78Scan();lastScan=x;lastError=null;
    if(x.executable){
      const l=x.tradeLevels||{},key=[x.signal.direction,l.entry,l.stopLoss,l.takeProfit,x.signal.signalTime].join("|");
      if(key!==lastSignalKey){
        lastTelegram={...(await sendTelegram(telegramText(x))),attemptedAt:new Date().toISOString(),signalKey:key};
        if(lastTelegram.sent)lastSignalKey=key;
      }
    }
    return x;
  }catch(e){
    lastError=e.message;
    return{success:false,strategy:"P78",status:"ERROR",error:e.message};
  }
}

function auth(req,res,next){
  if(HF_SECRET&&String(req.headers["x-hf-secret"]||"")!==HF_SECRET)return res.status(401).json({success:false,error:"Unauthorized"});
  next();
}

/* =========================================================
   STRATEGY #5 — SUPPORT / RESISTANCE REJECTION
   Original rules preserved.
   ========================================================= */

function strategy5AtrSma(candles,period=14){
  const tr=candles.map((c,i)=>i===0?c.high-c.low:Math.max(c.high-c.low,Math.abs(c.high-candles[i-1].close),Math.abs(c.low-candles[i-1].close)));
  return candles.map((_,i)=>{
    if(i<period-1)return null;
    const slice=tr.slice(i-period+1,i+1);
    return slice.reduce((a,b)=>a+b,0)/period;
  });
}

function strategy5ScanCandles(candles){
  const n=candles.length;
  const atr=strategy5AtrSma(candles,14);
  let support=null,resistance=null;
  let supportTested=false,resistanceTested=false;
  let latestSignal=null;
  const left=3,right=3,toleranceAtr=0.25;

  for(let k=0;k<n;k++){
    const pivot=k-right;
    if(pivot>=left&&pivot+right<n){
      const ph=candles[pivot].high;
      const pl=candles[pivot].low;
      let isHigh=true,isLow=true;
      for(let j=pivot-left;j<pivot;j++){
        if(!(ph>candles[j].high))isHigh=false;
        if(!(pl<candles[j].low))isLow=false;
      }
      for(let j=pivot+1;j<=pivot+right;j++){
        if(!(ph>=candles[j].high))isHigh=false;
        if(!(pl<=candles[j].low))isLow=false;
      }
      if(isHigh){resistance=ph;resistanceTested=false;}
      if(isLow){support=pl;supportTested=false;}
    }

    if(k<14||!Number.isFinite(atr[k])||atr[k]<=0)continue;
    const c=candles[k],tol=atr[k]*toleranceAtr;

    if(support!==null&&!supportTested&&c.low<=support+tol&&c.close>support&&c.close>c.open){
      let entry=c.close,sl=c.low;
      if(entry-sl<atr[k])sl=entry-atr[k];
      const risk=entry-sl;
      latestSignal={index:k,time:c.time,direction:"BUY",entry,stopLoss:sl,takeProfit:entry+risk*2,support,resistance,rejection:"SUPPORT BULLISH REJECTION",atr:atr[k],risk};
      supportTested=true;
    }else if(resistance!==null&&!resistanceTested&&c.high>=resistance-tol&&c.close<resistance&&c.close<c.open){
      let entry=c.close,sl=c.high;
      if(sl-entry<atr[k])sl=entry+atr[k];
      const risk=sl-entry;
      latestSignal={index:k,time:c.time,direction:"SELL",entry,stopLoss:sl,takeProfit:entry-risk*2,support,resistance,rejection:"RESISTANCE BEARISH REJECTION",atr:atr[k],risk};
      resistanceTested=true;
    }
  }

  const lastIndex=n-1;
  const currentAtr=lastIndex>=0?atr[lastIndex]:null;
  const active=latestSignal&&latestSignal.index===lastIndex?latestSignal:null;

  return{
    success:true,
    strategy:"STRATEGY_5",
    strategyName:"XAUUSD Strategy #5 — Support / Resistance Rejection",
    instrument:OUTPUT_SYMBOL,
    executionTimeframe:"5M",
    generatedAt:new Date().toISOString(),
    currentPrice:last(candles)?.close??null,
    status:active?"CONFIRMED":"WAITING",
    executable:!!active,
    signal:active?{direction:active.direction,status:active.rejection,signalTime:active.time}:{direction:null,status:"WAITING",signalTime:null},
    tradeLevels:active?{entry:round(active.entry),stopLoss:round(active.stopLoss),takeProfit:round(active.takeProfit),risk:round(active.risk),rr:"1:2"}:null,
    components:{
      support:support===null?null:round(support),
      resistance:resistance===null?null:round(resistance),
      rejection:active?active.rejection:"NONE",
      direction:active?active.direction:"-",
      atr:round(currentAtr),
      swingLeft:left,
      swingRight:right,
      toleranceATR:toleranceAtr,
      tested:{support:supportTested,resistance:resistanceTested}
    },
    note:"Strategy #5 only: 3/3 swing levels, rejection candle, ATR(14) SMA, 0.25 ATR tolerance, minimum 1 ATR SL, TP 2R. No P78 conditions."
  };
}

async function strategy5Scan(){
  const candles=await getCandles(TF["5M"],5000);
  if(!candles||candles.length<30)throw new Error("Strategy #5: insufficient XAUUSD 5M candles");
  return strategy5ScanCandles(candles);
}

app.get("/strategy5/decision",auth,async(req,res)=>{
  try{
    const x=await strategy5Scan();
    res.status(200).json({...x,liquidAutoTrade:LIQUID_AUTO_TRADE,executionAllowed:LIQUID_AUTO_TRADE&&!!x.executable});
  }catch(e){
    lastError=e.message;
    res.status(500).json({success:false,strategy:"STRATEGY_5",status:"ERROR",error:e.message});
  }
});
app.get("/strategy5/status",(req,res)=>res.json({success:true,strategy:"STRATEGY_5",status:"RUNNING",lastError}));

app.get("/p78/decision",auth,async(req,res)=>{
  const x=await scanAndAlert();
  res.status(x.success===false?500:200).json({...x,liquidAutoTrade:LIQUID_AUTO_TRADE,executionAllowed:LIQUID_AUTO_TRADE&&!!x.executable});
});
app.get("/signal",auth,async(req,res)=>{
  const x=await scanAndAlert();
  res.status(x.success===false?500:200).json({...x,liquidAutoTrade:LIQUID_AUTO_TRADE,executionAllowed:LIQUID_AUTO_TRADE&&!!x.executable});
});
app.get("/p78/status",(req,res)=>res.json({success:true,strategy:"P78",status:"RUNNING",liquidAutoTrade:LIQUID_AUTO_TRADE,telegramEnabled,telegramConfigured:!!(TELEGRAM_BOT_TOKEN&&TELEGRAM_CHAT_ID),lastScanAt:lastScan?.generatedAt||null,lastSignalKey,lastTelegram,lastError,backtest:{trades:354,wins:277,losses:77,winRate:78.25,netR:255.40}}));
app.get("/status",(req,res)=>res.json({success:true,instrument:OUTPUT_SYMBOL,strategy:"P78",liquidAutoTrade:LIQUID_AUTO_TRADE,lastScan,lastError}));
app.post("/p78/telegram",(req,res)=>{telegramEnabled=!!req.body?.enabled;res.json({success:true,telegramEnabled});});
app.get("/health",(req,res)=>res.json({success:true,instrument:OUTPUT_SYMBOL,strategy:"P78"}));

/* =========================================================
   ADDED: TELEGRAM COMMANDS
   /start_p78  = turn Telegram signal alerts ON
   /stop_p78   = turn Telegram signal alerts OFF
   /status_p78 = check alert status
   ========================================================= */

let telegramUpdateOffset=0;
let telegramCommandPolling=false;

async function sendTelegramCommandReply(message){
  if(!TELEGRAM_BOT_TOKEN||!TELEGRAM_CHAT_ID)return;
  try{
    const r=await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({chat_id:TELEGRAM_CHAT_ID,text:String(message)})
    });
    const j=await r.json();
    if(!r.ok||!j.ok)console.error("Telegram command reply failed:",j.description||"Telegram error");
  }catch(e){
    console.error("Telegram command reply error:",e.message);
  }
}

async function pollTelegramCommands(){
  if(!TELEGRAM_BOT_TOKEN||!TELEGRAM_CHAT_ID||telegramCommandPolling)return;
  telegramCommandPolling=true;

  try{
    const url=`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${telegramUpdateOffset}&timeout=0`;
    const response=await fetch(url);
    const data=await response.json();

    if(!response.ok||!data.ok||!Array.isArray(data.result))return;

    for(const update of data.result){
      telegramUpdateOffset=Math.max(telegramUpdateOffset,Number(update.update_id||0)+1);

      const message=update.message;
      if(!message?.text||!message.chat)continue;
      if(String(message.chat.id)!==String(TELEGRAM_CHAT_ID))continue;

      const command=message.text.trim().split(/\s+/)[0].split("@")[0].toLowerCase();

      if(command==="/start_p78"){
        telegramEnabled=true;
        await sendTelegramCommandReply("✅ P78 Telegram signals are ON.");
      }else if(command==="/stop_p78"){
        telegramEnabled=false;
        await sendTelegramCommandReply("⏸️ P78 Telegram signals are OFF. Scanning continues.");
      }else if(command==="/status_p78"){
        await sendTelegramCommandReply(`P78 Telegram signals: ${telegramEnabled?"ON ✅":"OFF ⏸️"}`);
      }
    }
  }catch(e){
    console.error("Telegram command polling error:",e.message);
  }finally{
    telegramCommandPolling=false;
  }
}

pollTelegramCommands();
setInterval(pollTelegramCommands,3000);

/* END ADDED TELEGRAM COMMANDS */

setTimeout(scanAndAlert,20000);
setInterval(scanAndAlert,60000);
app.listen(PORT,"0.0.0.0",()=>console.log(`P78 XAUUSD server running on ${PORT}`));

import express from "express";

const app = express();
app.use(express.json());
app.use((req,res,next)=>{res.setHeader("Access-Control-Allow-Origin","*");res.setHeader("Access-Control-Allow-Methods","GET,OPTIONS");res.setHeader("Access-Control-Allow-Headers","Content-Type");if(req.method==="OPTIONS")return res.sendStatus(204);next();});

const PORT = Number(process.env.PORT || 10000);
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY || "";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const SYMBOL = "XAU/USD";
const OUTPUT_SYMBOL = "XAUUSD";
const TF = {"1H":"1h","15M":"15min","5M":"5min"};

const CACHE = new Map();
const CACHE_MS = 18000;
const SIGNAL_COOLDOWN_MS = 5 * 60 * 1000;
const MONITOR_MS = 30 * 1000;
let lastSignalKey = null;
let lastSignalSentAt = 0;
let lastScan = null;
let monitorBusy = false;
let lastError = null;
let lastTelegram = null;

function n(v,d=null){const x=Number(v);return Number.isFinite(x)?x:d;}
function r(v,d=2){return Number.isFinite(v)?Math.round(v*10**d)/10**d:null;}
function avg(a){const x=a.filter(Number.isFinite);return x.length?x.reduce((s,v)=>s+v,0)/x.length:null;}
function last(a){return a?.length?a[a.length-1]:null;}
function prev(a){return a?.length>1?a[a.length-2]:null;}
function clamp(v,lo,hi){return Math.max(lo,Math.min(hi,v));}
function median(a){const x=a.filter(Number.isFinite).sort((a,b)=>a-b);if(!x.length)return null;const m=Math.floor(x.length/2);return x.length%2?x[m]:(x[m-1]+x[m])/2;}

function normalizeCandles(values){return (values||[]).map(x=>({time:x.datetime,open:n(x.open),high:n(x.high),low:n(x.low),close:n(x.close),volume:n(x.volume)})).filter(x=>x.time&&[x.open,x.high,x.low,x.close].every(Number.isFinite)).sort((a,b)=>new Date(a.time)-new Date(b.time));}
function normalizeBiquote(bars){return (bars||[]).filter(x=>!x.isOpen).map(x=>({time:x.openTime,open:n(x.open),high:n(x.high),low:n(x.low),close:n(x.close),volume:n(x.volume)??n(x.tickVolume)})).filter(x=>x.time&&[x.open,x.high,x.low,x.close].every(Number.isFinite)).sort((a,b)=>new Date(a.time)-new Date(b.time));}

async function getCandles(interval,size=350){
  const key=`${interval}:${size}`;const c=CACHE.get(key);if(c&&Date.now()-c.t<CACHE_MS)return c.data;
  let twelveErr=null;
  if(TWELVE_DATA_API_KEY){
    try{
      const u=`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(SYMBOL)}&interval=${encodeURIComponent(interval)}&outputsize=${size}&apikey=${encodeURIComponent(TWELVE_DATA_API_KEY)}`;
      const q=await fetch(u);const j=await q.json();
      if(!q.ok||j.status==="error"||!j.values)throw new Error(j.message||"Twelve Data unavailable");
      const data=normalizeCandles(j.values);if(data.length<80)throw new Error(`Insufficient ${interval} candles`);
      CACHE.set(key,{t:Date.now(),data});return data;
    }catch(e){twelveErr=e;}
  }
  try{
    const u=`https://biquote.io/api/XAUUSD/ohlc?interval=${encodeURIComponent(interval==="1h"?"1h":interval==="15min"?"15m":"5m")}&limit=${Math.min(Math.max(size,100),1000)}`;
    const q=await fetch(u);const j=await q.json();if(!q.ok||!Array.isArray(j.bars))throw new Error(j.message||"Biquote unavailable");
    const data=normalizeBiquote(j.bars);if(data.length<80)throw new Error(`Insufficient ${interval} candles`);CACHE.set(key,{t:Date.now(),data});return data;
  }catch(e){throw new Error(`Market data failed: ${twelveErr?.message||"Twelve Data not configured"}; ${e.message}`);}
}

async function telegram(message){
  if(!TELEGRAM_BOT_TOKEN||!TELEGRAM_CHAT_ID)return {sent:false,reason:"Telegram environment variables missing"};
  try{
    const chunks=[];const text=String(message);for(let i=0;i<text.length;i+=3900)chunks.push(text.slice(i,i+3900));
    for(const chunk of chunks){const q=await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:TELEGRAM_CHAT_ID,text:chunk})});const j=await q.json();if(!q.ok||!j.ok)return {sent:false,error:j.description||"Telegram failed"};}
    return {sent:true,chunks:chunks.length};
  }catch(e){return {sent:false,error:e.message};}
}

function emaSeries(v,p){if(v.length<p)return [];const out=Array(v.length).fill(null);const k=2/(p+1);let e=avg(v.slice(0,p));out[p-1]=e;for(let i=p;i<v.length;i++){e=v[i]*k+e*(1-k);out[i]=e;}return out;}
function ema(v,p){const s=emaSeries(v,p);return last(s);}
function rsi(v,p=14){if(v.length<=p)return null;let g=0,l=0;for(let i=1;i<=p;i++){const d=v[i]-v[i-1];if(d>0)g+=d;else l-=d;}let ag=g/p,al=l/p;for(let i=p+1;i<v.length;i++){const d=v[i]-v[i-1];ag=(ag*(p-1)+Math.max(d,0))/p;al=(al*(p-1)+Math.max(-d,0))/p;}return al===0?100:100-100/(1+ag/al);}
function atr(c,p=14){if(c.length<=p)return null;const t=[];for(let i=1;i<c.length;i++)t.push(Math.max(c[i].high-c[i].low,Math.abs(c[i].high-c[i-1].close),Math.abs(c[i].low-c[i-1].close)));return avg(t.slice(-p));}
function macd(v){if(v.length<40)return null;const a=emaSeries(v,12),b=emaSeries(v,26),m=[];for(let i=0;i<v.length;i++)if(Number.isFinite(a[i])&&Number.isFinite(b[i]))m.push(a[i]-b[i]);const sig=ema(m,9),line=last(m);if(!Number.isFinite(sig)||!Number.isFinite(line))return null;return {line,signal:sig,histogram:line-sig,bias:line>sig?"Bullish":line<sig?"Bearish":"Neutral"};}

function swings(c,left=2,right=2){const hi=[],lo=[];for(let i=left;i<c.length-right;i++){let h=true,l=true;for(let j=i-left;j<=i+right;j++){if(j===i)continue;if(c[j].high>=c[i].high)h=false;if(c[j].low<=c[i].low)l=false;}if(h)hi.push({index:i,price:c[i].high,time:c[i].time});if(l)lo.push({index:i,price:c[i].low,time:c[i].time});}return {highs:hi,lows:lo};}
function structure(c){const s=swings(c),h=last(s.highs),h2=s.highs.at(-2),l=last(s.lows),l2=s.lows.at(-2);const HH=!!h&&!!h2&&h.price>h2.price,HL=!!l&&!!l2&&l.price>l2.price,LH=!!h&&!!h2&&h.price<h2.price,LL=!!l&&!!l2&&l.price<l2.price;let bias="Mixed";if(HH&&HL)bias="Bullish";else if(LH&&LL)bias="Bearish";return {bias,HH,HL,LH,LL,high:h,prevHigh:h2,low:l,prevLow:l2};}
function breaks(c,s){const x=last(c),p=prev(c),a=atr(c)||0,b=a*.04;if(!x||!p)return {direction:"None",bos:"None",choch:"None",level:null};const up=s.high&&x.close>s.high.price+b&&p.close<=s.high.price+b;const dn=s.low&&x.close<s.low.price-b&&p.close>=s.low.price-b;const range=x.high-x.low,body=Math.abs(x.close-x.open),disp=a>0&&range>=a*.8&&body/Math.max(range,.00001)>=.5;if(up&&disp)return {direction:"Bullish",bos:"Bullish BOS",choch:s.bias==="Bearish"?"Bullish CHoCH":"None",level:s.high.price};if(dn&&disp)return {direction:"Bearish",bos:"Bearish BOS",choch:s.bias==="Bullish"?"Bearish CHoCH":"None",level:s.low.price};return {direction:"None",bos:"None",choch:"None",level:null};}

function liquidity(c,s){const x=last(c),p=prev(c),a=atr(c)||0,look=c.slice(-22,-2);const priorHigh=Math.max(...look.map(z=>z.high)),priorLow=Math.min(...look.map(z=>z.low));const bull=x&&p&&x.low<priorLow&&x.close>priorLow&&x.close>x.open&&x.high-x.low>a*.55;const bear=x&&p&&x.high>priorHigh&&x.close<priorHigh&&x.close<x.open&&x.high-x.low>a*.55;return {latestSweep:bull?"Bullish Liquidity Sweep":bear?"Bearish Liquidity Sweep":"None",priorHigh,priorLow};}
function fvg(c){const bull=[],bear=[];for(let i=2;i<c.length;i++){const a=c[i-2],x=c[i];if(x.low>a.high)bull.push({low:a.high,high:x.low,index:i});if(x.high<a.low)bear.push({low:x.high,high:a.low,index:i});}return {bullish:bull.slice(-8),bearish:bear.slice(-8)};}
function orderBlocks(c){const bull=[],bear=[];for(let i=1;i<c.length-2;i++){const p=c[i],x=c[i+1],range=x.high-x.low,body=Math.abs(x.close-x.open);if(range<=0)continue;if(p.close<p.open&&x.close>x.open&&body/range>=.55&&x.close>p.high)bull.push({low:p.low,high:p.high,index:i});if(p.close>p.open&&x.close<x.open&&body/range>=.55&&x.close<p.low)bear.push({low:p.low,high:p.high,index:i});}return {bullish:bull.slice(-8),bearish:bear.slice(-8)};}
function candle(c){const x=last(c);if(!x)return {};const range=x.high-x.low,body=Math.abs(x.close-x.open),up=x.high-Math.max(x.open,x.close),dn=Math.min(x.open,x.close)-x.low;const strong=range>0&&body/range>=.6;const bullEng=prev(c)&&x.close>x.open&&prev(c).close<prev(c).open&&x.open<=prev(c).close&&x.close>=prev(c).open;const bearEng=prev(c)&&x.close<x.open&&prev(c).close>prev(c).open&&x.open>=prev(c).close&&x.close<=prev(c).open;const bullRej=dn>body*1.5&&x.close>x.open;const bearRej=up>body*1.5&&x.close<x.open;return {direction:x.close>x.open?"Bullish":x.close<x.open?"Bearish":"Neutral",strong,patterns:[bullEng?"Bullish Engulfing":null,bearEng?"Bearish Engulfing":null,bullRej?"Bullish Rejection":null,bearRej?"Bearish Rejection":null].filter(Boolean)};}

function analyze(c,tf){const closes=c.map(x=>x.close),s=structure(c),b=breaks(c,s),liq=liquidity(c,s),fv=fvg(c),ob=orderBlocks(c),cd=candle(c),a=atr(c),m=macd(closes),e9=ema(closes,9),e21=ema(closes,21),e50=ema(closes,50),price=last(c).close;let trend="Mixed";if(price>e21&&e21>e50)trend="Bullish";else if(price<e21&&e21<e50)trend="Bearish";return {tf,currentPrice:price,trend,structure:s,break:b,liquidity:liq,FVG:fv,orderBlocks:ob,candle:cd,ATR:a,indicators:{EMA9:e9,EMA21:e21,EMA50:e50,RSI14:rsi(closes),MACD:m},lastTime:last(c).time};}

function zoneHit(price,zones,side){return (zones||[]).some(z=>price>=z.low-(z.high-z.low)*.35&&price<=z.high+(z.high-z.low)*.35);}
function setup(direction,a1,a15,a5){
  const buy=direction==="BUY",reasons=[],warnings=[];let score=0;
  const trendOk=buy?(a1.trend==="Bullish"&&a15.trend!=="Bearish"):(a1.trend==="Bearish"&&a15.trend!=="Bullish");if(trendOk){score+=2;reasons.push("1H trend + 15M alignment");}
  const sOk=buy?(a15.structure.bias==="Bullish"||a15.break.direction==="Bullish"):(a15.structure.bias==="Bearish"||a15.break.direction==="Bearish");if(sOk){score+=2;reasons.push("15M market structure");}
  const bos=buy?a15.break.direction==="Bullish"||a15.break.choch==="Bullish CHoCH":a15.break.direction==="Bearish"||a15.break.choch==="Bearish CHoCH";if(bos){score+=2;reasons.push("15M BOS/CHoCH");}
  const ltf=buy?a5.break.direction==="Bullish":a5.break.direction==="Bearish";if(ltf){score+=2;reasons.push("5M displacement BOS");}
  const sw=buy?a5.liquidity.latestSweep==="Bullish Liquidity Sweep":a5.liquidity.latestSweep==="Bearish Liquidity Sweep";if(sw){score+=1;reasons.push("Liquidity sweep");}
  const zone=buy?(zoneHit(a5.currentPrice,a5.FVG.bullish,"BUY")||zoneHit(a5.currentPrice,a5.orderBlocks.bullish,"BUY")):(zoneHit(a5.currentPrice,a5.FVG.bearish,"SELL")||zoneHit(a5.currentPrice,a5.orderBlocks.bearish,"SELL"));if(zone){score+=1;reasons.push("FVG / Order Block zone");}
  const mom=buy?(a5.indicators.RSI14>52&&a5.indicators.MACD?.bias==="Bullish"&&a5.indicators.EMA9>a5.indicators.EMA21):(a5.indicators.RSI14<48&&a5.indicators.MACD?.bias==="Bearish"&&a5.indicators.EMA9<a5.indicators.EMA21);if(mom){score+=1;reasons.push("Momentum aligned");}
  const cd=buy?(a5.candle.direction==="Bullish"&&(a5.candle.strong||a5.candle.patterns.includes("Bullish Engulfing")||a5.candle.patterns.includes("Bullish Rejection"))):(a5.candle.direction==="Bearish"&&(a5.candle.strong||a5.candle.patterns.includes("Bearish Engulfing")||a5.candle.patterns.includes("Bearish Rejection")));if(cd){score+=1;reasons.push("5M candle confirmation");}
  const max=12;const ready=score>=8&&trendOk&&ltf&&(a5.ATR||0)>0;
  if(score<8)warnings.push("Insufficient confluence");if(!trendOk)warnings.push("Higher-timeframe conflict");if(!ltf)warnings.push("No fresh 5M displacement break");
  return {direction,score,maxScore:max,ready,reasons,warnings};
}

function levels(direction,a5){const price=a5.currentPrice,A=a5.ATR||0,s=a5.structure;const structural=direction==="BUY"?s.low?.price:s.high?.price;if(!Number.isFinite(price)||!A||!Number.isFinite(structural))return null;const raw=Math.abs(price-structural);const min=A*.75,max=A*1.8;if(raw<min||raw>max)return null;const sl=direction==="BUY"?price-raw:price+raw;const R=Math.abs(price-sl);return {entry:r(price,2),stopLoss:r(sl,2),takeProfit:{TP1:r(direction==="BUY"?price+R*1.5:price-R*1.5,2),TP2:r(direction==="BUY"?price+R*2:price-R*2,2),TP3:r(direction==="BUY"?price+R*2.5:price-R*2.5,2)},risk:r(R,2),rr:"1:1.5 / 1:2 / 1:2.5"};}

async function scan(){const [c1,c15,c5]=await Promise.all([getCandles(TF["1H"],350),getCandles(TF["15M"],350),getCandles(TF["5M"],350)]);const a1=analyze(c1,"1H"),a15=analyze(c15,"15M"),a5=analyze(c5,"5M");const buy=setup("BUY",a1,a15,a5),sell=setup("SELL",a1,a15,a5);const candidates=[];for(const s of [buy,sell])if(s.ready){const lv=levels(s.direction,a5);if(lv)candidates.push({...s,levels:lv});}
candidates.sort((x,y)=>y.score-x.score);const chosen=candidates[0]||null;const result={success:true,instrument:OUTPUT_SYMBOL,generatedAt:new Date().toISOString(),currentPrice:r(a5.currentPrice,2),MTF:{"1H":a1.trend,"15M":a15.trend,"5M":a5.trend},STRUCTURE:{"1H":a1.structure.bias,"15M":a15.structure.bias,"5M":a5.structure.bias},SMC:{"15M":{BOS:a15.break.bos,CHoCH:a15.break.choch},"5M":{BOS:a5.break.bos,CHoCH:a5.break.choch,Liquidity:a5.liquidity.latestSweep}},SETUPS:{BUY:buy,SELL:sell},SIGNAL:chosen?{status:`${chosen.direction} CONFIRMED`,...chosen}: {status:"WAITING",direction:"None",score:Math.max(buy.score,sell.score),maxScore:12},TRADE_LEVELS:chosen?.levels||null};lastScan=result;return result;}

function message(x){const s=x.SIGNAL||{};const l=x.TRADE_LEVELS||{};return `ðŸŸ¢ XAUUSD ${s.direction||""} SIGNAL\n\nEntry: ${l.entry??x.currentPrice}\nSL: ${l.stopLoss??"N/A"}\nTP1: ${l.takeProfit?.TP1??"N/A"}\nTP2: ${l.takeProfit?.TP2??"N/A"}\nTP3: ${l.takeProfit?.TP3??"N/A"}\nRR: ${l.rr??"N/A"}\n\nConfluence: ${s.score??0}/${s.maxScore??12}\n\n${(s.reasons||[]).map(z=>`âœ“ ${z}`).join("\n")}\n\n1H: ${x.MTF?.["1H"]}\n15M: ${x.MTF?.["15M"]}\n5M: ${x.MTF?.["5M"]}\n\nTime: ${new Date().toLocaleString("en-IN",{timeZone:"Asia/Kolkata",hour12:false})} IST`}

async function monitor(){if(monitorBusy)return;monitorBusy=true;try{const x=await scan();lastError=null;const s=x.SIGNAL;if(s?.direction&&s.direction!=="None"&&x.TRADE_LEVELS){const candleTime=x.generatedAt.slice(0,16);const key=`${s.direction}:${x.TRADE_LEVELS.entry}:${candleTime}`;if(key!==lastSignalKey&&Date.now()-lastSignalSentAt>=SIGNAL_COOLDOWN_MS){lastTelegram=await telegram(message(x));if(lastTelegram.sent){lastSignalKey=key;lastSignalSentAt=Date.now();}}}}catch(e){lastError=e.message;}finally{monitorBusy=false;}}

setTimeout(monitor,5000);setInterval(monitor,MONITOR_MS);

app.get("/",(req,res)=>res.json({success:true,bot:"XAUUSD Goldara-Style SMC Telegram Signal Engine",instrument:OUTPUT_SYMBOL,mode:"TELEGRAM_SIGNAL_ONLY",execution:false,autoTrade:false,timeframes:["1H","15M","5M"],monitorSeconds:MONITOR_MS/1000,features:["MTF trend","BOS/CHoCH","liquidity sweep","FVG","order blocks","momentum","candlestick confirmation","ATR structural SL","1.5R/2R/2.5R TP","duplicate protection"]}));
app.get("/signal",async(req,res)=>{try{res.json(await scan());}catch(e){res.status(500).json({success:false,error:e.message});}});
app.get("/analyze",async(req,res)=>{try{res.json(await scan());}catch(e){res.status(500).json({success:false,error:e.message});}});
app.get("/status",(req,res)=>res.json({success:true,instrument:OUTPUT_SYMBOL,mode:"TELEGRAM_SIGNAL_ONLY",monitorRunning:monitorBusy,lastScan:lastScan?.generatedAt||null,lastSignalSentAt:lastSignalSentAt?new Date(lastSignalSentAt).toISOString():null,lastTelegram,lastError,signal:lastScan?.SIGNAL||null,tradeLevels:lastScan?.TRADE_LEVELS||null}));
app.get("/telegram-test",async(req,res)=>res.json({success:true,telegram:await telegram("XAUUSD SIGNAL BOT\n\nTelegram connection successful.\n\nMode: Signal Only") }));
app.listen(PORT,()=>console.log(`XAUUSD Goldara-style signal server listening on ${PORT}`));

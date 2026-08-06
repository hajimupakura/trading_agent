export interface AnalyticsTrade {
  entryAt:string; entryAsk:number; exitBid:number; pnlDollars:number; underlying:"SPY"|"SPX"; dte:number;
  side:"call"|"put"; spreadPct:number|null;
}
export interface MetricSet {
  trades:number; wins:number; losses:number; winRate:number|null; netPnl:number; expectancy:number|null;
  profitFactor:number|null; averageWin:number|null; averageLoss:number|null; maxDrawdown:number; averageSpread:number|null;
}
export interface AnalyticsGroup extends MetricSet { key:string; label:string }

const round=(value:number)=>Math.round(value*100)/100;
export function calculateMetrics(values:AnalyticsTrade[]):MetricSet{
  const trades=[...values].sort((a,b)=>Date.parse(a.entryAt)-Date.parse(b.entryAt));
  const winners=trades.filter(trade=>trade.pnlDollars>0);const losers=trades.filter(trade=>trade.pnlDollars<0);
  const grossProfit=winners.reduce((sum,trade)=>sum+trade.pnlDollars,0);const grossLoss=Math.abs(losers.reduce((sum,trade)=>sum+trade.pnlDollars,0));
  const netPnl=trades.reduce((sum,trade)=>sum+trade.pnlDollars,0);let equity=0,peak=0,maxDrawdown=0;
  for(const trade of trades){equity+=trade.pnlDollars;peak=Math.max(peak,equity);maxDrawdown=Math.max(maxDrawdown,peak-equity);}
  const spreads=trades.map(trade=>trade.spreadPct).filter((value):value is number=>value!=null&&Number.isFinite(value));
  return {trades:trades.length,wins:winners.length,losses:losers.length,winRate:trades.length?round(winners.length/trades.length*100):null,netPnl:round(netPnl),expectancy:trades.length?round(netPnl/trades.length):null,profitFactor:grossLoss?round(grossProfit/grossLoss):grossProfit?null:null,averageWin:winners.length?round(grossProfit/winners.length):null,averageLoss:losers.length?round(-grossLoss/losers.length):null,maxDrawdown:round(maxDrawdown),averageSpread:spreads.length?round(spreads.reduce((sum,value)=>sum+value,0)/spreads.length):null};
}
function group(values:AnalyticsTrade[],keyOf:(trade:AnalyticsTrade)=>string,labelOf:(key:string)=>string):AnalyticsGroup[]{
  const buckets=new Map<string,AnalyticsTrade[]>();for(const trade of values){const key=keyOf(trade);buckets.set(key,[...(buckets.get(key)??[]),trade]);}
  return [...buckets].map(([key,trades])=>({key,label:labelOf(key),...calculateMetrics(trades)})).sort((a,b)=>b.trades-a.trades||a.label.localeCompare(b.label));
}
function etMinutes(timestamp:string){const parts=new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date(timestamp));return Number(parts.find(part=>part.type==="hour")?.value)*60+Number(parts.find(part=>part.type==="minute")?.value);}
export function buildAnalytics(values:AnalyticsTrade[]){
  const ordered=[...values].sort((a,b)=>Date.parse(a.entryAt)-Date.parse(b.entryAt));const split=Math.floor(ordered.length*.7);
  return {overall:calculateMetrics(values),byUnderlying:group(values,trade=>trade.underlying,key=>key),byDte:group(values,trade=>`${trade.dte}`,key=>`${key}DTE`),bySide:group(values,trade=>trade.side,key=>key.toUpperCase()),byTime:group(values,trade=>{const minutes=etMinutes(trade.entryAt);return minutes<630?"opening":minutes<840?"midday":"power";},key=>({opening:"9:30–10:30",midday:"10:30–2:00",power:"2:00–4:00"})[key]??key),byPremium:group(values,trade=>trade.entryAsk<2?"under2":trade.entryAsk<4?"2to4":"4to8",key=>({under2:"Under $2", "2to4":"$2–$4", "4to8":"$4–$8"})[key]??key),sample:ordered.length>=10?{inSample:calculateMetrics(ordered.slice(0,split)),outOfSample:calculateMetrics(ordered.slice(split)),split}:null};
}

import { generateSignal } from "@/lib/options/signal";
import { marketStateAt } from "@/lib/options/market-state";
import type { Bar, Contract, Side, Underlying } from "@/lib/options/types";

const dummy = (underlying:Underlying, side:Side):Contract => ({ ticker:`REPLAY-${side}`,underlying,expirationDate:"",dte:0,side,strike:0,exerciseStyle:"unknown",bid:1,ask:1.05,midpoint:1.025,spreadPct:4.9,quoteUpdatedAt:0,volume:1000,openInterest:1000,volumeToOpenInterest:1,impliedVolatility:null,delta:null,gamma:null,theta:null,underlyingPrice:null,liquidityScore:100,eligible:true,rejectionReasons:[] });

export interface ReplayTrigger { timestamp:number; side:Side; reasons:string[]; spot:number; openingRangeHigh:number; openingRangeLow:number }

const ENTRY_WINDOW={start:9*60+45,end:14*60+45} as const; // production ET entry window (risk.ts defaults)
const etMinutes=(timestamp:number)=>{const parts=new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date(timestamp));return Number(parts.find(part=>part.type==="hour")?.value)*60+Number(parts.find(part=>part.type==="minute")?.value);};

export function findReplayTriggers(underlying:Underlying, bars:Bar[], maximum=3, options?:{trendDayEnabled?:boolean}):ReplayTrigger[] {
  const triggers:ReplayTrigger[]=[]; let previous:"call"|"put"|null=null;
  for(let index=35; index<bars.length; index++) {
    // Only bars inside the production entry window can trigger — late-day signals could
    // never be approved live, and post-15:10 entries also invert the exit-quote window.
    const minutes=etMinutes(bars[index]!.timestamp);
    if(minutes<ENTRY_WINDOW.start||minutes>ENTRY_WINDOW.end){previous=null;continue;}
    const window=bars.slice(0,index+1); const market=marketStateAt(underlying,window);
    const signal=generateSignal(market,[dummy(underlying,"call"),dummy(underlying,"put")],{trendDayEnabled:options?.trendDayEnabled});
    const side=signal.action === "enter_call" ? "call" : signal.action === "enter_put" ? "put" : null;
    if(side && side !== previous) triggers.push({timestamp:market.asOf,side,reasons:signal.reasons.filter(reason=>!reason.startsWith("REPLAY-")),spot:market.price,openingRangeHigh:market.openingRangeHigh,openingRangeLow:market.openingRangeLow});
    previous=side;
    if(triggers.length>=maximum) break;
  }
  return triggers;
}

export function summarizeTrades(trades:Array<{pnlDollars:number}>){
  const wins=trades.filter(trade=>trade.pnlDollars>0).length; const losses=trades.filter(trade=>trade.pnlDollars<0).length;
  let equity=0,peak=0,maxDrawdown=0; for(const trade of trades){equity+=trade.pnlDollars;peak=Math.max(peak,equity);maxDrawdown=Math.max(maxDrawdown,peak-equity);}
  const netPnl=trades.reduce((sum,trade)=>sum+trade.pnlDollars,0);
  return { signals:trades.length,trades:trades.length,wins,losses,winRate:trades.length?wins/trades.length*100:null,netPnl,expectancy:trades.length?netPnl/trades.length:null,maxDrawdown };
}

import type { Bar, Side, Underlying } from "@/lib/options/types";

export interface ReplayTrade {
  signalTime:number; action:"enter_call"|"enter_put"; contractTicker:string; side:Side; strike:number;
  entryAsk:number; exitBid:number; exitTime:number; exitReason:"stop"|"target"|"time"|"end_of_data";
  pnlDollars:number; returnPct:number; mfePct:number; maePct:number; cumulativeVolume:number; spreadPct:number;
  passedRules:string[];
}
export interface ReplayResult {
  id?:string; underlying:Underlying; sessionDate:string; dte:number; expirationDate:string; strategyVersion:string;
  status:"complete"|"partial"; bars:Bar[]; trades:ReplayTrade[]; noTradeReasons:string[];
  summary:{signals:number;trades:number;wins:number;losses:number;winRate:number|null;netPnl:number;expectancy:number|null;maxDrawdown:number};
  limitations:string[]; createdAt:string;
}

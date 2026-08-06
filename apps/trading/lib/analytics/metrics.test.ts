import {describe,expect,it} from "vitest";
import {buildAnalytics,calculateMetrics,type AnalyticsTrade} from "./metrics";
const trade=(pnlDollars:number,overrides:Partial<AnalyticsTrade>={}):AnalyticsTrade=>({entryAt:"2026-08-03T14:00:00Z",entryAsk:2,exitBid:2+pnlDollars/100,pnlDollars,underlying:"SPY",dte:0,side:"call",spreadPct:5,...overrides});
describe("strategy analytics",()=>{
  it("calculates expectancy, profit factor, and chronological drawdown",()=>{expect(calculateMetrics([trade(100),trade(-50),trade(-25)])).toMatchObject({trades:3,wins:1,losses:2,winRate:33.33,netPnl:25,expectancy:8.33,profitFactor:1.33,averageWin:100,averageLoss:-37.5,maxDrawdown:75});});
  it("groups without treating missing loss denominator as infinite",()=>{const result=buildAnalytics([trade(20,{entryAsk:1.5}),trade(30,{underlying:"SPX",dte:1,side:"put",entryAsk:5})]);expect(result.overall.profitFactor).toBeNull();expect(result.byUnderlying).toHaveLength(2);expect(result.byPremium.map(row=>row.label)).toEqual(expect.arrayContaining(["Under $2","$4–$8"]));});
  it("withholds in/out-of-sample claims until ten trades exist",()=>expect(buildAnalytics(Array.from({length:9},()=>trade(1))).sample).toBeNull());
});

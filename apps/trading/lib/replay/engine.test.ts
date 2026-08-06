import { describe,expect,it } from "vitest";
import { summarizeTrades } from "./engine";

describe("replay summary",()=>{
  it("uses dollars and computes peak-to-trough drawdown",()=>{
    const summary=summarizeTrades([{pnlDollars:50},{pnlDollars:-80},{pnlDollars:20}]);
    expect(summary).toMatchObject({signals:3,trades:3,wins:2,losses:1,netPnl:-10,maxDrawdown:80});
    expect(summary.winRate).toBeCloseTo(200/3); expect(summary.expectancy).toBeCloseTo(-10/3);
  });
  it("does not invent a win rate for no trades",()=>expect(summarizeTrades([]).winRate).toBeNull());
});

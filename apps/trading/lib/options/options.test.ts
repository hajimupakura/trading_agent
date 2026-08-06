import { describe, expect, it } from "vitest";
import { rankContracts } from "./ranker";
import { generateSignal } from "./signal";
import type { Contract, MarketState } from "./types";

const raw = (overrides:Record<string,unknown> = {}) => ({ ticker:"O:SPY260806C00650000", underlying:"SPY" as const, expirationDate:"2026-08-06", dte:0, side:"call" as const, strike:650, exerciseStyle:"american", bid:1.9, ask:2, midpoint:1.95, spreadPct:5.1, quoteUpdatedAt:Date.now(), volume:10_000, openInterest:2_000, volumeToOpenInterest:5, impliedVolatility:.2, delta:.45, gamma:.1, theta:-.2, underlyingPrice:650, ...overrides });
const market = (overrides:Partial<MarketState> = {}):MarketState => ({ symbol:"SPY", chartSymbol:"SPY", asOf:Date.now(), price:651, displayPrice:651, referencePrice:649.5, referenceLabel:"VWAP", openingRangeHigh:650.5, openingRangeLow:647, regime:"uptrend", bars:[], technicals:{ ema8:650.5, ema21:649.5, rsi14:62, atr14:1.2, macd:.4, macdSignal:.25, bollingerPosition:.7, breakoutAtr:.42, volumeConfirmation:true, candlePattern:"none" }, ...overrides });

describe("focused options engine", () => {
  it("rejects an option above the configured $8 quote ceiling", () => {
    const [contract] = rankContracts([raw({ bid:8, ask:8.25, midpoint:8.125 })]);
    expect(contract?.eligible).toBe(false); expect(contract?.rejectionReasons).toContain("Ask exceeds $8.00");
  });
  it("ranks an executable high-volume option ahead of an illiquid one", () => {
    const ranked = rankContracts([raw(), raw({ ticker:"O:SPY260806C00660000", volume:2, openInterest:0, bid:.01, ask:.2, midpoint:.105, spreadPct:181 })]);
    expect(ranked[0]?.eligible).toBe(true); expect(ranked[0]?.ticker).toContain("650000");
  });
  it("emits a call only with aligned breakout momentum", () => {
    const [contract] = rankContracts([raw()]); const signal = generateSignal(market(), [contract as Contract]);
    expect(signal.action).toBe("enter_call"); expect(signal.invalidation).toContain("VWAP");
  });
  it("does not chase an overextended RSI", () => {
    const [contract] = rankContracts([raw()]); const base = market();
    const signal = generateSignal(market({ technicals:{ ...base.technicals, rsi14:82 } }), [contract as Contract]);
    expect(signal.action).toBe("watch");
  });
});

import { describe, expect, it } from "vitest";
import { rankOptionContracts, type RawOptionContract } from "./services/options/contractRanker";
import { generateOptionsSignal } from "./services/options/setupEngine";
import type { MarketState } from "./services/options/types";
import { evaluateOptionExit } from "./services/options/exitEngine";

function contract(overrides: Partial<RawOptionContract> = {}): RawOptionContract {
  return {
    ticker: "O:SPY260805C00650000", underlying: "SPY", expirationDate: "2026-08-05",
    dte: 0, side: "call", strike: 650, exerciseStyle: "american", bid: 1.9, ask: 2,
    midpoint: 1.95, spread: 0.1, spreadPct: 5.13, last: 1.95, lastTradeSize: 10,
    quoteUpdatedAt: Date.now(), volume: 10_000, openInterest: 2_000, volumeToOpenInterest: 5,
    impliedVolatility: 0.2, delta: 0.45, gamma: 0.1, theta: -0.2, vega: 0.03,
    underlyingPrice: 650, ...overrides,
  };
}

function market(overrides: Partial<MarketState> = {}): MarketState {
  return {
    symbol: "SPY", asOf: Date.now(), price: 651, referencePrice: 649.5,
    referenceLabel: "VWAP", aboveReference: true,
    openingRangeHigh: 650.5, openingRangeLow: 647, relativeVolume: null,
    technicals: {
      ema8: 650.5, ema21: 649.5, rsi14: 62, atr14: 1.2, macd: 0.4,
      macdSignal: 0.25, bollingerPosition: 0.7, breakoutAtr: 0.42,
      volumeConfirmation: true, candlePattern: "none",
    },
    regime: "uptrend", bars: [], ...overrides,
  };
}

describe("0-2 DTE contract ranking", () => {
  it("ranks executable high-volume contracts above illiquid contracts", () => {
    const ranked = rankOptionContracts([
      contract(),
      contract({ ticker: "O:SPY260805C00660000", strike: 660, bid: 0.01, ask: 0.2, midpoint: 0.105, spread: 0.19, spreadPct: 181, volume: 3, openInterest: 0, volumeToOpenInterest: 3 }),
    ]);
    expect(ranked[0]?.ticker).toBe("O:SPY260805C00650000");
    expect(ranked[0]?.eligible).toBe(true);
    expect(ranked[1]?.eligible).toBe(false);
  });

  it("rejects contracts outside the requested DTE window", () => {
    const [ranked] = rankOptionContracts([contract({ dte: 3 })]);
    expect(ranked?.eligible).toBe(false);
    expect(ranked?.rejectionReasons).toContain("Outside 0-2 DTE window");
  });

  it("rejects contracts whose ask exceeds the $8 quote cap", () => {
    const [ranked] = rankOptionContracts([contract({ bid: 8, ask: 8.25, midpoint: 8.125, spread: 0.25, spreadPct: 3.08 })]);
    expect(ranked?.eligible).toBe(false);
    expect(ranked?.rejectionReasons).toContain("Ask exceeds $8.00 ($800 standard-contract debit)");
  });
});

describe("options setup engine", () => {
  it("emits a call candidate only when price confirms an uptrend breakout", () => {
    const [ranked] = rankOptionContracts([contract()]);
    const signal = generateOptionsSignal(market(), [ranked!]);
    expect(signal.action).toBe("enter_call");
    expect(signal.setup).toBe("opening_range");
    expect(signal.invalidation).toContain("VWAP");
  });

  it("watches rather than entering when the market is ranging", () => {
    const [ranked] = rankOptionContracts([contract()]);
    const signal = generateOptionsSignal(market({ regime: "range", price: 649.8 }), [ranked!]);
    expect(signal.action).toBe("watch");
  });

  it("does not emit an entry when liquidity controls reject every contract", () => {
    const [ranked] = rankOptionContracts([contract({ volume: 1, bid: 0, ask: 0.1, midpoint: 0, spread: 0, spreadPct: 999 })]);
    const signal = generateOptionsSignal(market(), [ranked!]);
    expect(signal.action).toBe("no_trade");
    expect(signal.contract).toBeNull();
  });

  it("watches instead of chasing an overextended RSI", () => {
    const [ranked] = rankOptionContracts([contract()]);
    const signal = generateOptionsSignal(market({ technicals: { ...market().technicals, rsi14: 82 } }), [ranked!]);
    expect(signal.action).toBe("watch");
  });
});

describe("deterministic exit engine", () => {
  it("exits when the underlying invalidates a call breakout", () => {
    const [ranked] = rankOptionContracts([contract({ bid: 1.9, quoteUpdatedAt: Date.now() })]);
    const decision = evaluateOptionExit({ ticker: ranked!.ticker, side: "call", entryPrice: 2, enteredAt: Date.now() - 60_000, entryReferencePrice: 649.5, openingRangeHigh: 650.5, openingRangeLow: 647 }, ranked!, market({ price: 649, referencePrice: 649.5 }));
    expect(decision.exit).toBe(true);
    expect(decision.reason).toBe("setup_invalidated");
  });

  it("exits without AI when premium reaches the hard loss limit", () => {
    const [ranked] = rankOptionContracts([contract({ bid: 1.2, ask: 1.25, midpoint: 1.225, spread: 0.05, spreadPct: 4.1, quoteUpdatedAt: Date.now() })]);
    const decision = evaluateOptionExit({ ticker: ranked!.ticker, side: "call", entryPrice: 2, enteredAt: Date.now() - 60_000, entryReferencePrice: 649.5, openingRangeHigh: 650.5, openingRangeLow: 647 }, ranked!, market());
    expect(decision.exit).toBe(true);
    expect(decision.reason).toBe("max_loss");
  });
});

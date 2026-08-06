export type Underlying = "SPY" | "SPX";
export type Side = "call" | "put";

export interface Bar { timestamp: number; open: number; high: number; low: number; close: number; volume: number; vwap: number | null }
export interface Technicals {
  ema8: number; ema21: number; rsi14: number | null; atr14: number | null;
  macd: number | null; macdSignal: number | null; bollingerPosition: number | null;
  breakoutAtr: number | null; volumeConfirmation: boolean | null;
  candlePattern: "bullish_engulfing" | "bearish_engulfing" | "hammer" | "shooting_star" | "none";
}
export interface MarketState {
  symbol: Underlying; asOf: number; price: number; referencePrice: number;
  referenceLabel: "VWAP" | "SESSION_MEAN"; openingRangeHigh: number; openingRangeLow: number;
  regime: "opening" | "uptrend" | "downtrend" | "range"; technicals: Technicals; bars: Bar[];
}
export interface Contract {
  ticker: string; underlying: Underlying; expirationDate: string; dte: number; side: Side; strike: number;
  exerciseStyle: string; bid: number; ask: number; midpoint: number; spreadPct: number; quoteUpdatedAt: number | null;
  volume: number; openInterest: number; volumeToOpenInterest: number; impliedVolatility: number | null;
  delta: number | null; gamma: number | null; theta: number | null; underlyingPrice: number | null;
  liquidityScore: number; eligible: boolean; rejectionReasons: string[];
}
export interface Signal {
  id: string; generatedAt: number; action: "watch" | "enter_call" | "enter_put" | "no_trade";
  setup: "opening_range" | "none"; confidence: number; reasons: string[]; invalidation: string | null;
  contract: Contract | null; market: Omit<MarketState, "bars">;
}
export interface CommandCenter {
  configured: boolean; asOf: number; market: MarketState | null; contracts: Contract[]; signal: Signal | null; errors: string[];
}

export const TRADE_UNDERLYINGS = ["SPY", "SPX"] as const;
export const WATCH_UNDERLYINGS = ["NVDA", "SPCX", "TSLA", "AAPL", "GOOGL", "META", "MSFT", "MU", "ASTS", "SKHY", "SNDK"] as const;
export type TradeUnderlying = typeof TRADE_UNDERLYINGS[number];
export type WatchUnderlying = typeof WATCH_UNDERLYINGS[number];
export type Underlying = TradeUnderlying | WatchUnderlying;
export type Side = "call" | "put";
// Long-dated monitoring horizons and their target days-to-expiry.
export const LONG_HORIZONS = { "1M": 30, "3M": 91, "6M": 182, "9M": 273, "1Y": 365 } as const;
export type LongHorizon = keyof typeof LONG_HORIZONS;

export interface Bar { timestamp: number; open: number; high: number; low: number; close: number; volume: number; vwap: number | null }
export interface Technicals {
  ema8: number; ema21: number; rsi14: number | null; atr14: number | null;
  macd: number | null; macdSignal: number | null; bollingerPosition: number | null;
  breakoutAtr: number | null; volumeConfirmation: boolean | null; relativeVolume: number | null; vwapSlope: number | null;
  candlePattern: "bullish_engulfing" | "bearish_engulfing" | "hammer" | "shooting_star" | "none";
}
export interface MarketState {
  symbol: Underlying; chartSymbol: Underlying; asOf: number; price: number; displayPrice: number; referencePrice: number;
  referenceLabel: "VWAP" | "SESSION MEAN"; openingRangeHigh: number; openingRangeLow: number;
  regime: "opening" | "uptrend" | "downtrend" | "range"; technicals: Technicals; bars: Bar[];
  // Prior session levels for daily context (null when unavailable, e.g. SPX or replay).
  priorDay?: { high: number; low: number; close: number } | null;
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
  setup: "opening_range" | "trend_continuation" | "none"; confidence: number; reasons: string[]; invalidation: string | null;
  contract: Contract | null; market: Omit<MarketState, "bars">;
}
export interface CommandCenter {
  configured: boolean; asOf: number; market: MarketState | null; spotPrice: number | null; contracts: Contract[]; signal: Signal | null; errors: string[];
}

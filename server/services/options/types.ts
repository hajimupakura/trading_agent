export type SupportedUnderlying = "SPY" | "SPX";
export type OptionSide = "call" | "put";

export interface OptionContractSnapshot {
  ticker: string;
  underlying: SupportedUnderlying;
  expirationDate: string;
  dte: number;
  side: OptionSide;
  strike: number;
  exerciseStyle: string;
  bid: number;
  ask: number;
  midpoint: number;
  spread: number;
  spreadPct: number;
  last: number | null;
  lastTradeSize: number;
  quoteUpdatedAt: number | null;
  volume: number;
  openInterest: number;
  volumeToOpenInterest: number;
  impliedVolatility: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  underlyingPrice: number | null;
  liquidityScore: number;
  eligible: boolean;
  rejectionReasons: string[];
}

export interface UnderlyingBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap: number | null;
}

export type MarketRegime = "opening" | "uptrend" | "downtrend" | "range" | "closed";

export interface MarketState {
  symbol: SupportedUnderlying;
  asOf: number;
  price: number;
  referencePrice: number;
  referenceLabel: "VWAP" | "SESSION_MEAN";
  aboveReference: boolean;
  openingRangeHigh: number;
  openingRangeLow: number;
  relativeVolume: number | null;
  technicals: {
    ema8: number;
    ema21: number;
    rsi14: number | null;
    atr14: number | null;
    macd: number | null;
    macdSignal: number | null;
    bollingerPosition: number | null;
    breakoutAtr: number | null;
    volumeConfirmation: boolean | null;
    candlePattern: "bullish_engulfing" | "bearish_engulfing" | "hammer" | "shooting_star" | "none";
  };
  regime: MarketRegime;
  bars: UnderlyingBar[];
}

export type SignalAction = "watch" | "enter_call" | "enter_put" | "no_trade";

export interface OptionsSignal {
  id: string;
  generatedAt: number;
  action: SignalAction;
  setup: "opening_range" | "vwap_trend" | "none";
  confidence: number;
  reasons: string[];
  invalidation: string | null;
  contract: OptionContractSnapshot | null;
  market: Omit<MarketState, "bars">;
  aiReview?: {
    verdict: "confirm" | "reject" | "caution";
    summary: string;
    risks: string[];
  };
}

export interface OptionsCommandCenter {
  provider: "massive";
  configured: boolean;
  aiReviewEnabled: boolean;
  delayedWarning: string | null;
  asOf: number;
  market: MarketState | null;
  contracts: OptionContractSnapshot[];
  signal: OptionsSignal | null;
  errors: string[];
}

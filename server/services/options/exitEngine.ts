import type { MarketState, OptionContractSnapshot } from "./types";

export interface ShadowOptionPosition {
  ticker: string;
  side: "call" | "put";
  entryPrice: number;
  enteredAt: number;
  entryReferencePrice: number;
  openingRangeHigh: number;
  openingRangeLow: number;
}

export interface ExitDecision {
  exit: boolean;
  reason: "hold" | "max_loss" | "profit_target" | "setup_invalidated" | "max_hold_time" | "stale_quote";
  returnPct: number | null;
}

export function evaluateOptionExit(
  position: ShadowOptionPosition,
  contract: OptionContractSnapshot | null,
  market: MarketState,
  now = Date.now(),
): ExitDecision {
  if (!contract || contract.quoteUpdatedAt == null || now - contract.quoteUpdatedAt > 30_000) {
    return { exit: true, reason: "stale_quote", returnPct: null };
  }
  const mark = contract.bid > 0 ? contract.bid : contract.midpoint;
  const returnPct = position.entryPrice > 0 ? (mark - position.entryPrice) / position.entryPrice * 100 : null;
  if (returnPct != null && returnPct <= -35) return { exit: true, reason: "max_loss", returnPct };
  if (returnPct != null && returnPct >= 50) return { exit: true, reason: "profit_target", returnPct };
  if (now - position.enteredAt >= 45 * 60_000) return { exit: true, reason: "max_hold_time", returnPct };
  const invalidated = position.side === "call"
    ? market.price < market.referencePrice || market.price < position.openingRangeHigh
    : market.price > market.referencePrice || market.price > position.openingRangeLow;
  if (invalidated) return { exit: true, reason: "setup_invalidated", returnPct };
  return { exit: false, reason: "hold", returnPct };
}

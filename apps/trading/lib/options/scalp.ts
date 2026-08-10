import "server-only";
import type { Contract, MarketState, Signal } from "./types";

// SCALP signal: the day-trader's dip-and-rip. Fires when price dips meaningfully below
// VWAP and then RECLAIMS it with momentum — the exact shape of the 2026-08-10 SPX
// rebound the ORB gates structurally cannot catch (VWAP slope stays negative for
// minutes after a v-bottom, and the extension band is passed by the time momentum
// confirms). Mirror logic fades a pop back below VWAP for puts.
//
// Deliberately looser than the ORB stack — the scalp exit profile (25% stop, 2x
// target, 15% trail after +30%, 30-minute time box) is the risk control, not the
// entry filter. PAPER ONLY until the record proves it.

const DIP_ATR = 0.4;      // how far beyond VWAP the excursion must have stretched
const LOOKBACK_BARS = 30; // minutes of history the excursion may live in
const MAX_EXT_ATR = 1.0;  // do not chase a reclaim already 1 ATR past VWAP

export function generateScalpSignal(market: MarketState, contracts: Contract[], options?: { deltaTarget?: number }): Signal | null {
  const technicals = market.technicals;
  const atr = technicals.atr14;
  const vwap = market.referencePrice;
  const bars = market.bars;
  if (!atr || atr <= 0 || !vwap || bars.length < LOOKBACK_BARS + 2) return null;
  const last = bars.at(-1)!; const prev = bars.at(-2)!;
  const window = bars.slice(-(LOOKBACK_BARS + 1), -1);
  const dippedBelow = window.some(bar => bar.close < vwap - DIP_ATR * atr);
  const poppedAbove = window.some(bar => bar.close > vwap + DIP_ATR * atr);
  const rsi = technicals.rsi14;
  const deltaTarget = options?.deltaTarget ?? .45;
  const eligible = contracts.filter(contract => contract.eligible);
  const pick = (side: Contract["side"]) => {
    const candidates = eligible.filter(contract => contract.side === side);
    if (!candidates.length) return null;
    const minDte = Math.min(...candidates.map(contract => contract.dte));
    const sameDay = candidates.filter(contract => contract.dte === minDte);
    const distance = (contract: Contract) => contract.delta == null ? .5 : Math.abs(Math.abs(contract.delta) - deltaTarget);
    return sameDay.slice().sort((a, b) => distance(a) - distance(b) || b.liquidityScore - a.liquidityScore)[0] ?? null;
  };

  // Call scalp: dipped below, and THIS bar crosses back above VWAP (prev at/below).
  const callTrigger = dippedBelow && prev.close <= vwap && last.close > vwap
    && last.close - vwap <= MAX_EXT_ATR * atr
    && rsi != null && rsi >= 45 && rsi <= 70
    && last.close > prev.close
    && !["bearish_engulfing", "shooting_star"].includes(technicals.candlePattern);
  // Put scalp: popped above, and THIS bar crosses back below VWAP.
  const putTrigger = poppedAbove && prev.close >= vwap && last.close < vwap
    && vwap - last.close <= MAX_EXT_ATR * atr
    && rsi != null && rsi <= 55 && rsi >= 30
    && last.close < prev.close
    && !["bullish_engulfing", "hammer"].includes(technicals.candlePattern);

  const side = callTrigger ? "call" : putTrigger ? "put" : null;
  if (!side) return null;
  const contract = pick(side);
  if (!contract) return null;
  const summary = (({ bars: _, ...value }) => value)(market);
  const excursion = side === "call"
    ? Math.abs(Math.min(...window.map(bar => bar.close)) - vwap) / atr
    : Math.abs(Math.max(...window.map(bar => bar.close)) - vwap) / atr;
  // Confidence scales with excursion depth (a deeper washout has more snap-back fuel)
  // and contract liquidity; capped modestly — scalps are volume plays, not conviction plays.
  const confidence = Math.round(Math.min(80, 40 + Math.min(excursion, 3) * 8 + contract.liquidityScore / 10));
  return {
    id: `${market.symbol}-${market.asOf}-scalp-${side}-${contract.ticker}`,
    generatedAt: Date.now(),
    action: side === "call" ? "enter_call" : "enter_put",
    setup: "scalp_reclaim",
    confidence,
    reasons: [
      side === "call"
        ? `Scalp: dipped ${excursion.toFixed(1)} ATR below VWAP within ${LOOKBACK_BARS} min, now reclaiming it with RSI ${rsi!.toFixed(0)}`
        : `Scalp: popped ${excursion.toFixed(1)} ATR above VWAP within ${LOOKBACK_BARS} min, now losing it with RSI ${rsi!.toFixed(0)}`,
      "Exit plan (replay-calibrated): 30% stop, trail 20% once up 40% (15% after 2x), flat by 3:10 PM — winners ride, no time box",
      `${contract.ticker} is ranked ${contract.liquidityScore}/100 and asks $${contract.ask.toFixed(2)}`,
    ],
    invalidation: `${market.chartSymbol} back ${side === "call" ? "below" : "above"} VWAP ${vwap.toFixed(2)}`,
    contract,
    market: summary,
  };
}

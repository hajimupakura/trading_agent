import { nanoid } from "nanoid";
import type { MarketState, OptionContractSnapshot, OptionsSignal } from "./types";

function withoutBars(market: MarketState): Omit<MarketState, "bars"> {
  const { bars: _bars, ...summary } = market;
  return summary;
}

export function generateOptionsSignal(
  market: MarketState,
  contracts: OptionContractSnapshot[],
): OptionsSignal {
  const eligible = contracts.filter(contract => contract.eligible);
  const call = eligible.find(contract => contract.side === "call") ?? null;
  const put = eligible.find(contract => contract.side === "put") ?? null;
  const reasons: string[] = [];
  let action: OptionsSignal["action"] = "no_trade";
  let setup: OptionsSignal["setup"] = "none";
  let contract: OptionContractSnapshot | null = null;
  let invalidation: string | null = null;
  let confidence = 0;
  const technicals = market.technicals;
  const callMomentum = (technicals.rsi14 == null || (technicals.rsi14 >= 50 && technicals.rsi14 <= 78))
    && (technicals.macd == null || technicals.macdSignal == null || technicals.macd > technicals.macdSignal)
    && (technicals.breakoutAtr == null || technicals.breakoutAtr >= 0.1);
  const putMomentum = (technicals.rsi14 == null || (technicals.rsi14 <= 50 && technicals.rsi14 >= 22))
    && (technicals.macd == null || technicals.macdSignal == null || technicals.macd < technicals.macdSignal)
    && (technicals.breakoutAtr == null || technicals.breakoutAtr >= 0.1);

  if (market.regime === "uptrend" && market.price > market.openingRangeHigh && callMomentum && call) {
    action = "enter_call";
    setup = "opening_range";
    contract = call;
    reasons.push(`${market.symbol} is above ${market.referenceLabel === "VWAP" ? "VWAP" : "its session mean"} and the 15-minute opening-range high`);
    reasons.push(`${call.ticker} ranks ${call.liquidityScore}/100 for executable liquidity`);
    if (technicals.rsi14 != null) reasons.push(`RSI ${technicals.rsi14.toFixed(1)} supports momentum without crossing the 78 overextension filter`);
    if (technicals.macd != null && technicals.macdSignal != null) reasons.push("MACD is above its signal line");
    if (technicals.breakoutAtr != null) reasons.push(`Breakout extends ${technicals.breakoutAtr.toFixed(2)} ATR beyond the opening range`);
    invalidation = `${market.symbol} closes below ${market.referenceLabel} ${market.referencePrice.toFixed(2)} or opening-range high ${market.openingRangeHigh.toFixed(2)}`;
    confidence = Math.min(90, 45 + Math.round(call.liquidityScore * 0.35));
  } else if (market.regime === "downtrend" && market.price < market.openingRangeLow && putMomentum && put) {
    action = "enter_put";
    setup = "opening_range";
    contract = put;
    reasons.push(`${market.symbol} is below ${market.referenceLabel === "VWAP" ? "VWAP" : "its session mean"} and the 15-minute opening-range low`);
    reasons.push(`${put.ticker} ranks ${put.liquidityScore}/100 for executable liquidity`);
    if (technicals.rsi14 != null) reasons.push(`RSI ${technicals.rsi14.toFixed(1)} supports downside momentum without crossing the 22 exhaustion filter`);
    if (technicals.macd != null && technicals.macdSignal != null) reasons.push("MACD is below its signal line");
    if (technicals.breakoutAtr != null) reasons.push(`Breakout extends ${technicals.breakoutAtr.toFixed(2)} ATR beyond the opening range`);
    invalidation = `${market.symbol} closes above ${market.referenceLabel} ${market.referencePrice.toFixed(2)} or opening-range low ${market.openingRangeLow.toFixed(2)}`;
    confidence = Math.min(90, 45 + Math.round(put.liquidityScore * 0.35));
  } else {
    const best = eligible[0] ?? null;
    action = best ? "watch" : "no_trade";
    contract = best;
    reasons.push(best ? "Liquid contract found, but the underlying setup is not confirmed" : "No contract passes liquidity controls");
    reasons.push(`Current ${market.symbol} regime is ${market.regime}`);
    if ((market.regime === "uptrend" && !callMomentum) || (market.regime === "downtrend" && !putMomentum)) reasons.push("Momentum is conflicting, overextended, or the breakout is smaller than 0.10 ATR");
    confidence = best ? Math.min(55, Math.round(best.liquidityScore * 0.5)) : 0;
  }

  return {
    id: nanoid(), generatedAt: Date.now(), action, setup, confidence,
    reasons, invalidation, contract, market: withoutBars(market),
  };
}

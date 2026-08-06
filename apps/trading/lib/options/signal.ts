import type { Contract, MarketState, Signal } from "./types";

export function generateSignal(market: MarketState, contracts: Contract[]): Signal {
  const eligible = contracts.filter(contract => contract.eligible);
  const summary = (({ bars: _, ...value }) => value)(market);
  const technicals = market.technicals;
  const callMomentum = (technicals.rsi14 == null || technicals.rsi14 >= 50 && technicals.rsi14 <= 78) && (technicals.macdSignal == null || technicals.macd! > technicals.macdSignal) && (technicals.breakoutAtr == null || technicals.breakoutAtr >= .1);
  const putMomentum = (technicals.rsi14 == null || technicals.rsi14 <= 50 && technicals.rsi14 >= 22) && (technicals.macdSignal == null || technicals.macd! < technicals.macdSignal) && (technicals.breakoutAtr == null || technicals.breakoutAtr >= .1);
  const call = eligible.find(contract => contract.side === "call") ?? null; const put = eligible.find(contract => contract.side === "put") ?? null;
  let action: Signal["action"] = eligible.length ? "watch" : "no_trade"; let contract = eligible[0] ?? null; let invalidation: string | null = null; const reasons: string[] = [];
  if (market.regime === "uptrend" && market.price > market.openingRangeHigh && callMomentum && call) {
    action = "enter_call"; contract = call; invalidation = `${market.chartSymbol}${market.symbol === "SPX" ? " proxy" : ""} below ${market.referenceLabel} ${market.referencePrice.toFixed(2)} or OR high ${market.openingRangeHigh.toFixed(2)}`;
    reasons.push("Trend, opening-range breakout, RSI and MACD align bullishly");
  } else if (market.regime === "downtrend" && market.price < market.openingRangeLow && putMomentum && put) {
    action = "enter_put"; contract = put; invalidation = `${market.chartSymbol}${market.symbol === "SPX" ? " proxy" : ""} above ${market.referenceLabel} ${market.referencePrice.toFixed(2)} or OR low ${market.openingRangeLow.toFixed(2)}`;
    reasons.push("Trend, opening-range breakout, RSI and MACD align bearishly");
  } else reasons.push(eligible.length ? "A liquid contract exists, but chart confluence is incomplete" : "No contract passes price and liquidity controls");
  if (contract) reasons.push(`${contract.ticker} is ranked ${contract.liquidityScore}/100 and asks $${contract.ask.toFixed(2)}`);
  const id = `${market.symbol}-${market.asOf}-${action}-${contract?.ticker ?? "none"}`;
  return { id, generatedAt:Date.now(), action, setup:action.startsWith("enter") ? "opening_range" : "none", confidence:contract ? Math.min(action.startsWith("enter") ? 90 : 55, Math.round(contract.liquidityScore * (action.startsWith("enter") ? .8 : .5))) : 0, reasons, invalidation, contract, market:summary };
}

import type { Contract, MarketState, Signal } from "./types";

export function generateSignal(market: MarketState, contracts: Contract[], options?: { deltaTarget?: number }): Signal {
  const eligible = contracts.filter(contract => contract.eligible);
  const deltaTarget = options?.deltaTarget ?? .45;
  // Deliberate contract choice: nearest |delta| to the target (missing delta = worst),
  // liquidity score breaks ties — instead of "whichever contract ranked first".
  const pickContract = (side: Contract["side"]) => {
    const candidates = eligible.filter(contract => contract.side === side);
    if (!candidates.length) return null;
    const distance = (contract: Contract) => contract.delta == null ? .5 : Math.abs(Math.abs(contract.delta) - deltaTarget);
    return candidates.slice().sort((a, b) => distance(a) - distance(b) || b.liquidityScore - a.liquidityScore)[0];
  };
  const summary = (({ bars: _, ...value }) => value)(market);
  const technicals = market.technicals; const latestBars = market.bars.slice(-2);
  const twoClosesAbove = latestBars.length === 2 && latestBars.every(bar => bar.close > market.openingRangeHigh && bar.close > market.referencePrice);
  const twoClosesBelow = latestBars.length === 2 && latestBars.every(bar => bar.close < market.openingRangeLow && bar.close < market.referencePrice);
  const breakoutControlled = technicals.breakoutAtr != null && technicals.breakoutAtr >= .1 && technicals.breakoutAtr <= .65;
  const participationConfirmed = market.symbol === "SPX" ? true : technicals.volumeConfirmation === true;
  const callMomentum = technicals.rsi14 != null && technicals.rsi14 >= 52 && technicals.rsi14 <= 72 && technicals.macd != null && technicals.macdSignal != null && technicals.macd > technicals.macdSignal && technicals.vwapSlope != null && technicals.vwapSlope > 0 && participationConfirmed && breakoutControlled && !["bearish_engulfing","shooting_star"].includes(technicals.candlePattern);
  const putMomentum = technicals.rsi14 != null && technicals.rsi14 <= 48 && technicals.rsi14 >= 28 && technicals.macd != null && technicals.macdSignal != null && technicals.macd < technicals.macdSignal && technicals.vwapSlope != null && technicals.vwapSlope < 0 && participationConfirmed && breakoutControlled && !["bullish_engulfing","hammer"].includes(technicals.candlePattern);
  const call = pickContract("call"); const put = pickContract("put");
  let action: Signal["action"] = eligible.length ? "watch" : "no_trade"; let contract = eligible[0] ?? null; let invalidation: string | null = null; const reasons: string[] = [];
  if (market.regime === "uptrend" && twoClosesAbove && callMomentum && call) {
    action = "enter_call"; contract = call; invalidation = `${market.chartSymbol} below ${market.referenceLabel} ${market.referencePrice.toFixed(2)} or OR high ${market.openingRangeHigh.toFixed(2)}`;
    reasons.push("Trend, opening-range breakout, RSI and MACD align bullishly");
  } else if (market.regime === "downtrend" && twoClosesBelow && putMomentum && put) {
    action = "enter_put"; contract = put; invalidation = `${market.chartSymbol} above ${market.referenceLabel} ${market.referencePrice.toFixed(2)} or OR low ${market.openingRangeLow.toFixed(2)}`;
    reasons.push("Trend, opening-range breakout, RSI and MACD align bearishly");
  } else {
    if (!eligible.length) reasons.push("No contract passes price and liquidity controls");
    else {
      if (market.symbol === "SPY" && technicals.volumeConfirmation !== true) reasons.push("Waiting for at least 1.2× relative one-minute volume");
      if (!twoClosesAbove && !twoClosesBelow) reasons.push(`Waiting for two closes beyond the opening range and ${market.referenceLabel.toLowerCase()}`);
      if (technicals.macd == null || technicals.macdSignal == null) reasons.push("Waiting for MACD history to complete");
      if (!breakoutControlled) reasons.push("Breakout must be 0.10–0.65 ATR beyond the range");
      if (!reasons.length) reasons.push("Trend, RSI, VWAP slope, MACD, or candle confirmation is incomplete");
    }
  }
  if (contract) reasons.push(`${contract.ticker} is ranked ${contract.liquidityScore}/100 and asks $${contract.ask.toFixed(2)}`);
  const id = `${market.symbol}-${market.asOf}-${action}-${contract?.ticker ?? "none"}`;
  return { id, generatedAt:Date.now(), action, setup:action.startsWith("enter") ? "opening_range" : "none", confidence:contract ? Math.min(action.startsWith("enter") ? 90 : 55, Math.round(contract.liquidityScore * (action.startsWith("enter") ? .7 : .5) + (action.startsWith("enter") ? 20 : 0))) : 0, reasons, invalidation, contract, market:summary };
}

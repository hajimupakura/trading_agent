import type { Contract, MarketState, Signal } from "./types";

export function generateSignal(market: MarketState, contracts: Contract[], options?: { deltaTarget?: number; minDte?: number; trendDayEnabled?: boolean }): Signal {
  const minDte = options?.minDte ?? 0;
  const eligible = contracts.filter(contract => contract.eligible && contract.dte >= minDte);
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
  let action: Signal["action"] = eligible.length ? "watch" : "no_trade"; let contract = eligible[0] ?? null; let invalidation: string | null = null; const reasons: string[] = []; let setupOverride: Signal["setup"] | null = null;
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
  // Trend-day continuation path (gated by options.trendDayEnabled — replay-only until it
  // beats the baseline on held-out sessions). On gap-and-go days price never returns to the
  // opening range, so the ORB path's 0.10-0.65 ATR extension window structurally never opens.
  // This path requires 30 minutes of persistence beyond the range, then enters on a
  // consolidation breakout with extension measured from the consolidation, not the range.
  if (!action.startsWith("enter") && options?.trendDayEnabled && market.bars.length >= 45 && technicals.atr14 != null && technicals.atr14 > 0) {
    const atr = technicals.atr14;
    const last30 = market.bars.slice(-30);
    const consolidation = market.bars.slice(-10, -1);
    const consHigh = Math.max(...consolidation.map(bar => bar.close));
    const consLow = Math.min(...consolidation.map(bar => bar.close));
    const tight = consHigh - consLow <= atr * 1.0;
    const current = market.bars.at(-1)!;
    const momentumOk = technicals.macd != null && technicals.macdSignal != null && technicals.vwapSlope != null && participationConfirmed;
    const persistentAbove = last30.every(bar => bar.close > market.openingRangeHigh) && current.close > market.referencePrice;
    const persistentBelow = last30.every(bar => bar.close < market.openingRangeLow) && current.close < market.referencePrice;
    const callTrend = persistentAbove && tight && momentumOk && technicals.macd! > technicals.macdSignal! && technicals.vwapSlope! > 0
      && technicals.rsi14 != null && technicals.rsi14 >= 50 && technicals.rsi14 <= 80
      && current.close > consHigh && current.close - consHigh <= atr * .65
      && !["bearish_engulfing","shooting_star"].includes(technicals.candlePattern) && call;
    const putTrend = persistentBelow && tight && momentumOk && technicals.macd! < technicals.macdSignal! && technicals.vwapSlope! < 0
      && technicals.rsi14 != null && technicals.rsi14 >= 20 && technicals.rsi14 <= 50
      && current.close < consLow && consLow - current.close <= atr * .65
      && !["bullish_engulfing","hammer"].includes(technicals.candlePattern) && put;
    if (callTrend) {
      action = "enter_call"; contract = call; setupOverride = "trend_continuation";
      invalidation = `${market.chartSymbol} below consolidation low ${consLow.toFixed(2)} or ${market.referenceLabel} ${market.referencePrice.toFixed(2)}`;
      reasons.length = 0; reasons.push("Trend day: 30-minute hold above the opening range, consolidation breakout with momentum aligned");
    } else if (putTrend) {
      action = "enter_put"; contract = put; setupOverride = "trend_continuation";
      invalidation = `${market.chartSymbol} above consolidation high ${consHigh.toFixed(2)} or ${market.referenceLabel} ${market.referencePrice.toFixed(2)}`;
      reasons.length = 0; reasons.push("Trend day: 30-minute hold below the opening range, consolidation breakdown with momentum aligned");
    }
  }
  // Daily context: confluence information, deliberately NOT a veto — the human decides.
  const priorDay = market.priorDay ?? null;
  let priorDayAligned: boolean | null = null;
  if (action === "enter_call" && priorDay) {
    priorDayAligned = market.price > priorDay.high;
    reasons.push(priorDayAligned ? `Breakout also clears yesterday's high ${priorDay.high.toFixed(2)}` : `Caution: still below yesterday's high ${priorDay.high.toFixed(2)} — overhead supply above`);
  } else if (action === "enter_put" && priorDay) {
    priorDayAligned = market.price < priorDay.low;
    reasons.push(priorDayAligned ? `Breakdown also clears yesterday's low ${priorDay.low.toFixed(2)}` : `Caution: still above yesterday's low ${priorDay.low.toFixed(2)} — support below`);
  }
  if (contract) reasons.push(`${contract.ticker} is ranked ${contract.liquidityScore}/100 and asks $${contract.ask.toFixed(2)}`);
  const id = `${market.symbol}-${market.asOf}-${action}-${contract?.ticker ?? "none"}`;
  // Confidence: for entries, scored from how much margin each factor passed by —
  // RSI centering in its band, breakout centering in the 0.10-0.65 ATR window,
  // relative volume above the 1.2x floor, contract liquidity, daily-context alignment.
  // For watch/no_trade it stays a dim liquidity echo.
  const clamp = (value:number, maximum:number) => Math.max(0, Math.min(maximum, value));
  let confidence = 0;
  if (contract && action.startsWith("enter")) {
    const rsiCenter = action === "enter_call" ? 62 : 38;
    const rsiScore = technicals.rsi14 == null ? 0 : clamp(15 * (1 - Math.abs(technicals.rsi14 - rsiCenter) / 10), 15);
    const breakoutScore = technicals.breakoutAtr == null ? 0 : clamp(15 * (1 - Math.abs(technicals.breakoutAtr - .375) / .275), 15);
    const volumeScore = technicals.relativeVolume == null ? 5 : clamp((technicals.relativeVolume - 1.2) / .8 * 10, 10);
    const liquidityScore = clamp(contract.liquidityScore / 10, 10);
    const dailyScore = priorDayAligned == null ? 5 : priorDayAligned ? 10 : 0;
    confidence = Math.round(clamp(45 + rsiScore + breakoutScore + volumeScore + liquidityScore + dailyScore, 100));
  } else if (contract) {
    confidence = Math.min(55, Math.round(contract.liquidityScore * .5));
  }
  return { id, generatedAt:Date.now(), action, setup:action.startsWith("enter") ? (setupOverride ?? "opening_range") : "none", confidence, reasons, invalidation, contract, market:summary };
}

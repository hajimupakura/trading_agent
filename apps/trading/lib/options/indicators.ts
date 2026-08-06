import type { Bar, Technicals, Underlying } from "./types";

export function ema(values: number[], period: number): number {
  if (!values.length) return 0;
  const k = 2 / (period + 1);
  return values.slice(1).reduce((last, value) => value * k + last * (1 - k), values[0]!);
}
function emaSeries(values: number[], period: number): number[] {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  return values.slice(1).reduce<number[]>((series, value) => [...series, value * k + series.at(-1)! * (1 - k)], [values[0]!]);
}
function rsi(values: number[], period = 14): number | null {
  if (values.length <= period) return null;
  const recent = values.slice(-period - 1);
  let gain = 0; let loss = 0;
  for (let index = 1; index < recent.length; index++) {
    const change = recent[index]! - recent[index - 1]!;
    gain += Math.max(0, change); loss += Math.max(0, -change);
  }
  if (!loss) return 100;
  return 100 - 100 / (1 + gain / loss);
}
function atr(bars: Bar[], period = 14): number | null {
  if (bars.length <= period) return null;
  const recent = bars.slice(-period - 1); let total = 0;
  for (let index = 1; index < recent.length; index++) {
    const bar = recent[index]!; const previous = recent[index - 1]!;
    total += Math.max(bar.high - bar.low, Math.abs(bar.high - previous.close), Math.abs(bar.low - previous.close));
  }
  return total / period;
}
function pattern(bars: Bar[]): Technicals["candlePattern"] {
  if (bars.length < 2) return "none";
  const previous = bars.at(-2)!; const current = bars.at(-1)!;
  const body = Math.abs(current.close - current.open); const range = Math.max(current.high - current.low, Number.EPSILON);
  if (current.close > current.open && previous.close < previous.open && current.open <= previous.close && current.close >= previous.open) return "bullish_engulfing";
  if (current.close < current.open && previous.close > previous.open && current.open >= previous.close && current.close <= previous.open) return "bearish_engulfing";
  if ((Math.min(current.open, current.close) - current.low) / range > .6 && body / range < .35) return "hammer";
  if ((current.high - Math.max(current.open, current.close)) / range > .6 && body / range < .35) return "shooting_star";
  return "none";
}
export function calculateTechnicals(bars: Bar[], underlying: Underlying, openingHigh: number, openingLow: number): Technicals {
  const closes = bars.map(bar => bar.close); const current = bars.at(-1)!; const atr14 = atr(bars);
  const twelve = emaSeries(closes, 12); const twentySix = emaSeries(closes, 26);
  const series = closes.map((_, index) => twelve[index]! - twentySix[index]!);
  const macd = closes.length >= 26 ? series.at(-1)! : null;
  const macdSignal = closes.length >= 35 ? ema(series.slice(25), 9) : null;
  const last20 = closes.slice(-20); const mean = last20.reduce((sum, value) => sum + value, 0) / Math.max(1, last20.length);
  const deviation = Math.sqrt(last20.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, last20.length));
  const distance = current.close > openingHigh ? current.close - openingHigh : current.close < openingLow ? openingLow - current.close : 0;
  const volumes = bars.slice(-21, -1).map(bar => bar.volume).filter(Boolean);
  const averageVolume = volumes.reduce((sum, value) => sum + value, 0) / Math.max(1, volumes.length);
  let cumulativeVolume = 0; let cumulativeValue = 0;
  const sessionVwap = bars.map(bar => {
    cumulativeVolume += bar.volume; cumulativeValue += (bar.vwap ?? bar.close) * bar.volume;
    return cumulativeVolume ? cumulativeValue / cumulativeVolume : bar.close;
  });
  const vwapSlope = sessionVwap.length >= 6 ? sessionVwap.at(-1)! - sessionVwap.at(-6)! : null;
  return {
    ema8: ema(closes.slice(-30), 8), ema21: ema(closes.slice(-30), 21), rsi14: rsi(closes), atr14, macd, macdSignal,
    bollingerPosition: last20.length >= 20 && deviation ? (current.close - mean) / (2 * deviation) : null,
    breakoutAtr: atr14 ? distance / atr14 : null,
    volumeConfirmation: volumes.length >= 5 ? current.volume >= averageVolume * 1.2 : null, vwapSlope,
    candlePattern: pattern(bars),
  };
}

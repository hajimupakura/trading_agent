import { SMA, RSI } from "technicalindicators";
import { getFinnhubHistoricalCandles } from "./finnhubService";

export interface TechnicalIndicatorData {
  time: number;
  value: number;
}

export async function getSMA(
  symbol: string,
  interval: string, // e.g., 'D', 'W', 'M'
  period: number, // e.g., 20, 50, 200
  from: number, // Unix timestamp
  to: number // Unix timestamp
): Promise<TechnicalIndicatorData[] | null> {
  const candles = await getFinnhubHistoricalCandles(symbol, interval, from, to);
  if (!candles || candles.close.length < period) {
    return null;
  }

  const sma = SMA.calculate({ period, values: candles.close });

  // Match SMA values with their corresponding timestamps
  const result: TechnicalIndicatorData[] = [];
  for (let i = 0; i < sma.length; i++) {
    result.push({
      time: candles.timestamp[candles.timestamp.length - sma.length + i],
      value: sma[i],
    });
  }
  return result;
}

export async function getRSI(
  symbol: string,
  interval: string, // e.g., 'D', 'W', 'M'
  period: number, // e.g., 14
  from: number, // Unix timestamp
  to: number // Unix timestamp
): Promise<TechnicalIndicatorData[] | null> {
  const candles = await getFinnhubHistoricalCandles(symbol, interval, from, to);
  if (!candles || candles.close.length < period) {
    return null;
  }

  const rsi = RSI.calculate({ period, values: candles.close });

  // Match RSI values with their corresponding timestamps
  const result: TechnicalIndicatorData[] = [];
  for (let i = 0; i < rsi.length; i++) {
    result.push({
      time: candles.timestamp[candles.timestamp.length - rsi.length + i],
      value: rsi[i],
    });
  }
  return result;
}

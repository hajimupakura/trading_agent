import { RSI, MACD, SMA, BollingerBands } from "technicalindicators";
import { getHistoricalPrices } from "./stockPriceService";

/**
 * Technical Analysis Service
 * Computes standard indicators from historical price data.
 * Used to ground AI predictions with quantitative signals.
 */

export interface TechnicalIndicators {
  symbol: string;
  price: number;
  rsi14: number | null;
  macd: {
    macd: number;
    signal: number;
    histogram: number;
  } | null;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  bollingerBands: {
    upper: number;
    middle: number;
    lower: number;
  } | null;
  signals: string[]; // Human-readable signal descriptions
}

export interface HistoricalBar {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Compute technical indicators for a single stock.
 * Fetches 1 year of daily data from Yahoo Finance for sufficient history.
 */
export async function computeIndicators(symbol: string): Promise<TechnicalIndicators | null> {
  const bars = await getHistoricalPrices(symbol, "1y") as HistoricalBar[];

  if (!bars || bars.length < 50) {
    console.warn(`[TA] Insufficient data for ${symbol}: ${bars?.length ?? 0} bars`);
    return null;
  }

  const closes = bars.map(b => b.close);
  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);
  const currentPrice = closes[closes.length - 1]!;

  // RSI (14-period)
  const rsiValues = RSI.calculate({ values: closes, period: 14 });
  const rsi14 = rsiValues.length > 0 ? rsiValues[rsiValues.length - 1]! : null;

  // MACD (12, 26, 9)
  const macdValues = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  const macdLatest = macdValues.length > 0 ? macdValues[macdValues.length - 1] : null;
  const macd = macdLatest && macdLatest.MACD != null && macdLatest.signal != null && macdLatest.histogram != null
    ? { macd: macdLatest.MACD, signal: macdLatest.signal, histogram: macdLatest.histogram }
    : null;

  // SMAs
  const sma20Values = SMA.calculate({ values: closes, period: 20 });
  const sma50Values = SMA.calculate({ values: closes, period: 50 });
  const sma200Values = SMA.calculate({ values: closes, period: 200 });

  const sma20 = sma20Values.length > 0 ? sma20Values[sma20Values.length - 1]! : null;
  const sma50 = sma50Values.length > 0 ? sma50Values[sma50Values.length - 1]! : null;
  const sma200 = sma200Values.length > 0 ? sma200Values[sma200Values.length - 1]! : null;

  // Bollinger Bands (20, 2)
  const bbValues = BollingerBands.calculate({
    values: closes,
    period: 20,
    stdDev: 2,
  });
  const bbLatest = bbValues.length > 0 ? bbValues[bbValues.length - 1] : null;
  const bollingerBands = bbLatest
    ? { upper: bbLatest.upper, middle: bbLatest.middle, lower: bbLatest.lower }
    : null;

  // Generate human-readable signals
  const signals = generateSignals(currentPrice, rsi14, macd, sma20, sma50, sma200, bollingerBands);

  return {
    symbol: symbol.toUpperCase(),
    price: currentPrice,
    rsi14,
    macd,
    sma20,
    sma50,
    sma200,
    bollingerBands,
    signals,
  };
}

/**
 * Compute indicators for multiple stocks in parallel.
 */
export async function computeMultipleIndicators(
  symbols: string[]
): Promise<Map<string, TechnicalIndicators>> {
  const results = new Map<string, TechnicalIndicators>();

  // Process in batches of 5 to avoid rate limiting
  const batchSize = 5;
  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(
      batch.map(s => computeIndicators(s))
    );

    batchResults.forEach((result, idx) => {
      if (result.status === "fulfilled" && result.value) {
        results.set(batch[idx]!, result.value);
      }
    });

    // Small delay between batches
    if (i + batchSize < symbols.length) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  return results;
}

function generateSignals(
  price: number,
  rsi: number | null,
  macd: { macd: number; signal: number; histogram: number } | null,
  sma20: number | null,
  sma50: number | null,
  sma200: number | null,
  bb: { upper: number; middle: number; lower: number } | null,
): string[] {
  const signals: string[] = [];

  // RSI signals
  if (rsi != null) {
    if (rsi >= 70) signals.push(`RSI overbought (${rsi.toFixed(1)})`);
    else if (rsi <= 30) signals.push(`RSI oversold (${rsi.toFixed(1)})`);
    else if (rsi >= 60) signals.push(`RSI bullish momentum (${rsi.toFixed(1)})`);
    else if (rsi <= 40) signals.push(`RSI bearish momentum (${rsi.toFixed(1)})`);
  }

  // MACD signals
  if (macd) {
    if (macd.histogram > 0 && macd.macd > macd.signal) {
      signals.push("MACD bullish crossover");
    } else if (macd.histogram < 0 && macd.macd < macd.signal) {
      signals.push("MACD bearish crossover");
    }
  }

  // SMA trend signals
  if (sma20 != null && sma50 != null) {
    if (price > sma20 && sma20 > sma50) {
      signals.push("Price above SMA20 & SMA50 (uptrend)");
    } else if (price < sma20 && sma20 < sma50) {
      signals.push("Price below SMA20 & SMA50 (downtrend)");
    }
  }

  // Golden cross / Death cross
  if (sma50 != null && sma200 != null) {
    // Check if SMA50 recently crossed above SMA200
    if (sma50 > sma200 && (sma50 - sma200) / sma200 < 0.02) {
      signals.push("Near golden cross (SMA50 crossing above SMA200)");
    } else if (sma50 < sma200 && (sma200 - sma50) / sma200 < 0.02) {
      signals.push("Near death cross (SMA50 crossing below SMA200)");
    }
  }

  // Bollinger Band signals
  if (bb) {
    if (price >= bb.upper) {
      signals.push("Price at upper Bollinger Band (potential resistance)");
    } else if (price <= bb.lower) {
      signals.push("Price at lower Bollinger Band (potential support)");
    }

    // Squeeze detection (bands narrowing)
    const bandwidth = (bb.upper - bb.lower) / bb.middle;
    if (bandwidth < 0.04) {
      signals.push("Bollinger Band squeeze (low volatility, breakout imminent)");
    }
  }

  return signals;
}

/**
 * Format indicators as a concise string for LLM prompts.
 */
export function formatIndicatorsForPrompt(indicators: TechnicalIndicators): string {
  const lines: string[] = [
    `${indicators.symbol}: $${indicators.price.toFixed(2)}`,
  ];

  if (indicators.rsi14 != null) {
    lines.push(`  RSI(14): ${indicators.rsi14.toFixed(1)}`);
  }
  if (indicators.macd) {
    lines.push(`  MACD: ${indicators.macd.macd.toFixed(2)} / Signal: ${indicators.macd.signal.toFixed(2)} / Hist: ${indicators.macd.histogram.toFixed(2)}`);
  }
  if (indicators.sma20 != null) lines.push(`  SMA20: $${indicators.sma20.toFixed(2)}`);
  if (indicators.sma50 != null) lines.push(`  SMA50: $${indicators.sma50.toFixed(2)}`);
  if (indicators.sma200 != null) lines.push(`  SMA200: $${indicators.sma200.toFixed(2)}`);
  if (indicators.bollingerBands) {
    lines.push(`  Bollinger: $${indicators.bollingerBands.lower.toFixed(2)} / $${indicators.bollingerBands.middle.toFixed(2)} / $${indicators.bollingerBands.upper.toFixed(2)}`);
  }
  if (indicators.signals.length > 0) {
    lines.push(`  Signals: ${indicators.signals.join("; ")}`);
  }

  return lines.join("\n");
}

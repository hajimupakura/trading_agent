import YahooFinance from "yahoo-finance2";
import { getFinnhubQuote, getFinnhubMultipleQuotes, searchFinnhubStocks } from "./finnhubService";

// yahoo-finance2 v3: must instantiate the class, not use it as a singleton
const yahooFinance = new YahooFinance();

/**
 * Stock Price Service using Yahoo Finance API (unofficial, free)
 * Provides real-time stock quotes and price data
 */

export interface StockQuote {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
  volume: number;
  marketCap?: number;
  high: number;
  low: number;
  open: number;
  previousClose: number;
  timestamp: Date;
}

/**
 * Get current quote for a single stock
 * Uses Finnhub as primary source, falls back to Yahoo Finance if Finnhub fails
 */
export async function getStockQuote(symbol: string): Promise<StockQuote | null> {
  // Try Finnhub first (official API, 60 calls/min)
  try {
    const finnhubQuote = await getFinnhubQuote(symbol);
    if (finnhubQuote) {
      return {
        symbol: finnhubQuote.symbol,
        price: finnhubQuote.currentPrice,
        change: finnhubQuote.change,
        changePercent: finnhubQuote.percentChange,
        volume: 0, // Finnhub doesn't provide volume in quote endpoint
        high: finnhubQuote.high,
        low: finnhubQuote.low,
        open: finnhubQuote.open,
        previousClose: finnhubQuote.previousClose,
        timestamp: finnhubQuote.timestamp,
      };
    }
  } catch (error) {
    console.warn(`[Stock Price] Finnhub failed for ${symbol}, trying Yahoo Finance...`);
  }

  // Fallback to Yahoo Finance (unofficial API)
  try {
    const quote = await yahooFinance.quote(symbol) as any;
    
    if (!quote || !quote.regularMarketPrice) {
      console.warn(`[Stock Price] No data found for ${symbol}`);
      return null;
    }

    return {
      symbol: quote.symbol,
      price: quote.regularMarketPrice,
      change: quote.regularMarketChange || 0,
      changePercent: quote.regularMarketChangePercent || 0,
      volume: quote.regularMarketVolume || 0,
      marketCap: quote.marketCap,
      high: quote.regularMarketDayHigh || quote.regularMarketPrice,
      low: quote.regularMarketDayLow || quote.regularMarketPrice,
      open: quote.regularMarketOpen || quote.regularMarketPrice,
      previousClose: (quote as any).regularMarketPreviousClose || quote.regularMarketPrice,
      timestamp: new Date(),
    };
  } catch (error) {
    console.error(`[Stock Price] Error fetching quote for ${symbol}:`, error);
    return null;
  }
}

/**
 * Get quotes for multiple stocks (batch)
 */
export async function getMultipleStockQuotes(symbols: string[]): Promise<Map<string, StockQuote>> {
  const quotes = new Map<string, StockQuote>();
  
  // Process in batches of 10 to avoid rate limiting
  const batchSize = 10;
  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    
    const results = await Promise.allSettled(
      batch.map(symbol => getStockQuote(symbol))
    );
    
    results.forEach((result, index) => {
      if (result.status === "fulfilled" && result.value) {
        quotes.set(batch[index]!, result.value);
      }
    });
    
    // Small delay between batches
    if (i + batchSize < symbols.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  return quotes;
}

/**
 * Get historical price data for a stock.
 * Uses Yahoo Finance chart API (yahoo-finance2 v3 requires instantiation + chart module).
 */
export async function getHistoricalPrices(
  symbol: string,
  period: "1d" | "5d" | "1mo" | "3mo" | "6mo" | "1y" = "1mo"
) {
  try {
    const result = await (yahooFinance as any).chart(symbol, {
      period1: getPeriodStartDate(period),
      period2: new Date(),
      interval: "1d",
    });
    const quotes = result?.quotes;
    if (quotes && Array.isArray(quotes)) {
      return quotes
        .filter((q: any) => q.close != null)
        .map((q: any) => ({
          date: new Date(q.date),
          open: q.open ?? q.close,
          high: q.high ?? q.close,
          low: q.low ?? q.close,
          close: q.close,
          volume: q.volume ?? 0,
        }));
    }
  } catch (error) {
    console.error(`[Stock Price] Error fetching historical data for ${symbol}:`, (error as any)?.message);
  }
  return [];
}

/**
 * Search for stock symbols by company name
 */
export async function searchStocks(query: string): Promise<Array<{ symbol: string; name: string }>> {
  try {
    const results = await yahooFinance.search(query) as any;
    
    if (!results || !results.quotes) {
      return [];
    }
    
    return results.quotes
      .filter((q: any) => q.quoteType === "EQUITY")
      .slice(0, 10)
      .map((q: any) => ({
        symbol: q.symbol,
        name: q.longname || q.shortname || q.symbol,
      }));
  } catch (error) {
    console.error(`[Stock Price] Error searching for "${query}":`, error);
    return [];
  }
}

function periodToDays(period: string): number {
  switch (period) {
    case "1d": return 2;
    case "5d": return 7;
    case "1mo": return 35;
    case "3mo": return 95;
    case "6mo": return 185;
    case "1y": return 370;
    default: return 35;
  }
}

function getPeriodStartDate(period: string): Date {
  const now = new Date();
  return new Date(now.getTime() - periodToDays(period) * 24 * 60 * 60 * 1000);
}

/**
 * Validate if a stock symbol exists
 */
export async function validateStockSymbol(symbol: string): Promise<boolean> {
  try {
    const quote = await yahooFinance.quote(symbol) as any;
    return !!quote && !!quote.regularMarketPrice;
  } catch {
    return false;
  }
}

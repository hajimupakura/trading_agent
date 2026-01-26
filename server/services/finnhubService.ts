// @ts-ignore - No type definitions available for finnhub
import * as finnhub from "finnhub";

/**
 * Finnhub API Service
 * Provides real-time stock quotes, company news, and financial data
 * API Key: d5ro8fhr01qj5oil5r6gd5ro8fhr01qj5oil5r70
 * Rate limit: 60 calls/minute (free tier)
 */

const apiKey = process.env.FINNHUB_API_KEY || "d5ro8fhr01qj5oil5r6gd5ro8fhr01qj5oil5r70";

let api: any = null;

function getApi() {
  if (api) {
    return api;
  }

  try {
    // Corrected initialization: Instantiate DefaultApi and configure it.
    // The ApiClient is implicitly managed by the DefaultApi constructor.
    const client = new (finnhub as any).DefaultApi();
    
    // The authentication is now set on the client instance itself.
    client.apiClient.authentications["api_key"].apiKey = apiKey;
    
    api = client;
    console.log("[Finnhub] API client initialized successfully.");
  } catch (error) {
    console.error("[Finnhub] Failed to initialize API client:", error);
    api = null;
  }

  return api;
}

export interface FinnhubQuote {
  symbol: string;
  currentPrice: number;
  change: number;
  percentChange: number;
  high: number;
  low: number;
  open: number;
  previousClose: number;
  timestamp: Date;
}

export interface FinnhubNews {
  category: string;
  datetime: number;
  headline: string;
  id: number;
  image: string;
  related: string;
  source: string;
  summary: string;
  url: string;
}

/**
 * Get real-time quote for a stock
 */
export async function getFinnhubQuote(symbol: string): Promise<FinnhubQuote | null> {
  const api = getApi();
  if (!api) {
    console.warn("[Finnhub] API not initialized, skipping quote request");
    return null;
  }
  
  return new Promise((resolve) => {
    api.quote(symbol, (error: any, data: any) => {
      if (error) {
        console.error(`[Finnhub] Error fetching quote for ${symbol}:`, error);
        resolve(null);
        return;
      }

      if (!data || data.c === 0) {
        console.warn(`[Finnhub] No data found for ${symbol}`);
        resolve(null);
        return;
      }

      resolve({
        symbol,
        currentPrice: data.c, // Current price
        change: data.d, // Change
        percentChange: data.dp, // Percent change
        high: data.h, // High price of the day
        low: data.l, // Low price of the day
        open: data.o, // Open price of the day
        previousClose: data.pc, // Previous close price
        timestamp: new Date(data.t * 1000), // Timestamp
      });
    });
  });
}

/**
 * Get company news for a specific stock
 */
export async function getFinnhubCompanyNews(
  symbol: string,
  from: Date,
  to: Date
): Promise<FinnhubNews[]> {
  const api = getApi();
  if (!api) return [];
  
  return new Promise((resolve) => {
    const fromStr = from.toISOString().split("T")[0];
    const toStr = to.toISOString().split("T")[0];

    api.companyNews(symbol, fromStr!, toStr!, (error: any, data: any) => {
      if (error) {
        console.error(`[Finnhub] Error fetching news for ${symbol}:`, error);
        resolve([]);
        return;
      }

      resolve(data || []);
    });
  });
}

/**
 * Get market news (general financial news)
 */
export async function getFinnhubMarketNews(category: string = "general"): Promise<FinnhubNews[]> {
  return new Promise((resolve) => {
    api.marketNews(category, {}, (error: any, data: any) => {
      if (error) {
        console.error(`[Finnhub] Error fetching market news:`, error);
        resolve([]);
        return;
      }

      resolve(data || []);
    });
  });
}

/**
 * Get company profile
 */
export async function getFinnhubCompanyProfile(symbol: string): Promise<any> {
  const api = getApi();
  if (!api) return null;
  
  return new Promise((resolve) => {
    api.companyProfile2({ symbol }, (error: any, data: any) => {
      if (error) {
        console.error(`[Finnhub] Error fetching company profile for ${symbol}:`, error);
        resolve(null);
        return;
      }

      resolve(data);
    });
  });
}

/**
 * Search for stocks by query
 */
export async function searchFinnhubStocks(query: string): Promise<Array<{ symbol: string; description: string }>> {
  const api = getApi();
  if (!api) return [];
  
  return new Promise((resolve) => {
    api.symbolSearch(query, (error: any, data: any) => {
      if (error) {
        console.error(`[Finnhub] Error searching for "${query}":`, error);
        resolve([]);
        return;
      }

      if (!data || !data.result) {
        resolve([]);
        return;
      }

      resolve(
        data.result.slice(0, 10).map((item: any) => ({
          symbol: item.symbol,
          description: item.description,
        }))
      );
    });
  });
}

/**
 * Get multiple quotes in batch (with rate limiting)
 */
export async function getFinnhubMultipleQuotes(symbols: string[]): Promise<Map<string, FinnhubQuote>> {
  const quotes = new Map<string, FinnhubQuote>();
  
  // Rate limit: 60 calls/minute = 1 call per second
  for (const symbol of symbols) {
    const quote = await getFinnhubQuote(symbol);
    if (quote) {
      quotes.set(symbol, quote);
    }
    
    // Wait 1 second between calls to respect rate limit
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  return quotes;
}


export interface FinnhubFinancials {
  symbol: string;
  marketCap: number;
  peRatio: number;
  eps: number;
  dividendYield: number;
  beta: number;
  high52Week: number;
  low52Week: number;
}

/**
 * Get basic financial data for a stock
 */
export async function getFinnhubBasicFinancials(symbol: string): Promise<FinnhubFinancials | null> {
  const api = getApi();
  if (!api) {
    console.warn("[Finnhub] API not initialized, skipping financials request");
    return null;
  }
  
  return new Promise((resolve) => {
    api.companyBasicFinancials(symbol, (error: any, data: any) => {
      if (error) {
        console.error(`[Finnhub] Error fetching financials for ${symbol}:`, error);
        resolve(null);
        return;
      }

      if (!data || Object.keys(data).length === 0) {
        console.warn(`[Finnhub] No financials data found for ${symbol}`);
        resolve(null);
        return;
      }

      const metric = data.metric || {};
      resolve({
        symbol,
        marketCap: metric.marketCapitalization || 0,
        peRatio: metric["peNormalizedAnnual"] || 0,
        eps: metric["epsGrowth5Y"] || 0, // Using 5Y growth as a proxy, you might want a different EPS field
        dividendYield: metric.dividendYieldIndicatedAnnual || 0,
        beta: metric.beta || 0,
        high52Week: metric["52WeekHigh"] || 0,
        low52Week: metric["52WeekLow"] || 0,
      });
    });
  });
}


export interface FinnhubCandleData {
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
  timestamp: number[]; // Unix timestamp
  symbol: string;
  resolution: string;
}

/**
 * Get historical candle data for a stock
 * @param symbol Stock symbol
 * @param resolution Supported resolutions: 1, 5, 15, 30, 60, D, W, M
 * @param from Unix timestamp. Interval initial value.
 * @param to Unix timestamp. Interval final value.
 */
export async function getFinnhubHistoricalCandles(
  symbol: string,
  resolution: string,
  from: number,
  to: number
): Promise<FinnhubCandleData | null> {
  const api = getApi();
  if (!api) {
    console.warn("[Finnhub] API not initialized, skipping historical candles request");
    return null;
  }
  
  return new Promise((resolve) => {
    api.stockCandles(symbol, resolution, from, to, (error: any, data: any) => {
      if (error) {
        console.error(`[Finnhub] Error fetching historical candles for ${symbol}:`, error);
        resolve(null);
        return;
      }

      if (!data || data.s !== "ok") {
        console.warn(`[Finnhub] No historical candles data found for ${symbol} with resolution ${resolution}`);
        resolve(null);
        return;
      }

      resolve({
        open: data.o,
        high: data.h,
        low: data.l,
        close: data.c,
        volume: data.v,
        timestamp: data.t,
        symbol,
        resolution,
      });
    });
  });
}

/**
 * Get news for watchlist stocks (last 7 days)
 */
export async function getWatchlistNews(symbols: string[]): Promise<Map<string, FinnhubNews[]>> {
  const newsMap = new Map<string, FinnhubNews[]>();
  const to = new Date();
  const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000); // 7 days ago
  
  for (const symbol of symbols) {
    const news = await getFinnhubCompanyNews(symbol, from, to);
    if (news.length > 0) {
      newsMap.set(symbol, news);
    }
    
    // Wait 1 second between calls
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  return newsMap;
}

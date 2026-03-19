/**
 * Finnhub API Service — direct REST calls (no SDK)
 * Rate limit: 60 calls/minute on free tier
 */

const BASE = "https://finnhub.io/api/v1";

function key(): string {
  return process.env.FINNHUB_API_KEY || "";
}

function finnhubFetch(path: string, params: Record<string, string> = {}): Promise<any> {
  const apiKey = key();
  if (!apiKey) {
    console.error("[Finnhub] FINNHUB_API_KEY not set");
    return Promise.resolve(null);
  }
  const qs = new URLSearchParams({ ...params, token: apiKey }).toString();
  return fetch(`${BASE}${path}?${qs}`, { signal: AbortSignal.timeout(8000) })
    .then(r => r.ok ? r.json() : null)
    .catch(err => { console.error(`[Finnhub] fetch error ${path}:`, err.message); return null; });
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

export async function getFinnhubQuote(symbol: string): Promise<FinnhubQuote | null> {
  const data = await finnhubFetch("/quote", { symbol });
  if (!data || data.c == null || data.c === 0) return null;
  return {
    symbol,
    currentPrice: data.c,
    change: data.d,
    percentChange: data.dp,
    high: data.h,
    low: data.l,
    open: data.o,
    previousClose: data.pc,
    timestamp: new Date(data.t * 1000),
  };
}

export async function getFinnhubCompanyNews(symbol: string, from: Date, to: Date): Promise<FinnhubNews[]> {
  const data = await finnhubFetch("/company-news", {
    symbol,
    from: from.toISOString().split("T")[0]!,
    to: to.toISOString().split("T")[0]!,
  });
  return Array.isArray(data) ? data : [];
}

export async function getFinnhubMarketNews(category = "general"): Promise<FinnhubNews[]> {
  const data = await finnhubFetch("/news", { category });
  return Array.isArray(data) ? data : [];
}

export async function getFinnhubCompanyProfile(symbol: string): Promise<any> {
  return finnhubFetch("/stock/profile2", { symbol });
}

export async function searchFinnhubStocks(query: string): Promise<Array<{ symbol: string; description: string }>> {
  const data = await finnhubFetch("/search", { q: query });
  if (!data?.result) return [];
  return data.result.slice(0, 10).map((item: any) => ({
    symbol: item.symbol,
    description: item.description,
  }));
}

export async function getFinnhubMultipleQuotes(symbols: string[]): Promise<Map<string, FinnhubQuote>> {
  const quotes = new Map<string, FinnhubQuote>();
  for (const symbol of symbols) {
    const quote = await getFinnhubQuote(symbol);
    if (quote) quotes.set(symbol, quote);
    await new Promise(r => setTimeout(r, 200)); // ~5 req/s, well within 60/min
  }
  return quotes;
}

export async function getWatchlistNews(symbols: string[]): Promise<Map<string, FinnhubNews[]>> {
  const newsMap = new Map<string, FinnhubNews[]>();
  const to = new Date();
  const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
  for (const symbol of symbols) {
    const news = await getFinnhubCompanyNews(symbol, from, to);
    if (news.length > 0) newsMap.set(symbol, news);
    await new Promise(r => setTimeout(r, 200));
  }
  return newsMap;
}

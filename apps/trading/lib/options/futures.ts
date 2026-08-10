import "server-only";

// Overnight futures glimpse (ES/NQ/YM): primary source is Massive's futures snapshot
// (front month picked by session volume; Starter tier data is ~10-minute delayed).
// If the account has no futures entitlement yet, fall back to Yahoo's public chart
// quotes so the dashboard still shows direction while markets are closed.

export interface FuturesQuote {
  label: string; product: string; ticker: string; price: number;
  changePct: number | null; prevSettle: number | null; asOf: number;
  source: "massive" | "yahoo";
}
export interface FuturesGlimpse { rows: FuturesQuote[]; note: string | null; asOf: number }

const PRODUCTS = [
  { code: "ES", label: "S&P 500", yahoo: "ES=F" },
  { code: "NQ", label: "Nasdaq 100", yahoo: "NQ=F" },
  { code: "YM", label: "Dow", yahoo: "YM=F" },
] as const;

async function fromMassive(): Promise<FuturesQuote[]> {
  const key = process.env.MASSIVE_API_KEY;
  if (!key) throw new Error("MASSIVE_API_KEY is not configured");
  const url = new URL("https://api.massive.com/futures/v1/snapshot");
  url.searchParams.set("product_code.any_of", PRODUCTS.map(product => product.code).join(","));
  url.searchParams.set("limit", "500");
  url.searchParams.set("apiKey", key);
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Massive futures ${response.status}`);
  const payload = await response.json() as { results?: Array<{
    ticker?: string; product_code?: string;
    last_trade?: { price?: number; last_updated?: number };
    session?: { volume?: number; settlement_price?: number };
  }> };
  return PRODUCTS.flatMap(product => {
    const front = (payload.results ?? [])
      .filter(row => row.product_code === product.code && (row.last_trade?.price ?? 0) > 0)
      .sort((a, b) => (b.session?.volume ?? 0) - (a.session?.volume ?? 0))[0];
    if (!front?.last_trade?.price) return [];
    const prevSettle = front.session?.settlement_price ?? null;
    return [{
      label: product.label, product: product.code, ticker: front.ticker ?? product.code,
      price: front.last_trade.price,
      changePct: prevSettle ? (front.last_trade.price / prevSettle - 1) * 100 : null,
      prevSettle,
      // last_updated is epoch nanoseconds on the snapshot endpoint
      asOf: front.last_trade.last_updated ? Math.round(front.last_trade.last_updated / 1e6) : Date.now(),
      source: "massive" as const,
    }];
  });
}

async function fromYahoo(): Promise<FuturesQuote[]> {
  const quotes = await Promise.all(PRODUCTS.map(async product => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(product.yahoo)}?interval=5m&range=1d`;
    const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return null;
    const payload = await response.json() as { chart?: { result?: Array<{ meta?: { regularMarketPrice?: number; previousClose?: number; chartPreviousClose?: number; regularMarketTime?: number } }> } };
    const meta = payload.chart?.result?.[0]?.meta;
    if (!meta?.regularMarketPrice) return null;
    const prevSettle = meta.previousClose ?? meta.chartPreviousClose ?? null;
    const quote: FuturesQuote = {
      label: product.label, product: product.code, ticker: product.yahoo, price: meta.regularMarketPrice,
      changePct: prevSettle ? (meta.regularMarketPrice / prevSettle - 1) * 100 : null,
      prevSettle, asOf: meta.regularMarketTime ? meta.regularMarketTime * 1000 : Date.now(),
      source: "yahoo",
    };
    return quote;
  }));
  const rows = quotes.filter((quote): quote is FuturesQuote => quote != null);
  if (!rows.length) throw new Error("No futures quotes from Yahoo");
  return rows;
}

export async function getFuturesGlimpse(): Promise<FuturesGlimpse> {
  try {
    const rows = await fromMassive();
    if (rows.length) return { rows, note: null, asOf: Date.now() };
    throw new Error("empty snapshot");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const rows = await fromYahoo();
    return { rows, note: `Massive futures unavailable (${reason}) — showing Yahoo delayed quotes`, asOf: Date.now() };
  }
}

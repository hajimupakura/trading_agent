import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// Market news (Phase 1, 2026-11-23): Benzinga headlines via the Alpaca News API,
// on the same keys the chains ride. DESIGN PRINCIPLE: news is CONTEXT, never a
// signal — headlines annotate the moments the human already acts (fire cards,
// dip checks, the `news` command, the Morning Card) so decisions are informed.
// Nothing here gates or generates entries; Phase 3 logging decides with numbers
// whether news ever deserves a vote. One unfiltered pull per cron tick covers
// both symbol news and world/macro (Benzinga tags symbols; macro arrives untagged
// or tagged SPY).

const NEWS_URL = "https://data.alpaca.markets/v1beta1/news";

export async function ingestMarketNews(): Promise<{ stored: number }> {
  const key = process.env.ALPACA_API_KEY_ID; const secret = process.env.ALPACA_API_SECRET_KEY;
  if (!key || !secret) return { stored: 0 };
  const admin = createAdminClient();
  // Cursor: newest stored published_at minus a minute of overlap (upsert dedupes).
  const { data: newest } = await admin.from("market_news").select("published_at").order("published_at", { ascending: false }).limit(1).maybeSingle();
  const start = newest?.published_at ? new Date(Date.parse(String(newest.published_at)) - 60_000) : new Date(Date.now() - 12 * 3_600_000);
  const url = new URL(NEWS_URL);
  url.searchParams.set("start", start.toISOString());
  url.searchParams.set("limit", "50");
  url.searchParams.set("sort", "desc");
  const response = await fetch(url, { headers: { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret }, signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`Alpaca news ${response.status}`);
  const payload = await response.json() as { news?: Array<{ id: number | string; headline?: string; summary?: string; source?: string; url?: string; symbols?: string[]; created_at?: string; updated_at?: string }> };
  const rows = (payload.news ?? [])
    .filter(item => item.id != null && item.headline)
    .map(item => ({
      news_id: String(item.id), headline: String(item.headline).slice(0, 500),
      summary: item.summary ? String(item.summary).slice(0, 1000) : null,
      source: item.source ?? "benzinga", url: item.url ?? null,
      symbols: (item.symbols ?? []).map(symbol => String(symbol).toUpperCase()),
      published_at: item.created_at ?? item.updated_at ?? new Date().toISOString(),
    }));
  if (!rows.length) return { stored: 0 };
  const { error } = await admin.from("market_news").upsert(rows, { onConflict: "news_id", ignoreDuplicates: true });
  if (error) throw new Error(`news persistence: ${error.message}`);
  return { stored: rows.length };
}

export type NewsItem = { headline: string; source: string | null; url: string | null; publishedAt: number };

const symbolFilter = (symbol: string): string[] => ["SPX", "SPXW", "SPY"].includes(symbol.toUpperCase()) ? ["SPY", "SPX"] : [symbol.toUpperCase()];

// Freshest headline for a symbol within maxAgeMs, or null — callers print "no fresh
// news" themselves so a dip with no story is NAMED as storyless.
export async function latestNewsFor(symbol: string, maxAgeMs = 3 * 3_600_000): Promise<NewsItem | null> {
  const { data } = await createAdminClient().from("market_news").select("headline,source,url,published_at")
    .overlaps("symbols", symbolFilter(symbol))
    .gte("published_at", new Date(Date.now() - maxAgeMs).toISOString())
    .order("published_at", { ascending: false }).limit(1).maybeSingle();
  if (!data) return null;
  return { headline: String(data.headline), source: data.source ? String(data.source) : null, url: data.url ? String(data.url) : null, publishedAt: Date.parse(String(data.published_at)) };
}

export async function recentNews(symbol: string | null, limit = 5): Promise<NewsItem[]> {
  let query = createAdminClient().from("market_news").select("headline,source,url,published_at")
    .gte("published_at", new Date(Date.now() - 24 * 3_600_000).toISOString())
    .order("published_at", { ascending: false }).limit(limit);
  if (symbol) query = query.overlaps("symbols", symbolFilter(symbol));
  const { data } = await query;
  return (data ?? []).map(row => ({ headline: String(row.headline), source: row.source ? String(row.source) : null, url: row.url ? String(row.url) : null, publishedAt: Date.parse(String(row.published_at)) }));
}

export const newsAge = (publishedAt: number): string => {
  const minutes = Math.max(0, Math.round((Date.now() - publishedAt) / 60_000));
  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
};

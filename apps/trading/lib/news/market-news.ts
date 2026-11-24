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
  // OLDEST-FIRST + PAGINATED (bug fix 2026-11-23): the original pull asked for the
  // 50 NEWEST since the cursor with no pagination — in any busy window with >50
  // items the OLDER ones were silently dropped and the cursor jumped past them
  // forever. Steady PR drip survived; clustered hot-name news (the NVDA/MU catalyst
  // bursts) was exactly what got eaten — 11/23 stored 496 headlines with ZERO
  // Nvidia items. Ascending + page_token means the cursor only advances through
  // items actually stored; a burst just takes an extra tick to catch up.
  const news: Array<{ id: number | string; headline?: string; summary?: string; source?: string; url?: string; symbols?: string[]; created_at?: string; updated_at?: string }> = [];
  let pageToken: string | undefined; let pages = 0;
  do {
    const url = new URL(NEWS_URL);
    url.searchParams.set("start", start.toISOString());
    url.searchParams.set("limit", "50");
    url.searchParams.set("sort", "asc");
    if (pageToken) url.searchParams.set("page_token", pageToken);
    const response = await fetch(url, { headers: { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret }, signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(`Alpaca news ${response.status}`);
    const payload = await response.json() as { news?: typeof news; next_page_token?: string | null };
    news.push(...(payload.news ?? []));
    pageToken = payload.next_page_token ?? undefined;
  } while (pageToken && ++pages < 6);
  const rows = news
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

// PHASE 3 STAMP: the news state known at fire time, written onto option_signals and
// shadow-ledger rows so "do fires with news behave differently" is answered from
// stamped records, not retro-joins against a purging firehose. Best-effort by
// contract — a news hiccup must never block a signal write (callers catch to null).
export async function newsContextFor(symbol: string): Promise<{ h1: number; h3: number; freshestMins: number | null; headline: string | null }> {
  const { data } = await createAdminClient().from("market_news").select("headline,published_at")
    .overlaps("symbols", symbolFilter(symbol))
    .gte("published_at", new Date(Date.now() - 3 * 3_600_000).toISOString())
    .order("published_at", { ascending: false }).limit(50);
  const rows = data ?? [];
  const hourAgo = Date.now() - 3_600_000;
  return {
    h1: rows.filter(row => Date.parse(String(row.published_at)) >= hourAgo).length,
    h3: rows.length,
    freshestMins: rows.length ? Math.round((Date.now() - Date.parse(String(rows[0].published_at))) / 60_000) : null,
    headline: rows.length ? String(rows[0].headline).slice(0, 160) : null,
  };
}

export const newsAge = (publishedAt: number): string => {
  const minutes = Math.max(0, Math.round((Date.now() - publishedAt) / 60_000));
  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
};

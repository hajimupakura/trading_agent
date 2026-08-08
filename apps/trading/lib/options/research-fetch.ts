import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAlert } from "@/lib/alerts/server";

// Generic research fetch queue: ad-hoc minute-aggregate pulls for any ticker, executed
// server-side where the data keys live. Insert a row into research_fetches; the cron
// processes one per light tick and stores compact bars [[t,o,h,l,c,v],...] as jsonb.
// Options (O:...) go through Massive; plain equities go through Alpaca (IEX).

async function massiveBars(ticker: string, from: string, to: string, timeframe: string): Promise<number[][]> {
  const key = process.env.MASSIVE_API_KEY;
  if (!key) throw new Error("MASSIVE_API_KEY is not configured");
  const unit = timeframe === "1Day" ? "day" : "minute";
  const url = new URL(`https://api.massive.com/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/${unit}/${from}/${to}`);
  url.searchParams.set("adjusted", "true"); url.searchParams.set("sort", "asc"); url.searchParams.set("limit", "50000");
  url.searchParams.set("apiKey", key);
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Massive API ${response.status} (${url.pathname})`);
  const payload = await response.json() as { results?: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }> };
  return (payload.results ?? []).map(bar => [bar.t, bar.o, bar.h, bar.l, bar.c, bar.v]);
}

async function alpacaBars(ticker: string, from: string, to: string, timeframe: string): Promise<number[][]> {
  const key = process.env.ALPACA_API_KEY_ID; const secret = process.env.ALPACA_API_SECRET_KEY;
  if (!key || !secret) throw new Error("Alpaca keys are not configured");
  const out: number[][] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(ticker)}/bars`);
    url.searchParams.set("timeframe", timeframe); url.searchParams.set("feed", "iex"); url.searchParams.set("limit", "10000");
    url.searchParams.set("start", from); url.searchParams.set("end", `${to}T23:59:59-04:00`);
    url.searchParams.set("adjustment", "all"); url.searchParams.set("sort", "asc");
    if (pageToken) url.searchParams.set("page_token", pageToken);
    const response = await fetch(url, { headers: { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret }, cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Alpaca bars ${response.status}`);
    const payload = await response.json() as { bars?: Array<{ t: string; o: number; h: number; l: number; c: number; v: number }>; next_page_token?: string | null };
    for (const bar of payload.bars ?? []) out.push([Date.parse(bar.t), bar.o, bar.h, bar.l, bar.c, bar.v]);
    pageToken = payload.next_page_token ?? undefined;
  } while (pageToken && out.length < 40_000);
  return out;
}

export async function runResearchFetches(): Promise<{ processed: string | null; error?: string }> {
  const admin = createAdminClient();
  const { data: pending } = await admin.from("research_fetches")
    .select("id,ticker,from_date,to_date,timeframe").eq("status", "queued")
    .order("created_at", { ascending: true }).limit(1);
  if (!pending?.length) return { processed: null };
  const job = pending[0];
  await admin.from("research_fetches").update({ status: "running" }).eq("id", job.id);
  try {
    const ticker = String(job.ticker);
    const timeframe = String(job.timeframe ?? "1Min");
    const bars = ticker.startsWith("O:") || ticker.startsWith("I:")
      ? await massiveBars(ticker, String(job.from_date), String(job.to_date), timeframe)
      : await alpacaBars(ticker, String(job.from_date), String(job.to_date), timeframe);
    const { error } = await admin.from("research_fetches").update({
      status: "done", bars, bar_count: bars.length, processed_at: new Date().toISOString(), error: null,
    }).eq("id", job.id);
    if (error) throw new Error(`persistence: ${error.message}`);
    // Queue drained -> tell the user on Telegram (research data is often awaited).
    const { count: remaining } = await admin.from("research_fetches").select("id", { count: "exact", head: true }).eq("status", "queued");
    if ((remaining ?? 0) === 0) {
      const { data: owner } = await admin.from("profiles").select("id").limit(1).maybeSingle();
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
      if (owner) await createAlert({
        userId: owner.id, eventKey: `radar-research-drained-${today}`, severity: "info",
        title: "Research data download complete",
        body: "All queued historical data has finished downloading and is stored in the database. Next time you open the app session, the analysis can run immediately on the full set. Nothing to do now.",
        metadata: { kind: "research_drained" },
      }).catch(() => undefined);
    }
    return { processed: ticker };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await admin.from("research_fetches").update({ status: "error", error: message, processed_at: new Date().toISOString() }).eq("id", job.id);
    return { processed: String(job.ticker), error: message };
  }
}

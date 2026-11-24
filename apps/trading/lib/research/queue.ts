import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// DB-queued research fetches (2026-11-23). Historical replay work needs Alpaca data,
// but the market-data keys are sensitive-locked on Vercel and unusable from a local
// machine. This queue closes the loop without exposing anything: a request row is
// inserted into research_requests (via the Supabase MCP), the every-minute monitor
// cron executes ONE pending request per tick server-side where the keys live, and
// the result lands back in the row. Read-only market data only — no handler here may
// ever place orders or mutate trading state.

const DATA_BASE = "https://data.alpaca.markets";
const TIME_BUDGET_MS = 25_000;
const MAX_RESULT_BYTES = 6_000_000; // jsonb comfort zone; requester splits bigger asks

type OptionBar = { t: string; o: number; h: number; l: number; c: number; v: number; n?: number; vw?: number };

async function fetchOptionBars(params: Record<string, unknown>, deadline: number): Promise<Record<string, OptionBar[]>> {
  const symbols = Array.isArray(params.symbols) ? params.symbols.map(String).slice(0, 20) : [];
  if (!symbols.length) throw new Error("option-bars: params.symbols required");
  const headers = { "APCA-API-KEY-ID": process.env.ALPACA_API_KEY_ID ?? "", "APCA-API-SECRET-KEY": process.env.ALPACA_API_SECRET_KEY ?? "" };
  const bars: Record<string, OptionBar[]> = {};
  let pageToken: string | undefined; let pages = 0;
  do {
    if (Date.now() > deadline) throw new Error("option-bars: time budget exhausted mid-pagination — split the request");
    const url = new URL(`${DATA_BASE}/v1beta1/options/bars`);
    url.searchParams.set("symbols", symbols.join(","));
    url.searchParams.set("timeframe", String(params.timeframe ?? "1Min"));
    if (params.start) url.searchParams.set("start", String(params.start));
    if (params.end) url.searchParams.set("end", String(params.end));
    url.searchParams.set("limit", "1000");
    if (pageToken) url.searchParams.set("page_token", pageToken);
    const response = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`option-bars: Alpaca ${response.status} ${(await response.text()).slice(0, 200)}`);
    const payload = await response.json() as { bars?: Record<string, OptionBar[]>; next_page_token?: string | null };
    for (const [symbol, rows] of Object.entries(payload.bars ?? {})) bars[symbol] = [...(bars[symbol] ?? []), ...rows];
    pageToken = payload.next_page_token ?? undefined;
  } while (pageToken && ++pages < 20);
  return bars;
}

async function fetchStockBars(params: Record<string, unknown>, deadline: number): Promise<Record<string, OptionBar[]>> {
  const symbols = Array.isArray(params.symbols) ? params.symbols.map(String).slice(0, 10) : [];
  if (!symbols.length) throw new Error("stock-bars: params.symbols required");
  const headers = { "APCA-API-KEY-ID": process.env.ALPACA_API_KEY_ID ?? "", "APCA-API-SECRET-KEY": process.env.ALPACA_API_SECRET_KEY ?? "" };
  const bars: Record<string, OptionBar[]> = {};
  for (const symbol of symbols) {
    let pageToken: string | undefined; let pages = 0;
    do {
      if (Date.now() > deadline) throw new Error("stock-bars: time budget exhausted — split the request");
      const url = new URL(`${DATA_BASE}/v2/stocks/${encodeURIComponent(symbol)}/bars`);
      url.searchParams.set("timeframe", String(params.timeframe ?? "1Min"));
      url.searchParams.set("feed", String(params.feed ?? (process.env.ALPACA_DATA_PLAN === "paid" ? "sip" : "iex")));
      url.searchParams.set("adjustment", "all"); url.searchParams.set("sort", "asc"); url.searchParams.set("limit", "10000");
      if (params.start) url.searchParams.set("start", String(params.start));
      if (params.end) url.searchParams.set("end", String(params.end));
      if (pageToken) url.searchParams.set("page_token", pageToken);
      const response = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`stock-bars: Alpaca ${response.status} for ${symbol} ${(await response.text()).slice(0, 200)}`);
      const payload = await response.json() as { bars?: OptionBar[]; next_page_token?: string | null };
      bars[symbol] = [...(bars[symbol] ?? []), ...(payload.bars ?? [])];
      pageToken = payload.next_page_token ?? undefined;
    } while (pageToken && ++pages < 10);
  }
  return bars;
}

export async function runResearchQueue(): Promise<{ ran: string | null; error?: string }> {
  const admin = createAdminClient();
  const { data: request } = await admin.from("research_requests").select("id,kind,params").eq("status", "pending").order("created_at", { ascending: true }).limit(1).maybeSingle();
  if (!request) return { ran: null };
  // Optimistic claim: only proceed if we flipped pending→running (cron overlap safety).
  const { data: claimed } = await admin.from("research_requests").update({ status: "running", updated_at: new Date().toISOString() }).eq("id", request.id).eq("status", "pending").select("id");
  if (!claimed?.length) return { ran: null };
  const deadline = Date.now() + TIME_BUDGET_MS;
  try {
    const params = (request.params ?? {}) as Record<string, unknown>;
    let result: unknown;
    if (request.kind === "option-bars") result = await fetchOptionBars(params, deadline);
    else if (request.kind === "stock-bars") result = await fetchStockBars(params, deadline);
    else throw new Error(`unknown research kind: ${request.kind}`);
    const encoded = JSON.stringify(result);
    if (encoded.length > MAX_RESULT_BYTES) throw new Error(`result too large (${encoded.length}b) — split the request`);
    await admin.from("research_requests").update({ status: "done", result, error: null, updated_at: new Date().toISOString() }).eq("id", request.id);
    return { ran: request.id as string };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await admin.from("research_requests").update({ status: "error", error: message.slice(0, 500), updated_at: new Date().toISOString() }).eq("id", request.id);
    return { ran: request.id as string, error: message };
  }
}

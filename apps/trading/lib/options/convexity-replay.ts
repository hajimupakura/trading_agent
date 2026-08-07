import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { assessQualification, computeHarvest, type MinuteBar, type HarvestMetrics } from "./convexity";

// Overnight Convexity — Phase 2 HISTORICAL REPLAY. Research only; nothing here trades.
// A queue table (convexity_replays) holds entry-session dates. Each light cron tick
// processes ONE queued session end-to-end:
//   1. Rebuild the 15:45 qualification verdict from that day's SPY minute bars.
//   2. Price a strike grid of next-session SPXW contracts at the 15:40-15:50 window
//      (minute trade aggregates — the same data the scan would have seen).
//   3. Replay the next morning 9:25-10:15 and score the planned harvest rules
//      (hold-to-10:15, thirds ladder 1.75/2.5/3.5x, 22% trail armed at 1.75x).
// Caveat stored with every row: aggregates are TRADE prices, not executable bids, so
// replay results skew slightly optimistic vs the live Phase-1 capture.

const STRIKE_OFFSETS = [10, 20, 30, 40, 55, 70, 85, 100];
const MAX_ENTRY = 8;
const SUMMARY_BAND: [number, number] = [1.5, 8]; // entry-premium proxy for the 0.15-0.35Δ band

const etMinutes = (ts: number) => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ts));
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return Number(value.hour) * 60 + Number(value.minute);
};
const etDate = (ts: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(ts));

async function massive<T>(path: string): Promise<T> {
  const key = process.env.MASSIVE_API_KEY;
  if (!key) throw new Error("MASSIVE_API_KEY is not configured");
  const url = new URL(`https://api.massive.com${path}`);
  url.searchParams.set("apiKey", key);
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`Massive API ${response.status} (${url.pathname})`);
  return response.json() as Promise<T>;
}

// One-shot diagnostic run when a replay dies on a Massive error: which datasets does
// this plan actually include? (Historical index vs option aggregates vs NBBO quotes.)
async function probeEntitlements(): Promise<string> {
  const today = etDate(Date.now());
  const tests: Array<[string, string]> = [
    ["idx-today", `/v2/aggs/ticker/I:SPX/range/1/minute/${today}/${today}?limit=5&sort=asc`],
    ["idx-hist", "/v2/aggs/ticker/I:SPX/range/1/minute/2026-08-06/2026-08-06?limit=5&sort=asc"],
    ["opt-agg", "/v2/aggs/ticker/O:SPXW260807C07770000/range/1/minute/2026-08-06/2026-08-07?limit=5&sort=asc"],
    ["opt-quotes", "/v3/quotes/O:SPXW260807C07770000?limit=1"],
  ];
  const out: string[] = [];
  for (const [label, path] of tests) {
    try { await massive(path); out.push(`${label}:ok`); }
    catch (error) { out.push(`${label}:${error instanceof Error ? error.message.replace(/^Massive API /, "") : String(error)}`); }
  }
  return out.join(" ");
}

interface Agg { t: number; o: number; h: number; l: number; c: number; v: number }
async function minuteAggs(ticker: string, from: string, to: string): Promise<Agg[]> {
  const payload = await massive<{ results?: Agg[] }>(`/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/minute/${from}/${to}?adjusted=true&sort=asc&limit=50000`);
  return payload.results ?? [];
}

async function spyBarsFor(date: string): Promise<{ session: MinuteBar[]; prior: { high: number; low: number; close: number } | null }> {
  const key = process.env.ALPACA_API_KEY_ID; const secret = process.env.ALPACA_API_SECRET_KEY;
  if (!key || !secret) throw new Error("Alpaca keys are not configured");
  const fetchBars = async (params: Record<string, string>) => {
    const url = new URL("https://data.alpaca.markets/v2/stocks/SPY/bars");
    for (const [name, value] of Object.entries({ feed: "iex", adjustment: "all", sort: "asc", limit: "1000", ...params })) url.searchParams.set(name, value);
    const response = await fetch(url, { headers: { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret }, cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Alpaca bars ${response.status}`);
    return (await response.json()) as { bars?: Array<{ t: string; o: number; h: number; l: number; c: number; v: number; vw?: number }> };
  };
  const [minute, daily] = await Promise.all([
    fetchBars({ timeframe: "1Min", start: `${date}T09:00:00-04:00`, end: `${date}T16:30:00-04:00` }),
    fetchBars({ timeframe: "1Day", start: `${new Date(new Date(`${date}T12:00:00Z`).getTime() - 12 * 86_400_000).toISOString().slice(0, 10)}`, end: `${date}T00:00:00-04:00`, limit: "10" }),
  ]);
  const session = (minute.bars ?? [])
    .map(bar => ({ minutes: etMinutes(Date.parse(bar.t)), open: bar.o, high: bar.h, low: bar.l, close: bar.c, volume: bar.v, vwap: bar.vw ?? null }))
    // Truncate at 15:50 — the information the scan would have had, never hindsight.
    .filter(bar => bar.minutes >= 570 && bar.minutes <= 950);
  const prior = (daily.bars ?? [])
    .map(bar => ({ date: etDate(Date.parse(bar.t)), high: bar.h, low: bar.l, close: bar.c }))
    .filter(bar => bar.date < date).at(-1) ?? null;
  return { session, prior: prior ? { high: prior.high, low: prior.low, close: prior.close } : null };
}

interface ReplayContract {
  ticker: string; side: "call" | "put"; strike: number; entry: number; entryAtMinutes: number;
  morningOpen: number | null; morningHigh: number | null; highAtMinutes: number | null;
  metrics: HarvestMetrics | null;
}

async function replayContract(entryDate: string, exitDate: string, side: "call" | "put", strike: number): Promise<ReplayContract | null> {
  const occ = `O:SPXW${exitDate.slice(2).replace(/-/g, "")}${side === "call" ? "C" : "P"}${String(Math.round(strike * 1000)).padStart(8, "0")}`;
  const bars = await minuteAggs(occ, entryDate, exitDate);
  const entryBars = bars.filter(bar => etDate(bar.t) === entryDate && etMinutes(bar.t) >= 935 && etMinutes(bar.t) <= 950);
  if (!entryBars.length) return null;
  const entryBar = entryBars.at(-1)!;
  const entry = entryBar.c;
  if (entry <= 0.15 || entry > MAX_ENTRY) return null;
  const burst = bars.filter(bar => etDate(bar.t) === exitDate && etMinutes(bar.t) >= 565 && etMinutes(bar.t) <= 615);
  const metrics = computeHarvest(entry, burst.map(bar => ({ minutes: etMinutes(bar.t), bid: bar.c })));
  let high = -Infinity; let highAt: number | null = null;
  for (const bar of burst) if (bar.h > high) { high = bar.h; highAt = etMinutes(bar.t); }
  return {
    ticker: occ, side, strike, entry, entryAtMinutes: etMinutes(entryBar.t),
    morningOpen: burst[0]?.o ?? null, morningHigh: burst.length ? high : null, highAtMinutes: highAt,
    metrics,
  };
}

async function processReplay(entryDate: string, exitDate: string) {
  const [{ session, prior }, spxAggs] = await Promise.all([
    spyBarsFor(entryDate),
    minuteAggs("I:SPX", entryDate, entryDate),
  ]);
  const qualification = assessQualification(session, prior);
  const spotBar = spxAggs.filter(bar => etMinutes(bar.t) <= 950).at(-1);
  if (!spotBar) throw new Error("No SPX index bars for the entry session");
  const spot = spotBar.c;

  const targets = STRIKE_OFFSETS.flatMap(offset => [
    { side: "call" as const, strike: Math.round((spot + offset) / 5) * 5 },
    { side: "put" as const, strike: Math.round((spot - offset) / 5) * 5 },
  ]);
  const contracts: ReplayContract[] = [];
  // Small batches keep us inside the cron's 60s budget without hammering the API.
  for (let index = 0; index < targets.length; index += 4) {
    const batch = await Promise.allSettled(targets.slice(index, index + 4).map(target => replayContract(entryDate, exitDate, target.side, target.strike)));
    for (const result of batch) if (result.status === "fulfilled" && result.value) contracts.push(result.value);
  }
  if (!contracts.length) throw new Error("No contracts traded in the scan window (holiday or missing data?)");

  const summarize = (side: "call" | "put") => {
    const band = contracts.filter(contract => contract.side === side && contract.metrics && contract.entry >= SUMMARY_BAND[0] && contract.entry <= SUMMARY_BAND[1]);
    if (!band.length) return null;
    const mean = (values: number[]) => Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1));
    return {
      contracts: band.length,
      avgMfeMult: mean(band.map(contract => contract.metrics!.mfeMult)),
      avgHoldTo1015Pct: mean(band.map(contract => contract.metrics!.holdTo1015Pct)),
      avgLadderPct: mean(band.map(contract => contract.metrics!.ladderPct)),
      avgTrailPct: mean(band.map(contract => contract.metrics!.trailPct)),
      bestMfeMult: Math.max(...band.map(contract => contract.metrics!.mfeMult)),
    };
  };
  return {
    qualification, spot,
    results: contracts,
    summary: {
      qualified: qualification.direction != null, direction: qualification.direction,
      calls: summarize("call"), puts: summarize("put"),
      priceBasis: "minute trade aggregates (not executable bids) — slightly optimistic vs live capture",
    },
  };
}

// Cron entry point: one queued session per call, newest first (the sessions the user
// is asking about land first; the deep history fills in behind).
export async function runConvexityReplays(): Promise<{ processed: string | null; queued: number; error?: string }> {
  const admin = createAdminClient();
  const { data: pending } = await admin.from("convexity_replays")
    .select("id,entry_date,exit_date").eq("status", "queued")
    .order("entry_date", { ascending: false }).limit(1);
  const { count } = await admin.from("convexity_replays").select("id", { count: "exact", head: true }).eq("status", "queued");
  if (!pending?.length) return { processed: null, queued: 0 };
  const job = pending[0];
  await admin.from("convexity_replays").update({ status: "running" }).eq("id", job.id);
  try {
    const outcome = await processReplay(String(job.entry_date), String(job.exit_date));
    const { error } = await admin.from("convexity_replays").update({
      status: "done", qualification: outcome.qualification as unknown as Record<string, unknown>, spot_entry: outcome.spot,
      results: outcome.results as unknown as Record<string, unknown>[], summary: outcome.summary as unknown as Record<string, unknown>,
      processed_at: new Date().toISOString(), error: null,
    }).eq("id", job.id);
    if (error) throw new Error(`replay persistence: ${error.message}`);
    return { processed: String(job.entry_date), queued: (count ?? 1) - 1 };
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error);
    if (message.includes("Massive API")) message += ` [probe: ${await probeEntitlements().catch(() => "probe failed")}]`;
    await admin.from("convexity_replays").update({ status: "error", error: message, processed_at: new Date().toISOString() }).eq("id", job.id);
    return { processed: String(job.entry_date), queued: (count ?? 1) - 1, error: message };
  }
}

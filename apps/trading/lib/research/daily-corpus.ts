import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// DAILY CORPUS GROWTH (user call 2026-11-24: "get in as much as we can and then use
// the findings for deeper analysis... based on that data we may find optimum entry
// points and conditions"). The live sleeves stay budgeted — they are the deployment
// rehearsal — while THIS keeps the enter-everything dataset growing: once per trading
// day after the close, today's fires become ml-corpus (same-day 0DTE tapes), ml-swing
// (3-7 DTE ladder) and ml-lottery (nearest-expiry pennies) day-requests, exactly like
// the 22-month backfill that powers every study. One virtual entry per (symbol, side),
// first fire of the day, matching the research convention the backtests were built on.
// SPX is excluded (the corpus convention — SPY carries the index read; SPXW symbology
// differs from the occFor builder). The queue processes the rows over the next ticks.

const ET = "America/New_York";

export async function enqueueDailyCorpus(): Promise<{ queued: number; skipped?: string }> {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: ET, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map(part => [part.type, part.value]));
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  if (["Sat", "Sun"].includes(String(parts.weekday))) return { queued: 0, skipped: "weekend" };
  if (minutes < 980 || minutes > 995) return { queued: 0, skipped: "outside 16:20-16:35 window" };
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: ET }).format(new Date());
  const admin = createAdminClient();
  const { data: existing } = await admin.from("research_requests").select("id").eq("kind", "ml-corpus").eq("params->>day", day).limit(1).maybeSingle();
  if (existing) return { queued: 0, skipped: "already queued today" };
  const { data: fires } = await admin.from("option_signals").select("underlying,action,generated_at,market_snapshot")
    .in("action", ["enter_call", "enter_put"])
    .gte("generated_at", `${day}T09:30:00-05:00`).lt("generated_at", `${day}T16:00:00-05:00`)
    .order("generated_at");
  const seen = new Set<string>();
  const minuteOf = (iso: string) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: ET, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso)).map(part => [part.type, part.value]));
    return Number(p.hour) * 60 + Number(p.minute);
  };
  const entries = (fires ?? []).flatMap(row => {
    const sym = String(row.underlying);
    if (sym === "SPX") return [];
    const dir = row.action === "enter_call" ? 1 : -1;
    const key = `${sym}:${dir}`;
    if (seen.has(key)) return []; // research convention: one event per (day, sym, dir)
    seen.add(key);
    const spot = Number((row.market_snapshot as { price?: number } | null)?.price ?? 0);
    if (!spot || spot <= 0) return [];
    return [{ sym, dir, fireMin: minuteOf(String(row.generated_at)), spot }];
  });
  if (!entries.length) return { queued: 0, skipped: "no fires today" };
  const { error } = await admin.from("research_requests").insert([
    { kind: "ml-corpus", params: { day, entries }, status: "pending" },
    { kind: "ml-swing", params: { day, entries }, status: "pending" },
    { kind: "ml-lottery", params: { day, entries }, status: "pending" },
  ]);
  if (error) throw new Error(`daily corpus enqueue: ${error.message}`);
  return { queued: 3 };
}

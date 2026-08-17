import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAlert } from "@/lib/alerts/server";
import { WATCH_UNDERLYINGS } from "@/lib/options/types";
import type { CommandCenter } from "@/lib/options/types";

// BLIND-SPOT DETECTORS. The week of 2026-08-11 lost real opportunities to bugs that
// FAILED SILENT AND LOOKED HEALTHY: priorDay null for every equity forever (start
// param missing), an ask ceiling that banned SNDK's whole chain, a PDT guard nobody
// remembered, a volume gate blind to sustained moves. "No signal" from a broken gate
// is indistinguishable from "no signal" from a quiet tape — unless the system audits
// itself. Two detectors:
//   1. INVARIANTS (every tick, in-session): things that must be true when healthy.
//      Violations page critical, once per day each.
//   2. UNEXPLAINED-MISS AUDIT (post-close): any watch name that moved >=2% with zero
//      entries on BOTH venues gets a why-not autopsy alert listing the gates that
//      blocked it — converting silent misses into named, fixable reasons.

const et = () => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map(part => [part.type, part.value]));
  return { weekday: String(parts.weekday), minutes: Number(parts.hour) * 60 + Number(parts.minute) };
};
const etDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());

async function ownerId(admin: ReturnType<typeof createAdminClient>): Promise<string | null> {
  const { data } = await admin.from("profiles").select("id").limit(1).maybeSingle();
  return data?.id ?? null;
}

export async function runBlindspotChecks(): Promise<{ invariantViolations: string[]; missAudits: string[] }> {
  const clock = et();
  const out = { invariantViolations: [] as string[], missAudits: [] as string[] };
  if (["Sat", "Sun"].includes(clock.weekday)) return out;
  const admin = createAdminClient();
  const userId = await ownerId(admin);
  if (!userId) return out;
  const today = etDate();
  const { data: rows } = await admin.from("options_monitor_snapshots").select("underlying,payload,updated_at");
  const snapshots = (rows ?? []).map(row => ({ underlying: String(row.underlying), payload: row.payload as CommandCenter | null, updatedAt: Date.parse(String(row.updated_at)) }));

  // ---- 1. In-session invariants (10:00-15:30 so the open's warmup doesn't false-alarm).
  if (clock.minutes >= 600 && clock.minutes <= 930) {
    for (const snap of snapshots) {
      const market = snap.payload?.market;
      if (!market) continue;
      const problems: string[] = [];
      // Every equity market MUST carry prior-day levels in-session (the gap math and
      // daily-context lines are dead without them — this was null for a WEEK unnoticed).
      if (market.priorDay == null) problems.push("priorDay is missing — gap detection is BLIND for this symbol");
      // A liquid underlying with zero eligible contracts all session = a screen is
      // structurally rejecting the whole chain (the SNDK ask-ceiling failure mode).
      const eligible = (snap.payload?.contracts ?? []).filter(contract => contract.eligible).length;
      if ((snap.payload?.contracts ?? []).length >= 50 && eligible === 0) problems.push("0 of " + (snap.payload?.contracts ?? []).length + " contracts pass the entry screen — a filter may be structurally rejecting the whole chain");
      // Snapshot staleness beyond the rotation cadence means the refresh loop is sick.
      if (Date.now() - snap.updatedAt > 15 * 60_000) problems.push("snapshot is " + Math.round((Date.now() - snap.updatedAt) / 60_000) + " minutes stale");
      for (const problem of problems) {
        const eventKey = `blindspot-${snap.underlying}-${problem.slice(0, 24).replaceAll(" ", "-")}-${today}`;
        const { data: seen } = await admin.from("alerts").select("id").eq("event_key", eventKey).limit(1).maybeSingle();
        if (seen) continue;
        await createAlert({
          userId, eventKey, severity: "critical",
          title: `BLIND-SPOT ALARM: ${snap.underlying} — ${problem.split(" — ")[0]}`,
          body: `${snap.underlying}: ${problem}. This is the class of silent failure that cost trades the week of 8/11 (null priorDay, banned chains). Investigate today, not after the next miss.`,
          metadata: { kind: "blindspot_invariant", underlying: snap.underlying, problem },
        }).catch(() => undefined);
        out.invariantViolations.push(`${snap.underlying}: ${problem}`);
      }
    }
  }

  // ---- 2. Post-close unexplained-miss audit (16:05-16:25, once per symbol/day).
  if (clock.minutes >= 965 && clock.minutes <= 985) {
    const { data: todaysEntries } = await admin.from("paper_trade_orders").select("underlying").eq("action", "buy_to_open").gte("created_at", `${today}T00:00:00-04:00`);
    const { data: rhEntries } = await admin.from("rh_entry_orders").select("underlying").gte("created_at", `${today}T00:00:00-04:00`).neq("status", "rejected");
    const traded = new Set([...(todaysEntries ?? []).map(row => String(row.underlying)), ...(rhEntries ?? []).map(row => String(row.underlying))]);
    for (const symbol of WATCH_UNDERLYINGS) {
      if (traded.has(symbol)) continue;
      const snap = snapshots.find(candidate => candidate.underlying === symbol);
      const market = snap?.payload?.market;
      const prior = market?.priorDay;
      if (!market?.price || !prior?.close) continue;
      const movePct = (market.price / prior.close - 1) * 100;
      if (Math.abs(movePct) < 2) continue;
      const eventKey = `blindspot-miss-${symbol}-${today}`;
      const { data: seen } = await admin.from("alerts").select("id").eq("event_key", eventKey).limit(1).maybeSingle();
      if (seen) continue;
      const reasons = (snap?.payload?.signal?.reasons ?? []).join(" · ") || "no signal state recorded";
      await createAlert({
        userId, eventKey, severity: "warning",
        title: `Unexplained miss: ${symbol} moved ${movePct >= 0 ? "+" : ""}${movePct.toFixed(1)}% with zero entries`,
        body: `${symbol} moved ${movePct.toFixed(1)}% today and neither venue entered. The last signal state said: ${reasons}. If that explanation reads like discipline (extension, RSI, regime), fine — if it reads like a broken gate, this is tomorrow's bug. This audit exists because SNDK/TSLA misses sat invisible until a human noticed.`,
        metadata: { kind: "blindspot_miss", symbol, movePct: +movePct.toFixed(2), reasons },
      }).catch(() => undefined);
      out.missAudits.push(`${symbol} ${movePct.toFixed(1)}%`);
    }
  }
  return out;
}

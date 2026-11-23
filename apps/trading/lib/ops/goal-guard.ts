import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAlert } from "@/lib/alerts/server";
import type { CommandCenter } from "@/lib/options/types";

// GOAL GUARD (user call, 2026-11-23: "my goal is at least 20% of portfolio value...
// those $135 profits matter"): the mirror image of the daily-loss breaker. When the
// day's REAL-money P&L reaches +20% of the morning equity baseline, one page goes
// out and new real entries pause — the classic failure on a goal day is giving it
// back chasing a second helping. Two ways through, by design:
//   1. EXTRAORDINARY TAPE (automatic): SPX +/-1.5% on the day, or the traded name
//      itself +/-2% — "if there is a big surge or a big drop, we have to
//      capitalize". The guard only protects chop-day profits from chop-day chasing.
//   2. EXPLICIT OVERRIDE: "goal override" in the bot unlocks the day; the
//      "override" keyword on a typed buy punches through once.
// Scope: REAL-money paths only (Telegram buys, RH autonomy when promoted). The
// paper lane stays unfiltered — it measures the raw strategy.

const GOAL_PCT = 0.20;
const etDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());

export type GoalStatus = {
  baseline: number | null; equity: number | null; pnl: number | null; pct: number | null;
  hit: boolean; override: boolean; notified: boolean;
};

export async function goalStatus(): Promise<GoalStatus> {
  const admin = createAdminClient();
  const today = etDate();
  const [{ data: baselineRow }, { data: portfolioRow }] = await Promise.all([
    admin.from("rh_daily_baseline").select("equity,goal_notified,goal_override").eq("trade_date", today).maybeSingle(),
    admin.from("broker_portfolio_snapshots").select("payload,updated_at").eq("broker", "robinhood").maybeSingle(),
  ]);
  const baseline = baselineRow ? Number(baselineRow.equity) : null;
  const fresh = portfolioRow?.updated_at != null && Date.now() - Date.parse(String(portfolioRow.updated_at)) < 10 * 60_000;
  const equity = fresh ? Number((portfolioRow?.payload as { totalValue?: number } | null)?.totalValue ?? NaN) : null;
  const pnl = baseline != null && equity != null && Number.isFinite(equity) ? equity - baseline : null;
  const pct = pnl != null && baseline ? pnl / baseline : null;
  return {
    baseline, equity, pnl, pct,
    hit: pct != null && pct >= GOAL_PCT,
    override: Boolean(baselineRow?.goal_override),
    notified: Boolean(baselineRow?.goal_notified),
  };
}

// Extraordinary tape: the guard stands down when the market is genuinely moving.
export function extraordinaryTape(snapshot: CommandCenter | null | undefined, spxSnapshot?: CommandCenter | null): { extraordinary: boolean; why: string | null } {
  const movePct = (candidate: CommandCenter | null | undefined) => {
    const market = candidate?.market;
    if (!market?.price || !market.priorDay?.close) return null;
    return (market.price / market.priorDay.close - 1) * 100;
  };
  const own = movePct(snapshot);
  if (own != null && Math.abs(own) >= 2) return { extraordinary: true, why: `${snapshot?.market?.symbol} is moving ${own >= 0 ? "+" : ""}${own.toFixed(1)}% today` };
  const spx = movePct(spxSnapshot);
  if (spx != null && Math.abs(spx) >= 1.5) return { extraordinary: true, why: `SPX is moving ${spx >= 0 ? "+" : ""}${spx.toFixed(1)}% today` };
  return { extraordinary: false, why: null };
}

// Cron tick: page once when the goal is first hit.
export async function checkGoalGuard(): Promise<{ hit: boolean }> {
  const status = await goalStatus();
  if (!status.hit || status.notified || status.baseline == null || status.pnl == null) return { hit: status.hit };
  const admin = createAdminClient();
  const today = etDate();
  // Claim notified FIRST so overlapping ticks can't double-page.
  const { data: claimed } = await admin.from("rh_daily_baseline").update({ goal_notified: true }).eq("trade_date", today).eq("goal_notified", false).select("trade_date");
  if (!claimed?.length) return { hit: true };
  const { data: owner } = await admin.from("profiles").select("id").limit(1).maybeSingle();
  if (owner) await createAlert({
    userId: String(owner.id), eventKey: `goal-day-${today}`, severity: "success",
    title: `🏁 GOAL DAY: +$${status.pnl.toFixed(0)} (${((status.pct ?? 0) * 100).toFixed(0)}%)`,
    body: `Day P&L is +$${status.pnl.toFixed(0)} on a $${status.baseline.toFixed(0)} morning baseline — the 20% goal is hit. Protecting it: new real-money entries are paused for today. Exceptions: a genuinely moving tape (SPX ±1.5% or the name ±2%) passes automatically, and "goal override" in the bot unlocks the day. Giving back a goal day chasing seconds is the round-trip problem at portfolio scale — the guard exists so keeping it is the default.`,
    metadata: { kind: "goal_day", pnl: status.pnl, pct: status.pct, baseline: status.baseline },
  }).catch(() => undefined);
  return { hit: true };
}

export async function setGoalOverride(): Promise<string> {
  const admin = createAdminClient();
  const today = etDate();
  const { data } = await admin.from("rh_daily_baseline").update({ goal_override: true }).eq("trade_date", today).select("trade_date");
  if (!data?.length) return "No baseline row for today yet (the worker writes it at the first morning equity read) — nothing to override.";
  return "🔓 Goal guard overridden for the rest of today — new entries allowed. The 20% banked is now back at the table; trade like you mean it.";
}

// Entry gate: returns a refusal string when the guard blocks, null when clear.
// Loads its own snapshots (the traded name + SPX) so any caller can gate with just
// the underlying string.
export async function goalGuardBlocks(input: { underlying: string; explicitOverride?: boolean }): Promise<string | null> {
  const status = await goalStatus();
  if (!status.hit || status.override || input.explicitOverride) return null;
  const admin = createAdminClient();
  const load = async (symbol: string) => (await admin.from("options_monitor_snapshots").select("payload").eq("underlying", symbol).maybeSingle()).data?.payload as CommandCenter | null;
  const own = await load(input.underlying).catch(() => null);
  const spx = input.underlying === "SPX" ? own : await load("SPX").catch(() => null);
  const tape = extraordinaryTape(own, spx);
  if (tape.extraordinary) return null;
  return `🏁 Goal day: +$${(status.pnl ?? 0).toFixed(0)} (${((status.pct ?? 0) * 100).toFixed(0)}%) is banked and the tape is ordinary — new entries are paused to protect it. An extraordinary move (SPX ±1.5%, name ±2%) unlocks automatically; "goal override" unlocks the day; adding "override" to a typed buy punches through once.`;
}

import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { MIN_LEG_PCT, morningLegs } from "./morning-legs";

// LOTTERY-DAY STAMP — INPUTS ONLY SINCE 2026-11-27. It never arms.
//
// What was wrong. Detector v2 was trained on each day's STRONGEST 30-minute move per
// name, selected with the whole day in view and kept only if a pullback followed it
// (the research pullback-scan). None of that is knowable at 11:00. The live job fed it
// something else again — a count of every engine signal row, re-fires included, and a
// max leg read from a column only index signals fill — so its inputs sat at the edge
// of anything it was trained on and it stamped `armed` on EVERY day from 11/24 to
// 11/27 (Thanksgiving included), which doubled the swarm sleeve's daily cap each time.
//
// What history says (373 census days, same label: a 10x repricing happened). Scored on
// inputs that ARE known at 11:00 — each name's strongest COMPLETED 30-minute move so
// far — the old model has AUC 0.515 on unseen 2026 and would arm 39% of days. Retrained
// on those inputs it scores 0.524 (95% range 0.40-0.64). The walk-forward folds look
// better (0.56-0.68, precision ~36% against a ~19% base rate) but they are 53-86 days
// each. That is not enough to let a stamp change a trading limit.
//
// So this job now does the one thing that is certainly useful: it records the real
// 11:00 inputs every day (per-name moves included, so any universe can be rebuilt),
// and stamps armed=false. A detector goes back in only after it validates on these.

// The names the historical bar set covers; the aggregate inputs use exactly these so
// live stamps stay comparable with the history a future model is trained on.
const UNIVERSE = ["SLV", "QQQ", "SPY", "GLD", "TSLA", "MU", "NVDA", "META", "MSFT", "GOOGL", "AAPL", "SMCI", "SPCX", "SNDK"];
const MEGACAPS = new Set(["NVDA", "AAPL", "TSLA", "MSFT", "META", "GOOGL"]);

const ET = "America/New_York";
const etNow = () => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: ET, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map(part => [part.type, part.value]));
  return { weekday: String(parts.weekday), minutes: Number(parts.hour) * 60 + Number(parts.minute), dateKey: new Intl.DateTimeFormat("en-CA", { timeZone: ET }).format(new Date()) };
};
const prevWeekday = (dateKey: string): string => {
  const date = new Date(`${dateKey}T12:00:00Z`);
  do { date.setUTCDate(date.getUTCDate() - 1); } while ([0, 6].includes(date.getUTCDay()));
  return date.toISOString().slice(0, 10);
};

export async function runLotteryDayStamp(): Promise<{ stamped: boolean; skipped?: string }> {
  const clock = etNow();
  if (["Sat", "Sun"].includes(clock.weekday)) return { stamped: false, skipped: "weekend" };
  if (clock.minutes < 660 || clock.minutes > 675) return { stamped: false, skipped: "outside 11:00-11:15 window" };
  const admin = createAdminClient();
  const { data: existing } = await admin.from("lottery_day_stamps").select("day").eq("day", clock.dateKey).maybeSingle();
  if (existing) return { stamped: false, skipped: "already stamped" };
  const prev1 = prevWeekday(clock.dateKey);
  const prev2 = prevWeekday(prev1);
  const [{ data: snapshots }, { data: events }] = await Promise.all([
    // Only the bars — a full snapshot payload is ~1 MB per name.
    admin.from("options_monitor_snapshots").select("underlying,bars:payload->market->bars"),
    admin.from("market_events").select("date,event_type,detail").in("date", [clock.dateKey, prev1, prev2]),
  ]);
  const dayOf = new Intl.DateTimeFormat("en-CA", { timeZone: ET });
  const todaysBars = (snapshots ?? []).filter(row => row.underlying !== "SPX").map(row => ({
    sym: String(row.underlying),
    bars: ((row.bars as Array<{ timestamp: number; close: number }> | null) ?? []).filter(bar => dayOf.format(new Date(bar.timestamp)) === clock.dateKey),
  }));
  // No bars dated TODAY means a holiday or dead snapshots, not a quiet morning —
  // refuse to stamp a fabricated "nothing moved" day (11/26, Thanksgiving, got a stamp).
  if (!todaysBars.some(row => row.bars.length >= 31)) return { stamped: false, skipped: "no bars for today in any snapshot (holiday or stale data)" };
  const allLegs = todaysBars.flatMap(row => morningLegs(row.sym, row.bars));
  const legs = allLegs.filter(leg => UNIVERSE.includes(leg.sym));
  const has = (date: string, type: string, megacapOnly = false, ticker?: string) =>
    (events ?? []).some(event => event.date === date && event.event_type === type
      && (!megacapOnly || MEGACAPS.has(String(event.detail)))
      && (!ticker || event.detail === ticker));
  const reactToday = has(clock.dateKey, "earnings_bmo", true) || has(prev1, "earnings_amc", true);
  const reactPrev = has(prev1, "earnings_bmo", true) || has(prev2, "earnings_amc", true);
  const nvdaReact = has(clock.dateKey, "earnings_bmo", true, "NVDA") || has(prev1, "earnings_amc", true, "NVDA");
  const dow = ["Mon", "Tue", "Wed", "Thu", "Fri"].indexOf(clock.weekday);
  const features = {
    n_by11: legs.length,
    maxleg_by11: legs.reduce((max, leg) => Math.max(max, leg.legPct), 0),
    syms_by11: new Set(legs.map(leg => leg.sym)).size,
    first_fire: legs.length ? Math.min(...legs.map(leg => leg.startMin)) : 960,
    dow,
    cpi: has(clock.dateKey, "cpi") ? 1 : 0, jobs: has(clock.dateKey, "jobs") ? 1 : 0,
    fomc: has(clock.dateKey, "fomc") ? 1 : 0, fomc_prev: has(prev1, "fomc") ? 1 : 0,
    megacap_react: reactToday ? 1 : 0, react_prev: reactPrev ? 1 : 0, nvda_react: nvdaReact ? 1 : 0,
    // Every name's legs, universe or not, so the inputs can be rebuilt for any name set.
    legs: allLegs, universe: UNIVERSE, minLegPct: MIN_LEG_PCT,
  };
  const { error } = await admin.from("lottery_day_stamps").insert({ day: clock.dateKey, prob: 0, armed: false, features, model: "inputs-only-2026-11-27" });
  if (error) throw new Error(`lottery stamp persistence: ${error.message}`);
  return { stamped: true };
}

import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAlert } from "@/lib/alerts/server";
import detector from "./lottery-detector-v2.json";
import { predictProba, type HistGbtModel } from "./histgbt";

// LOTTERY-DAY DETECTOR v2 — ADVISORY STAMPS ONLY (shipped on the user's call
// 2026-11-24: "add all your recommendations to production"). Once per trading day
// at ~11:00 ET the morning's fire shape (count, max 30-min leg, breadth, first-fire
// time) plus the event calendar (CPI/jobs/FOMC/megacap earnings-reaction days from
// market_events) is scored by the walk-forward-validated by-11 model. On unseen
// 2026 days the armed top-20% carried 59% of penny-swarm profit on 13% of days.
// AUC is 0.567 — a tilt, not an oracle: the stamp annotates the day and pages when
// armed; it gates NOTHING. Known approximations, accepted deliberately: previous
// trading day ignores market holidays (a next-day-after-holiday reaction flag can
// land a day early ~9 times a year), and leg_pct30 only exists on fires written
// after 2026-11-24, so maxleg_by11 reads 0 on any fire missing it (conservative:
// pushes prob DOWN, never arms on fabricated strength).

const MODEL = detector as HistGbtModel;
const MEGACAPS = new Set(["NVDA", "AAPL", "TSLA", "MSFT", "META", "GOOGL"]);
// Loud port guard: if the bundled JSON ever drifts from the predictor, refuse to
// score rather than stamp garbage (silent-failure doctrine).
for (const check of (MODEL.checks ?? []).slice(0, 3)) {
  if (Math.abs(predictProba(MODEL, check.x) - check.p) > 1e-6) throw new Error("lottery detector JSON fails its sklearn checks");
}

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
  const [{ data: fires }, { data: events }] = await Promise.all([
    admin.from("option_signals").select("underlying,generated_at,leg_pct30")
      .in("action", ["enter_call", "enter_put"])
      .gte("generated_at", `${clock.dateKey}T09:30:00-05:00`)
      .lt("generated_at", `${clock.dateKey}T11:00:00-05:00`),
    admin.from("market_events").select("date,event_type,detail").in("date", [clock.dateKey, prev1, prev2]),
  ]);
  const rows = fires ?? [];
  const etMinute = (iso: string) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: ET, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso)).map(part => [part.type, part.value]));
    return Number(parts.hour) * 60 + Number(parts.minute);
  };
  const has = (date: string, type: string, megacapOnly = false, ticker?: string) =>
    (events ?? []).some(event => event.date === date && event.event_type === type
      && (!megacapOnly || MEGACAPS.has(String(event.detail)))
      && (!ticker || event.detail === ticker));
  const reactToday = has(clock.dateKey, "earnings_bmo", true) || has(prev1, "earnings_amc", true);
  const reactPrev = has(prev1, "earnings_bmo", true) || has(prev2, "earnings_amc", true);
  const nvdaReact = has(clock.dateKey, "earnings_bmo", true, "NVDA") || has(prev1, "earnings_amc", true, "NVDA");
  const dow = ["Mon", "Tue", "Wed", "Thu", "Fri"].indexOf(clock.weekday);
  const features = [
    rows.length,                                                                    // n_by11
    rows.reduce((max, row) => Math.max(max, Math.abs(Number(row.leg_pct30 ?? 0))), 0), // maxleg_by11
    new Set(rows.map(row => String(row.underlying))).size,                          // syms_by11
    rows.length ? Math.min(...rows.map(row => etMinute(String(row.generated_at)))) : 960, // first_fire (960 = no fires yet)
    dow,
    has(clock.dateKey, "cpi") ? 1 : 0, has(clock.dateKey, "jobs") ? 1 : 0,
    has(clock.dateKey, "fomc") ? 1 : 0, has(prev1, "fomc") ? 1 : 0,
    reactToday ? 1 : 0, reactPrev ? 1 : 0, nvdaReact ? 1 : 0,
  ];
  const prob = predictProba(MODEL, features);
  const armed = prob >= MODEL.threshold;
  const { error } = await admin.from("lottery_day_stamps").insert({
    day: clock.dateKey, prob: Number(prob.toFixed(4)), armed,
    features: Object.fromEntries(MODEL.feats.map((name, i) => [name, features[i]])),
  });
  if (error) throw new Error(`lottery stamp persistence: ${error.message}`);
  if (armed) {
    const { data: owner } = await admin.from("profiles").select("id").limit(1).maybeSingle();
    if (owner) await createAlert({
      userId: String(owner.id), eventKey: `lottery-armed-${clock.dateKey}`, severity: "warning",
      title: `🎰 LOTTERY SOIL: today scores in the detector's armed band (p=${prob.toFixed(2)})`,
      body: `By 11:00 the day's shape (${rows.length} fires, max leg ${features[1].toFixed(1)}%, ${features[2]} symbols${features[9] ? ", megacap earnings reaction day" : ""}${features[7] ? ", Fed day" : ""}) puts today in the detector's top band. On unseen 2026 data, armed days carried 59% of all penny-swarm profit while being 13% of days — but the model is a tilt (AUC 0.57), not an oracle: most armed days still produce nothing. Context for sizing courage, never a trigger.`,
      metadata: { kind: "lottery_day_armed", day: clock.dateKey, prob, features },
    }).catch(() => undefined);
  }
  return { stamped: true };
}

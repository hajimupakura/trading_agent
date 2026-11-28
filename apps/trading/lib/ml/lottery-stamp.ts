import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getMarketCalendar } from "@/lib/market/calendar-server";
import { addDays, type MarketCalendar } from "@/lib/market/calendar";
import { STOCK_FEED } from "@/lib/alpaca/data-plan";
import { MIN_LEG_PCT, morningLegs } from "./morning-legs";
import { LOTTERY_SHADOW_MODEL, LOTTERY_THRESHOLD, priorSessionFeatures, scoreLotteryDay, type MinuteBar } from "./lottery-detector";

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
//
// 2026-11-28 (user call: "fix this" on Opus's suggestion): the frozen causal candidate
// from the 11/28 rebuild is now SCORED each morning and its probability stored in
// `prob` (+ features.shadow) — still armed=false, still read by nothing that trades.
// That turns every future session into an out-of-sample test at zero cost.

// The names the historical bar set covers; the aggregate inputs use exactly these so
// live stamps stay comparable with the history a future model is trained on.
const UNIVERSE = ["SLV", "QQQ", "SPY", "GLD", "TSLA", "MU", "NVDA", "META", "MSFT", "GOOGL", "AAPL", "SMCI", "SPCX", "SNDK"];
const MEGACAPS = new Set(["NVDA", "AAPL", "TSLA", "MSFT", "META", "GOOGL"]);

const ET = "America/New_York";
const etNow = () => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: ET, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map(part => [part.type, part.value]));
  return { weekday: String(parts.weekday), minutes: Number(parts.hour) * 60 + Number(parts.minute), dateKey: new Intl.DateTimeFormat("en-CA", { timeZone: ET }).format(new Date()) };
};
// The previous EXCHANGE session (holidays skipped), as the research census used.
const prevSession = (calendar: MarketCalendar, dateKey: string): string => {
  let key = addDays(dateKey, -1);
  for (let i = 0; i < 10 && !calendar.isTradingDay(key); i++) key = addDays(key, -1);
  return key;
};

// One regular session of 1-minute bars for SPY/QQQ, ET minute-stamped, from Alpaca.
async function sessionBars(symbol: string, dateKey: string, openMin: number, closeMin: number): Promise<MinuteBar[]> {
  const key = process.env.ALPACA_API_KEY_ID; const secret = process.env.ALPACA_API_SECRET_KEY;
  if (!key || !secret) throw new Error("Alpaca market-data keys are not configured");
  const url = new URL(`https://data.alpaca.markets/v2/stocks/${symbol}/bars`);
  url.searchParams.set("timeframe", "1Min"); url.searchParams.set("start", `${dateKey}T12:00:00Z`); url.searchParams.set("end", `${dateKey}T23:00:00Z`);
  url.searchParams.set("feed", STOCK_FEED); url.searchParams.set("adjustment", "all"); url.searchParams.set("sort", "asc"); url.searchParams.set("limit", "1000");
  const response = await fetch(url, { headers: { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret }, cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Alpaca ${symbol} bars ${dateKey}: ${response.status}`);
  const payload = await response.json() as { bars?: Array<{ t: string; o: number; h: number; l: number; c: number }> };
  const dayOf = new Intl.DateTimeFormat("en-CA", { timeZone: ET });
  const minuteOf = new Intl.DateTimeFormat("en-US", { timeZone: ET, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return (payload.bars ?? []).flatMap(bar => {
    const at = new Date(bar.t);
    if (dayOf.format(at) !== dateKey) return [];
    const parts = Object.fromEntries(minuteOf.formatToParts(at).map(part => [part.type, part.value]));
    const min = Number(parts.hour) * 60 + Number(parts.minute);
    return min >= openMin && min < closeMin && bar.c > 0 ? [{ min, open: bar.o, high: bar.h, low: bar.l, close: bar.c }] : [];
  });
}

export async function runLotteryDayStamp(): Promise<{ stamped: boolean; skipped?: string }> {
  const clock = etNow();
  if (["Sat", "Sun"].includes(clock.weekday)) return { stamped: false, skipped: "weekend" };
  if (clock.minutes < 660 || clock.minutes > 675) return { stamped: false, skipped: "outside 11:00-11:15 window" };
  const admin = createAdminClient();
  const { data: existing } = await admin.from("lottery_day_stamps").select("day").eq("day", clock.dateKey).maybeSingle();
  if (existing) return { stamped: false, skipped: "already stamped" };
  const calendar = await getMarketCalendar();
  if (!calendar.isTradingDay(clock.dateKey)) return { stamped: false, skipped: "market holiday" };
  const prev1 = prevSession(calendar, clock.dateKey);
  const prev2 = prevSession(calendar, prev1);
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
  // Shadow score. SPY/QQQ context comes from Alpaca; a failed fetch is NOT hidden — the
  // missing flag goes in (as it did for gaps in history) and the error is written down.
  const errors: string[] = [];
  const priorSession = calendar.session(prev1); const todaySession = calendar.session(clock.dateKey);
  const context = await Promise.all(["SPY", "QQQ"].map(async sym => {
    try {
      if (!priorSession || !todaySession) throw new Error("no calendar session");
      const [prior, today] = await Promise.all([sessionBars(sym, prev1, priorSession.openMin, priorSession.closeMin), sessionBars(sym, clock.dateKey, todaySession.openMin, todaySession.closeMin)]);
      return priorSessionFeatures(prior, today, priorSession.closeMin);
    } catch (error) {
      errors.push(`${sym}: ${error instanceof Error ? error.message : String(error)}`);
      return [0, 0, 0, 1] as [number, number, number, number];
    }
  }));
  const vector = [features.n_by11, features.maxleg_by11, features.syms_by11, features.first_fire, features.dow,
    features.cpi, features.jobs, features.fomc, features.fomc_prev, features.megacap_react, features.react_prev, features.nvda_react,
    ...context[0], ...context[1], 0];
  const prob = scoreLotteryDay(vector);
  const shadow = { model: LOTTERY_SHADOW_MODEL, prob, threshold: LOTTERY_THRESHOLD, wouldArm: prob >= LOTTERY_THRESHOLD, vector, errors };
  if (errors.length) console.error("lottery shadow score: index context missing", errors);
  // armed stays false: the convexity sleeve reads `armed`, and this model has not earned it.
  const { error } = await admin.from("lottery_day_stamps").insert({ day: clock.dateKey, prob, armed: false, features: { ...features, shadow }, model: `inputs+${LOTTERY_SHADOW_MODEL}` });
  if (error) throw new Error(`lottery stamp persistence: ${error.message}`);
  return { stamped: true };
}

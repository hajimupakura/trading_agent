import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAlert } from "@/lib/alerts/server";
import { todaysEconomicEvent } from "./economic-calendar";

// Deterministic early-warning radar, run by the every-minute cron. These are NOT
// predictions — they are conditions that historically precede outsized moves:
//   0. Event-risk briefing (CPI/NFP mornings, FOMC middays).
//   1. Gap radar (pre-market): SPY indicated far from yesterday's close.
//   2. Early trend-day check (9:47-10:00): one-sided opening drive through prior-day levels.
//   3. Regime-shift check (after the close): range compression broken by a trend day
//      closing on its extreme — the exact 8/1->8/3 pattern that preceded the 8/4 surge.
// Each check is isolated: one failure cannot silence the others.

interface DailyBar { date: string; open: number; high: number; low: number; close: number }

const et = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" }).formatToParts(date);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { minutes: Number(value.hour) * 60 + Number(value.minute), weekday: value.weekday };
};
const etDate = (date = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(date);

function headers() {
  const key = process.env.ALPACA_API_KEY_ID; const secret = process.env.ALPACA_API_SECRET_KEY;
  if (!key || !secret) throw new Error("Alpaca keys are not configured");
  return { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret };
}

async function getDailyBars(): Promise<DailyBar[]> {
  const url = new URL("https://data.alpaca.markets/v2/stocks/SPY/bars");
  url.searchParams.set("timeframe", "1Day"); url.searchParams.set("feed", "iex"); url.searchParams.set("limit", "25");
  url.searchParams.set("adjustment", "all"); url.searchParams.set("sort", "asc");
  const response = await fetch(url, { headers: headers(), cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Alpaca daily bars ${response.status}`);
  const payload = await response.json() as { bars?: Array<{ t: string; o: number; h: number; l: number; c: number }> };
  return (payload.bars ?? []).map(bar => ({ date: etDate(new Date(bar.t)), open: bar.o, high: bar.h, low: bar.l, close: bar.c }));
}

async function getMinuteBars(includePremarket: boolean): Promise<Array<{ minutes: number; open: number; high: number; low: number; close: number }>> {
  const url = new URL("https://data.alpaca.markets/v2/stocks/SPY/bars");
  url.searchParams.set("timeframe", "1Min"); url.searchParams.set("feed", "iex"); url.searchParams.set("limit", "1000");
  url.searchParams.set("start", etDate()); url.searchParams.set("adjustment", "all"); url.searchParams.set("sort", "asc");
  const response = await fetch(url, { headers: headers(), cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Alpaca minute bars ${response.status}`);
  const payload = await response.json() as { bars?: Array<{ t: string; o: number; h: number; l: number; c: number }> };
  return (payload.bars ?? []).map(bar => ({ minutes: et(new Date(bar.t)).minutes, open: bar.o, high: bar.h, low: bar.l, close: bar.c }))
    .filter(bar => includePremarket ? bar.minutes >= 240 : (bar.minutes >= 570 && bar.minutes < 960));
}

async function ownerId(): Promise<string | null> {
  const { data } = await createAdminClient().from("profiles").select("id").limit(1).maybeSingle();
  return data?.id ?? null;
}

export async function runMarketRadar(): Promise<{ fired: string[]; errors: string[] }> {
  const clock = et();
  const fired: string[] = []; const errors: string[] = [];
  if (["Sat", "Sun"].includes(clock.weekday)) return { fired, errors };
  const userId = await ownerId();
  if (!userId) return { fired, errors };
  const today = etDate();
  const guard = async (label: string, run: () => Promise<void>) => {
    try { await run(); } catch (error) { errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
  };

  // 0) Event-risk briefing: pre-market on CPI/NFP days, midday before FOMC decisions.
  await guard("event", async () => {
    const event = todaysEconomicEvent();
    if (!event) return;
    const morningWindow = clock.minutes >= 420 && clock.minutes < 570 && event.guardStartMinutes === 0;
    const fomcWindow = clock.minutes >= 750 && clock.minutes < 810 && event.guardStartMinutes > 0;
    if (!morningWindow && !fomcWindow) return;
    await createAlert({
      userId, eventKey: `radar-event-${today}`, severity: event.guarded ? "critical" : "warning",
      title: `${event.guarded ? "Event risk" : "Data release"} today: ${event.name} at ${event.releaseLabel}`,
      body: event.guarded
        ? `${event.name} lands at ${event.releaseLabel}. These releases gap markets through stops in seconds; the engine blocks new entries ${event.guardStartMinutes === 0 ? "until 10:00 AM ET" : "from 1:30 PM until 3:00 PM ET"} (toggle in Settings). Review open positions and swing exposure before the release.`
        : `${event.name} lands at ${event.releaseLabel}. This is a second-tier release — it can move the market (especially rate-sensitive names) but usually less than CPI or jobs day, so the engine does NOT restrict entries for it. A summary of the numbers and the market's reaction arrives about 10 minutes after the release.`,
      metadata: { event: event.name, guarded: event.guarded },
    });
    fired.push("event");
  });

  let dailies: DailyBar[] = []; let priorBar: DailyBar | null = null;
  await guard("dailies", async () => {
    dailies = await getDailyBars();
    priorBar = [...dailies].reverse().find(bar => bar.date < today) ?? null;
  });
  const prior = priorBar as DailyBar | null;
  if (!prior) return { fired, errors };

  // 1) Gap radar: pre-market 7:00-9:29 ET.
  if (clock.minutes >= 420 && clock.minutes < 570) await guard("gap", async () => {
    const premarket = await getMinuteBars(true);
    const last = premarket.filter(bar => bar.minutes < 570).at(-1);
    if (!last) return;
    const gapPct = (last.close / prior.close - 1) * 100;
    if (Math.abs(gapPct) < 0.5) return;
    const up = gapPct > 0;
    await createAlert({
      userId, eventKey: `radar-gap-${today}`, severity: "warning",
      title: `Gap radar: SPY indicated ${up ? "+" : ""}${gapPct.toFixed(2)}% pre-market`,
      body: `SPY is trading near $${last.close.toFixed(2)} pre-market vs yesterday's $${prior.close.toFixed(2)} close. Large gaps often resolve as gap-and-go trend days — the trend-continuation setup (not the opening-range setup) is the relevant playbook. Confirm direction after the first 15 minutes; do not chase the open.`,
      metadata: { gapPct, premarketPrice: last.close, priorClose: prior.close },
    });
    fired.push("gap");
  });

  // 2) Early trend-day check: 9:47-10:00 ET, after the opening range completes.
  if (clock.minutes >= 587 && clock.minutes <= 600) await guard("trend", async () => {
    const session = await getMinuteBars(false);
    if (session.length < 15) return;
    const opening = session.slice(0, 15);
    const orHigh = Math.max(...opening.map(bar => bar.high));
    const orLow = Math.min(...opening.map(bar => bar.low));
    const last = session.at(-1)!;
    const width = Math.max(orHigh - orLow, 0.01);
    const positionInRange = (last.close - orLow) / width;
    if (last.close > prior.high && positionInRange >= 0.8) {
      await createAlert({
        userId, eventKey: `radar-trend-up-${today}`, severity: "warning",
        title: "Early trend-day conditions: upside drive through yesterday's high",
        body: `First 15 minutes closed in the top of the opening range and above yesterday's high ($${prior.high.toFixed(2)}). One-sided opens that hold above prior-day levels have elevated odds of trending all session. Watch for the engine's opening-range or trend-continuation signal rather than entering blind.`,
        metadata: { orHigh, orLow, close: last.close, priorHigh: prior.high },
      });
      fired.push("trend-up");
    } else if (last.close < prior.low && positionInRange <= 0.2) {
      await createAlert({
        userId, eventKey: `radar-trend-down-${today}`, severity: "warning",
        title: "Early trend-day conditions: downside drive through yesterday's low",
        body: `First 15 minutes closed at the bottom of the opening range and below yesterday's low ($${prior.low.toFixed(2)}). Mirror playbook: puts on the engine's signal, not on impulse.`,
        metadata: { orHigh, orLow, close: last.close, priorLow: prior.low },
      });
      fired.push("trend-down");
    }
  });

  // 3) Regime-shift check: 16:05-16:30 ET, once today's daily bar exists.
  if (clock.minutes >= 965 && clock.minutes <= 990) await guard("regime", async () => {
    const todayBar = dailies.find(bar => bar.date === today);
    const history = dailies.filter(bar => bar.date < today);
    if (!todayBar || history.length < 20) return;
    const range = (bar: DailyBar) => bar.high - bar.low;
    const recent = history.slice(-5).reduce((sum, bar) => sum + range(bar), 0) / 5;
    const baseline = history.slice(-20).reduce((sum, bar) => sum + range(bar), 0) / 20;
    const compressed = recent < baseline * 0.75;
    const body = Math.abs(todayBar.close - todayBar.open);
    const trendDay = body / Math.max(range(todayBar), 0.01) >= 0.7;
    const closedHigh = (todayBar.high - todayBar.close) <= range(todayBar) * 0.15 && todayBar.close > prior.high;
    const closedLow = (todayBar.close - todayBar.low) <= range(todayBar) * 0.15 && todayBar.close < prior.low;
    if (!compressed || !trendDay || (!closedHigh && !closedLow)) return;
    const direction = closedHigh ? "upward" : "downward";
    await createAlert({
      userId, eventKey: `radar-regime-${today}`, severity: "critical",
      title: `Regime shift: compression broke ${direction} — elevated continuation odds tomorrow`,
      body: `The last 5 sessions were unusually quiet (ranges ~${((recent / baseline) * 100).toFixed(0)}% of the 20-day norm) and today broke ${direction} on a trend day that closed at its extreme — the same pattern that preceded the 8/3-8/4 rally. Continuation at the next open is more likely than usual: review swing exposure tonight and be ready for a gap-and-go playbook tomorrow. This is a probability tilt, not a prediction.`,
      metadata: { compressionRatio: recent / baseline, trendBody: body / range(todayBar), close: todayBar.close },
    });
    fired.push("regime");
  });

  return { fired, errors };
}

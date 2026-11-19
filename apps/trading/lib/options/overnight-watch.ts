import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAlert } from "@/lib/alerts/server";
import { getFuturesGlimpse } from "./futures";

// OVERNIGHT SPX WATCH (2026-11-19, user call: "SPX starts trading at 8:15 PM —
// we want to take advantage of that"). SPX options trade Cboe GTH on Robinhood
// (8:15 PM – 9:25 AM ET) but Alpaca cannot trade index options off-hours, so
// overnight execution is the USER's hand — this watch is the system's overnight
// eyes: ES futures (SPX ± small basis, trading 6 PM – 5 PM) sampled every ~5
// minutes through the night, with alerts when something becomes actionable.
//   - GTH open read (~8:20 PM): where the night starts.
//   - Gap thresholds: ES-implied SPX gap crossing ±0.3% / ±0.6% / ±1.0% —
//     each fires once per night per direction. 0.3% ~= the morning drive
//     qualifying bar forming early; the user can act overnight or stand ready.
//   - Overnight ignition: >=0.4% ES move inside 30 minutes (news hitting the
//     tape while the US sleeps) — at most one alert per 2-hour window.
//   - Early read (~7:30 AM): the night's range + current implied gap, ahead of
//     the 9:25 Morning Card.
// Samples persist in index_bar_samples under symbol 'ES' so the night's range
// is queryable and the Morning Card can cite it later.

const ET = "America/New_York";
const etParts = () => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: ET, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map(part => [part.type, part.value]));
  return { weekday: String(parts.weekday), minutes: Number(parts.hour) * 60 + Number(parts.minute) };
};
const etDateOf = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: ET }).format(new Date(ms));
// A "night" is keyed by the morning it leads into, so alerts spanning midnight dedupe together.
const nightKey = (minutes: number) => etDateOf(minutes >= 1215 ? Date.now() + 86_400_000 : Date.now());

async function alertOnce(admin: ReturnType<typeof createAdminClient>, userId: string, eventKey: string, severity: "info" | "warning", title: string, body: string): Promise<boolean> {
  const { data: seen } = await admin.from("alerts").select("id").eq("event_key", eventKey).limit(1).maybeSingle();
  if (seen) return false;
  await createAlert({ userId, eventKey, severity, title, body, metadata: { kind: "overnight_watch" } }).catch(() => undefined);
  return true;
}

export async function runOvernightWatch(): Promise<{ active: boolean; fired: string[] }> {
  const { weekday, minutes } = etParts();
  // GTH window: Sun 20:15 through Fri 9:25 ET; the watch also covers the 18:00-20:15
  // futures-only stretch so the 8:15 open read has context. Off Sat entirely.
  const eveningActive = minutes >= 1215 && !["Fri", "Sat"].includes(weekday);
  const morningActive = minutes < 565 && !["Sat", "Sun"].includes(weekday);
  if (!eveningActive && !morningActive) return { active: false, fired: [] };
  if (minutes % 5 !== 1) return { active: true, fired: [] }; // sample cadence, offset from heavy jobs
  const admin = createAdminClient();
  const { data: owner } = await admin.from("profiles").select("id").limit(1).maybeSingle();
  if (!owner) return { active: true, fired: [] };
  const userId = String(owner.id);
  const fired: string[] = [];

  const glimpse = await getFuturesGlimpse();
  const es = glimpse.rows.find(row => row.product === "ES");
  if (!es || !(es.price > 0)) return { active: true, fired };
  const gapPct = es.changePct; // vs prior settle ~= implied SPX gap
  const night = nightKey(minutes);

  // Persist the sample for range queries and the ignition lookback.
  const barTime = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
  await admin.from("index_bar_samples").upsert({ symbol: "ES", bar_time: barTime, price: es.price, source: es.source }, { onConflict: "symbol,bar_time" });

  // 1. GTH open read, once per night (~8:16-8:30 PM).
  if (minutes >= 1216 && minutes <= 1230 && gapPct != null) {
    if (await alertOnce(admin, userId, `overnight-open-${night}`, "info",
      `Overnight session open — ES implies SPX ${gapPct >= 0 ? "+" : ""}${gapPct.toFixed(2)}%`,
      `SPX options are live on Robinhood until 9:25 AM. ES futures at ${es.price.toFixed(2)} imply a ${gapPct >= 0 ? "+" : ""}${gapPct.toFixed(2)}% SPX gap right now. Quiet so far unless alerts follow — the next word is at 7:30 AM, or sooner if the night moves.`)) fired.push("open-read");
  }

  // 2. Implied-gap thresholds, once per night per level+direction.
  if (gapPct != null) {
    for (const level of [0.3, 0.6, 1.0]) {
      if (Math.abs(gapPct) < level) continue;
      const direction = gapPct > 0 ? "up" : "down";
      if (await alertOnce(admin, userId, `overnight-gap-${night}-${direction}-${level}`, level >= 0.6 ? "warning" : "info",
        `Overnight: ES-implied SPX gap crossed ${gapPct > 0 ? "+" : "−"}${level.toFixed(1)}%`,
        `ES at ${es.price.toFixed(2)} implies SPX ${gapPct >= 0 ? "+" : ""}${gapPct.toFixed(2)}% vs yesterday's close. ${level >= 0.3 ? "That is drive-qualifying territory if it holds to the open. " : ""}SPX options are tradeable NOW on Robinhood's overnight session (thin book — use limits, size small). The 9:25 card gives the official verdict.`)) fired.push(`gap-${direction}-${level}`);
    }
  }

  // 3. Overnight ignition: >=0.4% move inside ~30 minutes, max one alert per 2h window.
  const { data: lookback } = await admin.from("index_bar_samples").select("price").eq("symbol", "ES")
    .lte("bar_time", new Date(Date.now() - 28 * 60_000).toISOString())
    .order("bar_time", { ascending: false }).limit(1).maybeSingle();
  const past = Number(lookback?.price);
  if (past > 0) {
    const move30 = (es.price / past - 1) * 100;
    if (Math.abs(move30) >= 0.4) {
      const windowKey = Math.floor(Date.now() / (2 * 3_600_000));
      if (await alertOnce(admin, userId, `overnight-ignition-${night}-${windowKey}`, "warning",
        `Overnight ignition: ES ${move30 > 0 ? "+" : ""}${move30.toFixed(2)}% in ~30 min`,
        `Something is moving the market overnight — ES went from ${past.toFixed(2)} to ${es.price.toFixed(2)} in about half an hour${gapPct != null ? ` (implied SPX gap now ${gapPct >= 0 ? "+" : ""}${gapPct.toFixed(2)}%)` : ""}. If you know the catalyst, SPX options are live on Robinhood right now. The DKNG lesson: the first minutes of a real catalyst are where the convexity is.`)) fired.push("ignition");
    }
  }

  // 4. Early read (~7:26-7:40 AM): the night's story before the 9:25 card.
  if (minutes >= 446 && minutes <= 460 && gapPct != null) {
    const { data: nightRows } = await admin.from("index_bar_samples").select("price").eq("symbol", "ES")
      .gte("bar_time", new Date(Date.now() - 13 * 3_600_000).toISOString()).order("bar_time");
    const prices = (nightRows ?? []).map(row => Number(row.price)).filter(price => price > 0);
    const high = prices.length ? Math.max(...prices) : es.price;
    const low = prices.length ? Math.min(...prices) : es.price;
    if (await alertOnce(admin, userId, `overnight-digest-${etDateOf(Date.now())}`, "info",
      `Overnight recap — ES implies SPX ${gapPct >= 0 ? "+" : ""}${gapPct.toFixed(2)}%`,
      `The night's ES range: ${low.toFixed(2)} – ${high.toFixed(2)}, now ${es.price.toFixed(2)} (implied SPX gap ${gapPct >= 0 ? "+" : ""}${gapPct.toFixed(2)}%). Overnight SPX trading closes 9:25; the Morning Card lands 9:25 with the official qualify/stand-down verdict.`)) fired.push("digest");
  }

  return { active: true, fired };
}

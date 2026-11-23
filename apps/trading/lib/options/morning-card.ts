import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAlert } from "@/lib/alerts/server";
import { todaysEconomicEvent } from "./economic-calendar";
import type { CommandCenter } from "./types";

// SPX MORNING CARD (2026-11-19, user call: "I just want to be trading SPX only —
// what can I be following daily?"). One alert at ~9:25 ET with the measured
// checklist pre-computed: overnight gap read, drive trigger levels, prior-day
// levels, 52-week-high distance, econ flags, and a verdict. The evidence base:
// the 67-session opening-drive sweep (gap >=0.2% = the only validated trigger;
// flat-open days produced all the chop losses) and the drive exit grid (protect
// by 10:15, invalidate below the day's open). The card feeds the user's hand —
// it trades nothing.
// SPX cash doesn't print pre-market, so the gap read uses SPY's pre-market tape
// (the standard proxy). SPX prior-day levels come from the live snapshot when it
// has them, else are rebuilt from our own chain-sampled index bars
// (index_bar_samples) — the index read is assembled during RTH only, so at 9:25
// the snapshot usually has no market state yet; that is normal, not an outage.

const ET = "America/New_York";
const etNow = () => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: ET, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map(part => [part.type, part.value]));
  return { weekday: String(parts.weekday), minutes: Number(parts.hour) * 60 + Number(parts.minute) };
};
const etToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: ET }).format(new Date());

function alpacaHeaders() {
  const key = process.env.ALPACA_API_KEY_ID; const secret = process.env.ALPACA_API_SECRET_KEY;
  if (!key || !secret) throw new Error("Alpaca keys are not configured");
  return { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret };
}
async function alpacaJson<T>(url: URL): Promise<T> {
  const response = await fetch(url, { headers: alpacaHeaders(), cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Alpaca ${response.status} (${url.pathname})`);
  return await response.json() as T;
}

// SPY daily bars for prior close + 52-week high; pre-market minute tape for the gap read.
async function spyRead() {
  const daily = new URL("https://data.alpaca.markets/v2/stocks/SPY/bars");
  daily.searchParams.set("timeframe", "1Day"); daily.searchParams.set("feed", "iex");
  daily.searchParams.set("start", new Date(Date.now() - 370 * 86_400_000).toISOString().slice(0, 10));
  daily.searchParams.set("limit", "400"); daily.searchParams.set("adjustment", "all");
  const dailyBars = (await alpacaJson<{ bars?: Array<{ t: string; h: number; l: number; c: number }> }>(daily)).bars ?? [];
  const today = etToday();
  const prior = dailyBars.filter(bar => bar.t.slice(0, 10) < today);
  if (!prior.length) throw new Error("no prior daily bars");
  const priorDay = prior[prior.length - 1];
  const yearHigh = Math.max(...prior.slice(-252).map(bar => bar.h));
  const minute = new URL("https://data.alpaca.markets/v2/stocks/SPY/bars");
  minute.searchParams.set("timeframe", "1Min"); minute.searchParams.set("feed", "iex");
  minute.searchParams.set("start", `${today}T04:00:00-05:00`); minute.searchParams.set("limit", "10000");
  const minuteBars = (await alpacaJson<{ bars?: Array<{ t: string; c: number }> }>(minute)).bars ?? [];
  const last = minuteBars.length ? minuteBars[minuteBars.length - 1].c : null;
  return { priorClose: priorDay.c, priorHigh: priorDay.h, priorLow: priorDay.l, yearHigh, premarketLast: last };
}

export async function runSpxMorningCard(): Promise<{ sent: boolean }> {
  const clock = etNow();
  if (["Sat", "Sun"].includes(clock.weekday) || clock.minutes < 560 || clock.minutes > 568) return { sent: false };
  const admin = createAdminClient();
  const today = etToday();
  const eventKey = `spx-morning-card-${today}`;
  const { data: seen } = await admin.from("alerts").select("id").eq("event_key", eventKey).limit(1).maybeSingle();
  if (seen) return { sent: false };
  const { data: owner } = await admin.from("profiles").select("id").limit(1).maybeSingle();
  if (!owner) return { sent: false };

  const spy = await spyRead();
  const gapPct = spy.premarketLast != null ? ((spy.premarketLast - spy.priorClose) / spy.priorClose) * 100 : null;
  const fromYearHigh = spy.premarketLast != null ? ((spy.premarketLast - spy.yearHigh) / spy.yearHigh) * 100 : null;

  // SPX levels: snapshot first, else rebuilt from yesterday's chain-sampled index bars.
  const { data: spxRow } = await admin.from("options_monitor_snapshots").select("payload").eq("underlying", "SPX").maybeSingle();
  const spxPayload = spxRow?.payload as CommandCenter | null;
  let spxPrior: { high: number; low: number; close: number } | null = spxPayload?.market?.priorDay ?? null;
  let spxFromSamples = false;
  if (!spxPrior) {
    const { data: sampleBars } = await admin.from("index_bar_samples").select("bar_time,price")
      .eq("symbol", "SPX").gte("bar_time", new Date(Date.now() - 7 * 86_400_000).toISOString())
      .order("bar_time", { ascending: true }).limit(3000);
    const etDateOf = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: ET }).format(new Date(iso));
    const priorDates = [...new Set((sampleBars ?? []).map(bar => etDateOf(bar.bar_time)))].filter(date => date < today).sort();
    const lastDate = priorDates[priorDates.length - 1];
    const dayBars = (sampleBars ?? []).filter(bar => etDateOf(bar.bar_time) === lastDate).map(bar => Number(bar.price));
    if (dayBars.length >= 30) {
      spxPrior = { high: Math.max(...dayBars), low: Math.min(...dayBars), close: dayBars[dayBars.length - 1] };
      spxFromSamples = true;
    }
  }
  const spxDark = !spxPrior;

  const econ = todaysEconomicEvent();
  const lines: string[] = [];
  if (spxDark) lines.push("⚠️ No SPX index read available — neither the snapshot nor yesterday's sampled bars have SPX levels. Card running on the SPY proxy alone; check the chain-sampling cron.");
  else if (spxFromSamples) lines.push("SPX levels from yesterday's chain-sampled bars (index read starts at the open — normal at 9:25).");
  if (gapPct != null) {
    lines.push(`Overnight gap read (SPY pre-market): ${gapPct >= 0 ? "+" : ""}${gapPct.toFixed(2)}% vs yesterday's close $${spy.priorClose.toFixed(2)}.`);
  } else {
    lines.push("No pre-market tape yet this morning — re-check at the open.");
  }
  lines.push(`Yesterday (SPY): high $${spy.priorHigh.toFixed(2)} · low $${spy.priorLow.toFixed(2)}${spxPrior ? ` | SPX: high ${Number(spxPrior.high).toFixed(0)} · low ${Number(spxPrior.low).toFixed(0)} · close ${Number(spxPrior.close).toFixed(0)}` : ""}.`);
  if (fromYearHigh != null) lines.push(`Distance from 52-week high: ${fromYearHigh.toFixed(1)}%${fromYearHigh > -0.5 ? " — ATH territory (ATH-cross days ran 8-for-13 in the study)" : ""}.`);
  if (econ) lines.push(`⚠️ ${econ.name} today (${econ.releaseLabel}) — event rules apply, expect violence around the print.`);
  // Overnight headlines (context, never signal): the top market-tagged stories since
  // yesterday's close, so a gap always arrives with its story attached. Best-effort —
  // a news-feed hiccup must never delay the 9:25 card.
  try {
    const { recentNews, newsAge } = await import("@/lib/news/market-news");
    const overnight = (await recentNews(null, 12)).filter(item => Date.now() - item.publishedAt < 17.5 * 3_600_000).slice(0, 4);
    if (overnight.length) lines.push(`📰 Overnight: ${overnight.map(item => `${item.headline.slice(0, 110)} (${newsAge(item.publishedAt)})`).join(" · ")}`);
  } catch { /* news feed down — card runs without it */ }
  const qualifies = gapPct != null && Math.abs(gapPct) >= 0.2;
  lines.push(qualifies
    ? `VERDICT: QUALIFIES — ${gapPct! > 0 ? "gap-UP drive candidate (calls)" : "gap-DOWN drive candidate (puts)"}. Trigger: first bars (9:31-9:34) holding ${gapPct! > 0 ? `above yesterday's high AND today's open` : `below yesterday's low AND today's open`}. Protect by 10:15; out instantly if price crosses back through the day's open.`
    : "VERDICT: no qualifying gap — stand down. Flat-open days are where the chop losses lived; doing nothing is the edge today.");

  await createAlert({
    userId: String(owner.id), eventKey, severity: qualifies ? "warning" : "info",
    title: `SPX Morning Card — ${qualifies ? "today QUALIFIES" : "stand down"}`,
    body: lines.join("\n"),
    metadata: { kind: "spx_morning_card", gapPct, qualifies, spxDark, spxFromSamples },
  }).catch(() => undefined);
  return { sent: true };
}

import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAlert } from "@/lib/alerts/server";
import { WATCH_UNDERLYINGS } from "./types";

// AFTERNOON-SETUP SCOREBOARD (2026-08-28): observation-only watchers for the two
// catalyst patterns the morning-only reset left uncovered, born from real misses:
//   - earnings_gap: NVDA 8/27 — big earnings gap, whipsaw open, then a 10:00->13:25
//     grind (+2.5%) our rules couldn't touch (morning entries were stopped, the
//     midday window is closed).
//   - volume_ignition: DKNG 8/28 — court-ruling headline at 12:47, one 150x-volume
//     minute bar, then +8% in an hour. Not on the watchlist, no detector, no lane.
// These watchers TRADE NOTHING. They record triggers in setup_watches, alert the
// user in real time (who can manually queue a paper ticket), and grade every
// trigger post-close with a managed-exit simulation on the underlying. When a
// kind shows a real record, it earns buying rights back through the promotion
// gate — the same evidence bar the whale scoreboard set (and flunked).

const ET = "America/New_York";
const etParts = () => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: ET, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map(part => [part.type, part.value]));
  return { weekday: String(parts.weekday), minutes: Number(parts.hour) * 60 + Number(parts.minute) };
};
const etToday = (daysAgo = 0) => new Intl.DateTimeFormat("en-CA", { timeZone: ET }).format(new Date(Date.now() - daysAgo * 86_400_000));
const etMinuteOf = (timestampMs: number) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: ET, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(timestampMs)).map(part => [part.type, part.value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
};

interface MinuteBar { t: number; o: number; h: number; l: number; c: number; v: number }

function alpacaHeaders() {
  const key = process.env.ALPACA_API_KEY_ID; const secret = process.env.ALPACA_API_SECRET_KEY;
  if (!key || !secret) throw new Error("Alpaca keys are not configured");
  return { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret };
}

// Regular-session minute bars for an equity (IEX feed — partial volume, but
// spikes stay proportional so N-x multiples remain detectable). daysBack > 0
// reaches into prior sessions (weekends included — callers split by date).
async function sessionMinuteBars(symbol: string, daysBack = 0): Promise<MinuteBar[]> {
  const url = new URL(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/bars`);
  url.searchParams.set("timeframe", "1Min"); url.searchParams.set("feed", "iex");
  url.searchParams.set("start", `${etToday(daysBack)}T09:30:00-04:00`); url.searchParams.set("limit", "10000");
  const response = await fetch(url, { headers: alpacaHeaders(), cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Alpaca bars ${response.status} for ${symbol}`);
  const payload = await response.json() as { bars?: Array<{ t: string; o: number; h: number; l: number; c: number; v: number }> };
  return (payload.bars ?? []).map(bar => ({ t: Date.parse(bar.t), o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v }))
    .filter(bar => { const minute = etMinuteOf(bar.t); return minute >= 570 && minute < 960; });
}

async function owner(admin: ReturnType<typeof createAdminClient>) {
  const { data } = await admin.from("profiles").select("id").limit(1).maybeSingle();
  return data ? String(data.id) : null;
}

// ---------- Watcher 1: earnings-gap continuation (arms 9:35-9:43) ----------
// A watchlist name that reported earnings (AMC yesterday or BMO today) and gapped
// |>=3%| gets a watch row. Graded later on the "first new extreme after 10:00"
// continuation rule — the NVDA pattern.
async function armEarningsGapWatches(): Promise<string[]> {
  const admin = createAdminClient();
  const singles = WATCH_UNDERLYINGS.filter(symbol => !["QQQ", "SLV", "GLD"].includes(symbol));
  const { data: reports, error: reportsError } = await admin.from("earnings_calendar")
    .select("symbol,report_date,timing").in("symbol", singles)
    .in("report_date", [etToday(), etToday(1)]);
  if (reportsError) throw new Error(`earnings calendar unavailable: ${reportsError.message}`);
  const reporters = (reports ?? []).filter(row =>
    row.report_date === etToday() || (row.report_date === etToday(1) && String(row.timing).toLowerCase() !== "bmo"));
  const armed: string[] = [];
  for (const report of reporters) {
    const { data: snap } = await admin.from("options_monitor_snapshots").select("payload,updated_at").eq("underlying", report.symbol).maybeSingle();
    const market = (snap?.payload as { market?: { priorDay?: { close?: number }; bars?: Array<{ timestamp: number; open: number; high: number; close: number }> } } | null)?.market;
    const priorClose = market?.priorDay?.close;
    const sessionBars = (market?.bars ?? []).filter(bar => etMinuteOf(bar.timestamp) >= 570);
    if (!priorClose || !sessionBars.length) continue; // no data -> no watch; blindspot checks own snapshot health
    const dayOpen = sessionBars[0].open;
    const gapPct = ((dayOpen - priorClose) / priorClose) * 100;
    if (Math.abs(gapPct) < 3) continue;
    const direction = gapPct > 0 ? "bullish" : "bearish";
    const { error } = await admin.from("setup_watches").insert({
      kind: "earnings_gap", symbol: report.symbol, watch_date: etToday(), direction,
      trigger_price: dayOpen, detail: { gapPct: Number(gapPct.toFixed(2)), priorClose, dayOpen, reportDate: report.report_date, timing: report.timing },
    });
    if (error && error.code !== "23505") throw new Error(`earnings watch insert failed: ${error.message}`);
    if (!error) {
      armed.push(report.symbol);
      const uid = await owner(admin);
      if (uid) await createAlert({
        userId: uid, eventKey: `setup-watch-egap-${report.symbol}-${etToday()}`, severity: "info",
        title: `Earnings-gap watch armed: ${report.symbol} ${gapPct > 0 ? "+" : ""}${gapPct.toFixed(1)}%`,
        body: `${report.symbol} reported earnings and gapped ${gapPct.toFixed(1)}%. Watching (NOT trading) the NVDA pattern: does it break its morning ${direction === "bullish" ? "high" : "low"} after 10:00 and keep going? Graded tonight into the afternoon-setup scoreboard.`,
        metadata: { kind: "setup_watch", watchKind: "earnings_gap", symbol: report.symbol },
      }).catch(() => undefined);
    }
  }
  return armed;
}

// ---------- Watcher 2: volume ignition (every 5 min, 9:35-15:50) ----------
// Scan Alpaca's top movers; a candidate ignites when a minute bar in the last 15
// minutes printed an outsized multiple of the PRIOR session's median minute
// volume alongside a >=0.8% one-bar (or >=1.5% three-bar) thrust — the DKNG
// pattern. Prior-session baseline (not same-day) so the scan works from 9:35:
// the first half hour naturally runs ~5-20x midday volume, so before 10:00 the
// required multiple is 25x vs 15x after. Alerted live so the user can act
// manually; the watcher itself only records.
async function scanVolumeIgnitions(): Promise<string[]> {
  const admin = createAdminClient();
  const response = await fetch("https://data.alpaca.markets/v1beta1/screener/stocks/movers?top=12", { headers: alpacaHeaders(), cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Alpaca movers ${response.status}`);
  const movers = await response.json() as { gainers?: Array<{ symbol: string; price: number; percent_change: number }>; losers?: Array<{ symbol: string; price: number; percent_change: number }> };
  const candidates = [...(movers.gainers ?? []), ...(movers.losers ?? [])]
    .filter(mover => mover.price >= 5 && Math.abs(mover.percent_change) >= 3 && /^[A-Z]{1,5}$/.test(mover.symbol));
  if (!candidates.length) return [];
  const { data: existing, error: existingError } = await admin.from("setup_watches").select("symbol").eq("kind", "volume_ignition").eq("watch_date", etToday());
  if (existingError) throw new Error(`watch dedupe unavailable: ${existingError.message}`);
  const seen = new Set((existing ?? []).map(row => String(row.symbol)));
  const fresh = candidates.filter(mover => !seen.has(mover.symbol)).slice(0, 4); // cap bar fetches per tick
  const ignited: string[] = [];
  for (const mover of fresh) {
    try {
      // ~5 calendar days of bars: the most recent PRIOR session is the volume
      // baseline (survives Mondays/holidays); today's bars carry the ignition.
      const all = await sessionMinuteBars(mover.symbol, 5);
      const today = etToday();
      const dayOf = (bar: MinuteBar) => new Intl.DateTimeFormat("en-CA", { timeZone: ET }).format(new Date(bar.t));
      const todayBars = all.filter(bar => dayOf(bar) === today);
      const priorDays = all.filter(bar => dayOf(bar) !== today);
      const lastPriorDay = priorDays.length ? dayOf(priorDays[priorDays.length - 1]) : null;
      const baselineBars = lastPriorDay ? priorDays.filter(bar => dayOf(bar) === lastPriorDay) : [];
      if (todayBars.length < 5 || baselineBars.length < 60) continue;
      const sorted = baselineBars.map(bar => bar.v).sort((a, b) => a - b);
      const median = Math.max(sorted[Math.floor(sorted.length / 2)] ?? 0, 30);
      const recent = todayBars.slice(-15);
      const ignition = recent.find((bar, index) => {
        const requiredMultiple = etMinuteOf(bar.t) < 600 ? 25 : 15; // opening bars run hot naturally
        const oneBarMove = Math.abs((bar.c - bar.o) / bar.o) * 100;
        const from = recent[Math.max(0, index - 2)];
        const threeBarMove = Math.abs((bar.c - from.o) / from.o) * 100;
        return bar.v >= requiredMultiple * median && (oneBarMove >= 0.8 || threeBarMove >= 1.5);
      });
      if (!ignition) continue;
      const direction = ignition.c >= ignition.o ? "bullish" : "bearish";
      const volMultiple = Number((ignition.v / median).toFixed(0));
      const { error } = await admin.from("setup_watches").insert({
        kind: "volume_ignition", symbol: mover.symbol, watch_date: etToday(), direction,
        triggered_at: new Date(ignition.t).toISOString(), trigger_price: ignition.c,
        detail: { volMultiple, medianVol: median, ignitionVol: ignition.v, dayChangePct: mover.percent_change, price: mover.price },
      });
      if (error && error.code !== "23505") throw new Error(`ignition insert failed: ${error.message}`);
      if (!error) {
        ignited.push(mover.symbol);
        const uid = await owner(admin);
        if (uid) await createAlert({
          userId: uid, eventKey: `setup-watch-vign-${mover.symbol}-${etToday()}`, severity: "warning",
          title: `Volume ignition: ${mover.symbol} ${direction === "bullish" ? "up" : "down"} on ${volMultiple}x volume`,
          body: `${mover.symbol} just printed a ${volMultiple}x-volume minute bar at $${ignition.c.toFixed(2)} (${mover.percent_change.toFixed(1)}% on the day) — the DKNG pattern. Observation-only: nothing was bought. If you know the catalyst and want in, say "buy ${mover.symbol}" and a paper ticket queues at the next tick. Graded tonight either way.`,
          metadata: { kind: "setup_watch", watchKind: "volume_ignition", symbol: mover.symbol, ignitionPrice: ignition.c },
        }).catch(() => undefined);
      }
    } catch (error) {
      console.error("ignition scan failed", mover.symbol, error instanceof Error ? error.message : error);
    }
  }
  return ignited;
}

// ---------- Post-close grading (16:10-16:40) ----------
// Managed-exit simulation on the UNDERLYING (thresholds sized so ~+1.2% underlying
// on a mover approximates a +25-40% ATM weekly option): stop -1.5%; trail arms at
// +1.0% and gives back 0.8% from peak; otherwise flat at the 15:55 mark.
// earnings_gap entries only exist if the morning extreme breaks after 10:00 —
// no continuation means verdict neutral with no entry, exactly like a skipped trade.
function simulateManaged(bars: MinuteBar[], entryIndex: number, entryPrice: number, direction: "bullish" | "bearish") {
  const sign = direction === "bullish" ? 1 : -1;
  let peak = 0, exitReturn: number | null = null;
  for (let index = entryIndex + 1; index < bars.length; index++) {
    const move = (sign * (bars[index].c - entryPrice) / entryPrice) * 100;
    peak = Math.max(peak, move);
    if (move <= -1.5) { exitReturn = move; break; }
    if (peak >= 1.0 && move <= peak - 0.8) { exitReturn = move; break; }
    if (etMinuteOf(bars[index].t) >= 955) { exitReturn = move; break; }
  }
  const last = bars[bars.length - 1];
  const closeReturn = (sign * (last.c - entryPrice) / entryPrice) * 100;
  return { managed: exitReturn ?? closeReturn, peak, close: closeReturn };
}

async function gradeTodaysWatches(): Promise<string[]> {
  const admin = createAdminClient();
  // Same-day only: the sim reads TODAY's bars, so a stale watch (missed grading
  // window, weekend restart) must never be graded against the wrong session.
  const { data: watching, error } = await admin.from("setup_watches").select("*").eq("status", "watching").eq("watch_date", etToday());
  if (error) throw new Error(`grading query failed: ${error.message}`);
  const graded: string[] = [];
  for (const watch of watching ?? []) {
    try {
      const bars = await sessionMinuteBars(String(watch.symbol));
      if (bars.length < 60) throw new Error("insufficient bars");
      let entryIndex = -1; let entryPrice: number | null = null;
      if (watch.kind === "earnings_gap") {
        const morning = bars.filter(bar => etMinuteOf(bar.t) < 600);
        const bullish = watch.direction === "bullish";
        const extreme = bullish ? Math.max(...morning.map(bar => bar.h)) : Math.min(...morning.map(bar => bar.l));
        entryIndex = bars.findIndex(bar => etMinuteOf(bar.t) >= 600 && (bullish ? bar.c > extreme : bar.c < extreme));
        if (entryIndex >= 0) entryPrice = bars[entryIndex].c;
      } else {
        entryIndex = bars.findIndex(bar => bar.t > Date.parse(String(watch.triggered_at)));
        if (entryIndex >= 0) entryPrice = bars[entryIndex].c;
      }
      if (entryIndex < 0 || entryPrice == null) {
        await admin.from("setup_watches").update({ status: "graded", verdict: "neutral", detail: { ...(watch.detail as object), note: "no continuation entry" } }).eq("id", watch.id);
        graded.push(`${watch.symbol}:neutral(no-entry)`);
        continue;
      }
      const result = simulateManaged(bars, entryIndex, entryPrice, watch.direction as "bullish" | "bearish");
      const verdict = result.managed >= 1.2 ? "confirmed" : result.managed <= -0.75 ? "refuted" : "neutral";
      await admin.from("setup_watches").update({
        status: "graded", entry_price: entryPrice,
        managed_ret: Number(result.managed.toFixed(2)), ret_peak: Number(result.peak.toFixed(2)), ret_close: Number(result.close.toFixed(2)),
        verdict,
      }).eq("id", watch.id);
      graded.push(`${watch.symbol}:${verdict}(${result.managed.toFixed(1)}%)`);
    } catch (gradeError) {
      await admin.from("setup_watches").update({ status: "error", detail: { ...(watch.detail as object), error: gradeError instanceof Error ? gradeError.message : String(gradeError) } }).eq("id", watch.id);
    }
  }
  if (graded.length) {
    const uid = await owner(admin);
    const { data: tally } = await admin.from("setup_watches").select("kind,verdict").eq("status", "graded");
    const summary = ["earnings_gap", "volume_ignition"].map(kind => {
      const rows = (tally ?? []).filter(row => row.kind === kind);
      const wins = rows.filter(row => row.verdict === "confirmed").length;
      const losses = rows.filter(row => row.verdict === "refuted").length;
      return `${kind.replace("_", "-")}: ${wins} confirmed / ${losses} refuted / ${rows.length - wins - losses} neutral`;
    }).join(" · ");
    if (uid) await createAlert({
      userId: uid, eventKey: `setup-watch-grades-${etToday()}`, severity: "info",
      title: `Afternoon-setup scoreboard: ${graded.length} graded today`,
      body: `Today: ${graded.join(", ")}. Running record — ${summary}. A kind earns live (paper) buying rights only when its record proves out.`,
      metadata: { kind: "setup_watch_grades" },
    }).catch(() => undefined);
  }
  return graded;
}

// Cron entry point: routes by clock, never throws (callers journal the error).
export async function runSetupWatches(): Promise<{ armed: string[]; ignited: string[]; graded: string[] }> {
  const { weekday, minutes } = etParts();
  const result = { armed: [] as string[], ignited: [] as string[], graded: [] as string[] };
  if (["Sat", "Sun"].includes(weekday)) return result;
  if (minutes >= 575 && minutes <= 583) result.armed = await armEarningsGapWatches();
  if (minutes >= 575 && minutes <= 950 && minutes % 5 === 0) result.ignited = await scanVolumeIgnitions();
  if (minutes >= 970 && minutes <= 1000) result.graded = await gradeTodaysWatches();
  return result;
}

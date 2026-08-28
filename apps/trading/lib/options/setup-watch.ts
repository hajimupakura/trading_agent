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

// ---------- Lottery expression (2026-08-28, user call) ----------
// The DKNG trade that named the pattern: a $0.01 nearest-expiry 25C bought minutes
// after ignition, peaked 159x. For every graded ignition, also price what the
// "catalyst lottery" — nearest expiry, first strike ~0.5%+ OTM in the trigger's
// direction, filled at the close of the bar 5 minutes post-ignition — would have
// done. Informational only (stored in detail.lottery, surfaced in the alert):
// the verdict stays on the underlying sim, but the scoreboard reports the number
// that decides whether an auto ignition-lottery lane ($50-100/trigger) is worth
// promoting. Fill-price honesty: bar closes, not bottom-of-book luck.
interface LotteryGrade { ticker: string; entry: number; peakX: number; closeX: number }
async function lotteryExpression(symbol: string, direction: "bullish" | "bearish", watchDate: string, triggeredAtMs: number, refPrice: number): Promise<LotteryGrade | { error: string }> {
  const key = process.env.MASSIVE_API_KEY;
  if (!key) return { error: "no data key" };
  const side = direction === "bullish" ? "call" : "put";
  const weekOut = new Intl.DateTimeFormat("en-CA", { timeZone: ET }).format(new Date(Date.parse(watchDate) + 8 * 86_400_000));
  const listUrl = new URL("https://api.massive.com/v3/reference/options/contracts");
  listUrl.searchParams.set("underlying_ticker", symbol); listUrl.searchParams.set("contract_type", side);
  listUrl.searchParams.set("expiration_date.gte", watchDate); listUrl.searchParams.set("expiration_date.lte", weekOut);
  listUrl.searchParams.set("limit", "250"); listUrl.searchParams.set("apiKey", key);
  const listResponse = await fetch(listUrl, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!listResponse.ok) return { error: `contract list ${listResponse.status}` };
  const listing = await listResponse.json() as { results?: Array<{ ticker: string; strike_price: number; expiration_date: string }> };
  const contracts = listing.results ?? [];
  if (!contracts.length) return { error: "no contracts listed" };
  const nearestExpiry = contracts.map(contract => contract.expiration_date).sort()[0];
  const atExpiry = contracts.filter(contract => contract.expiration_date === nearestExpiry);
  const pick = direction === "bullish"
    ? atExpiry.filter(contract => contract.strike_price >= refPrice * 1.005).sort((a, b) => a.strike_price - b.strike_price)[0]
    : atExpiry.filter(contract => contract.strike_price <= refPrice * 0.995).sort((a, b) => b.strike_price - a.strike_price)[0];
  if (!pick) return { error: "no OTM strike listed" };
  const aggsUrl = new URL(`https://api.massive.com/v2/aggs/ticker/${encodeURIComponent(pick.ticker)}/range/1/minute/${watchDate}/${watchDate}`);
  aggsUrl.searchParams.set("adjusted", "true"); aggsUrl.searchParams.set("sort", "asc"); aggsUrl.searchParams.set("limit", "1000"); aggsUrl.searchParams.set("apiKey", key);
  const aggsResponse = await fetch(aggsUrl, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!aggsResponse.ok) return { error: `option tape ${aggsResponse.status}` };
  const aggs = await aggsResponse.json() as { results?: Array<{ t: number; h: number; c: number }> };
  const tape = (aggs.results ?? []).filter(bar => bar.c > 0);
  const entryIndex = tape.findIndex(bar => bar.t >= triggeredAtMs + 5 * 60_000);
  if (entryIndex < 0) return { error: "no post-ignition option prints" };
  const entry = tape[entryIndex].c;
  if (!(entry > 0)) return { error: "unpriceable entry" };
  const rest = tape.slice(entryIndex + 1);
  const peak = rest.length ? Math.max(...rest.map(bar => bar.h)) : entry;
  const close = rest.length ? rest[rest.length - 1].c : entry;
  return { ticker: pick.ticker, entry, peakX: Number((peak / entry).toFixed(1)), closeX: Number((close / entry).toFixed(1)) };
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
      // Ignitions also get the lottery expression priced (failure never blocks the grade).
      let lottery: LotteryGrade | { error: string } | null = null;
      if (watch.kind === "volume_ignition") {
        lottery = await lotteryExpression(String(watch.symbol), watch.direction as "bullish" | "bearish", String(watch.watch_date), Date.parse(String(watch.triggered_at)), Number(watch.trigger_price))
          .catch(error => ({ error: error instanceof Error ? error.message : String(error) }));
      }
      await admin.from("setup_watches").update({
        status: "graded", entry_price: entryPrice,
        managed_ret: Number(result.managed.toFixed(2)), ret_peak: Number(result.peak.toFixed(2)), ret_close: Number(result.close.toFixed(2)),
        verdict, detail: { ...(watch.detail as object), ...(lottery ? { lottery } : {}) },
      }).eq("id", watch.id);
      const lotteryNote = lottery && "peakX" in lottery ? ` [lottery ${lottery.ticker.replace("O:", "")}: $${lottery.entry.toFixed(2)} → peak ${lottery.peakX}x, close ${lottery.closeX}x]` : "";
      graded.push(`${watch.symbol}:${verdict}(${result.managed.toFixed(1)}%)${lotteryNote}`);
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

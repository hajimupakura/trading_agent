import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAlert } from "@/lib/alerts/server";
import { todaysEconomicEvent } from "./economic-calendar";
import type { CommandCenter, Contract } from "./types";

// Overnight Convexity — Phase 1 CAPTURE ONLY. Nothing here places orders.
// The play under study: buy next-session SPXW options near the close when the tape
// qualifies (trend day closing strong), harvest the overnight gap in the opening burst.
// Three cron-driven jobs:
//   1. ~15:45-15:56 ET: qualification scan on SPY session bars + snapshot of all
//      next-session SPXW contracts under $8 (entry-time quotes and Greeks, stored
//      before the move — never hindsight). Telegram verdict either way.
//   2. 9:25-10:15 ET: per-minute executable bid/ask recording for tracked candidates.
//   3. ~10:30 ET: outcome report — MFE/MAE and simulated exits under several harvest
//      rules, stored per contract for the filter-on vs filter-off backtest.

const MAX_ENTRY_ASK = 8;
const TRACK_DELTA_MIN = 0.05;
const TRACK_DELTA_MAX = 0.45;
const TRACK_PER_SIDE = 12;

const etParts = (now = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" }).formatToParts(now);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { date: `${value.year}-${value.month}-${value.day}`, minutes: Number(value.hour) * 60 + Number(value.minute), weekday: String(value.weekday) };
};

async function ownerId(): Promise<string | null> {
  const { data } = await createAdminClient().from("profiles").select("id").limit(1).maybeSingle();
  return data?.id ?? null;
}

async function alertExists(eventKey: string): Promise<boolean> {
  const { data } = await createAdminClient().from("alerts").select("id").eq("event_key", eventKey).limit(1).maybeSingle();
  return Boolean(data);
}

// ------------------------------------------------ SPY session bars (qualification)

interface MinuteBar { minutes: number; open: number; high: number; low: number; close: number; volume: number; vwap: number | null }

async function getSpySessionBars(): Promise<MinuteBar[]> {
  const key = process.env.ALPACA_API_KEY_ID; const secret = process.env.ALPACA_API_SECRET_KEY;
  if (!key || !secret) throw new Error("Alpaca keys are not configured");
  const url = new URL("https://data.alpaca.markets/v2/stocks/SPY/bars");
  url.searchParams.set("timeframe", "1Min"); url.searchParams.set("feed", "iex"); url.searchParams.set("limit", "1000");
  url.searchParams.set("start", etParts().date); url.searchParams.set("adjustment", "all"); url.searchParams.set("sort", "asc");
  const response = await fetch(url, { headers: { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret }, cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Alpaca minute bars ${response.status}`);
  const payload = await response.json() as { bars?: Array<{ t: string; o: number; h: number; l: number; c: number; v: number; vw?: number }> };
  return (payload.bars ?? [])
    .map(bar => ({ minutes: etParts(new Date(bar.t)).minutes, open: bar.o, high: bar.h, low: bar.l, close: bar.c, volume: bar.v, vwap: bar.vw ?? null }))
    .filter(bar => bar.minutes >= 570 && bar.minutes < 960);
}

async function getPriorDayLevels(): Promise<{ high: number; low: number; close: number } | null> {
  const key = process.env.ALPACA_API_KEY_ID; const secret = process.env.ALPACA_API_SECRET_KEY;
  if (!key || !secret) return null;
  const url = new URL("https://data.alpaca.markets/v2/stocks/SPY/bars");
  url.searchParams.set("timeframe", "1Day"); url.searchParams.set("feed", "iex"); url.searchParams.set("limit", "10");
  url.searchParams.set("adjustment", "all"); url.searchParams.set("sort", "asc");
  const response = await fetch(url, { headers: { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret }, cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) return null;
  const payload = await response.json() as { bars?: Array<{ t: string; h: number; l: number; c: number }> };
  const today = etParts().date;
  const prior = (payload.bars ?? []).map(bar => ({ date: new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(bar.t)), high: bar.h, low: bar.l, close: bar.c })).filter(bar => bar.date < today).at(-1);
  return prior ? { high: prior.high, low: prior.low, close: prior.close } : null;
}

// ------------------------------------------------ qualification

export interface Qualification {
  direction: "bullish" | "bearish" | null;
  checks: Record<string, boolean | null>;
  detail: Record<string, number | string | null>;
}

function emaSeries(values: number[], period: number): number[] {
  const k = 2 / (period + 1); const out: number[] = [];
  values.forEach((value, index) => out.push(index === 0 ? value : value * k + out[index - 1] * (1 - k)));
  return out;
}

// Deterministic version of the pre-close checklist, on SPY session bars as the index
// proxy. Core checks decide qualification; breakout-hold and rejection are advisory
// (reported, stored, and left for the backtest to weigh). No futures/breadth feeds
// exist in this stack, so those checklist items are intentionally absent, not faked.
export type { MinuteBar };
export function assessQualification(bars: MinuteBar[], prior: { high: number; low: number; close: number } | null): Qualification {
  if (bars.length < 90) return { direction: null, checks: {}, detail: { reason: "insufficient session bars" } };
  const last = bars.at(-1)!;
  const sessionHigh = Math.max(...bars.map(bar => bar.high));
  const sessionLow = Math.min(...bars.map(bar => bar.low));
  const range = Math.max(sessionHigh - sessionLow, 0.01);
  const positionInRange = (last.close - sessionLow) / range;

  let cumPV = 0; let cumV = 0;
  for (const bar of bars) { const price = bar.vwap ?? (bar.high + bar.low + bar.close) / 3; cumPV += price * bar.volume; cumV += bar.volume; }
  const vwap = cumV > 0 ? cumPV / cumV : last.close;

  const closes = bars.map(bar => bar.close);
  const ema8 = emaSeries(closes, 8); const ema21 = emaSeries(closes, 21);
  const lookback = Math.min(10, bars.length - 1);
  const emaBullish = ema8.at(-1)! > ema21.at(-1)! && ema8.at(-1)! > ema8.at(-1 - lookback)! && ema21.at(-1)! > ema21.at(-1 - lookback)!;
  const emaBearish = ema8.at(-1)! < ema21.at(-1)! && ema8.at(-1)! < ema8.at(-1 - lookback)! && ema21.at(-1)! < ema21.at(-1 - lookback)!;

  // Final-hour structure: quarter the last 60 bars; count rising (falling) highs+lows.
  const finalHour = bars.slice(-60);
  const quarters = [0, 1, 2, 3].map(index => finalHour.slice(index * 15, (index + 1) * 15)).filter(slice => slice.length);
  const quarterHighs = quarters.map(slice => Math.max(...slice.map(bar => bar.high)));
  const quarterLows = quarters.map(slice => Math.min(...slice.map(bar => bar.low)));
  const risingSteps = quarterHighs.slice(1).filter((high, index) => high >= quarterHighs[index] && quarterLows[index + 1] >= quarterLows[index]).length;
  const fallingSteps = quarterHighs.slice(1).filter((high, index) => high <= quarterHighs[index] && quarterLows[index + 1] <= quarterLows[index]).length;

  // Rejection candle check on the last 15 minutes (advisory).
  const last15 = bars.slice(-15);
  const last15High = Math.max(...last15.map(bar => bar.high));
  const last15Low = Math.min(...last15.map(bar => bar.low));
  const last15Range = Math.max(last15High - last15Low, 0.01);
  const noUpsideRejection = (last15High - last.close) <= 0.4 * last15Range;
  const noDownsideRejection = (last.close - last15Low) <= 0.4 * last15Range;

  const bullCore = { closeNearHigh: positionInRange >= 0.75, aboveVwap: last.close > vwap, emaTrend: emaBullish, finalHourStructure: risingSteps >= 2 };
  const bearCore = { closeNearLow: positionInRange <= 0.25, belowVwap: last.close < vwap, emaTrend: emaBearish, finalHourStructure: fallingSteps >= 2 };
  const bullish = Object.values(bullCore).every(Boolean);
  const bearish = Object.values(bearCore).every(Boolean);
  const direction = bullish ? "bullish" as const : bearish ? "bearish" as const : null;

  return {
    direction,
    checks: {
      ...(direction === "bearish" ? bearCore : bullCore),
      breakoutHold: prior ? (direction === "bearish" ? last.close < prior.low : last.close > prior.high) : null,
      noRejection: direction === "bearish" ? noDownsideRejection : noUpsideRejection,
    },
    detail: {
      positionInRange: Number(positionInRange.toFixed(3)), vwap: Number(vwap.toFixed(2)), close: last.close,
      sessionHigh, sessionLow, priorHigh: prior?.high ?? null, priorLow: prior?.low ?? null,
      risingSteps, fallingSteps,
    },
  };
}

// ------------------------------------------------ job 1: pre-close scan + snapshot

async function readSpxSnapshot(): Promise<CommandCenter | null> {
  const { data } = await createAdminClient().from("options_monitor_snapshots").select("payload,updated_at").eq("underlying", "SPX").maybeSingle();
  const payload = data?.payload as CommandCenter | undefined;
  if (!payload || Date.now() - payload.asOf > 10 * 60_000) return null;
  return payload;
}

async function runPreCloseScan(today: string): Promise<boolean> {
  const admin = createAdminClient();
  const userId = await ownerId();
  if (!userId) return false;
  const eventKey = `radar-convexity-scan-${today}`;
  if (await alertExists(eventKey)) return false;

  const [bars, prior, snapshot] = await Promise.all([getSpySessionBars(), getPriorDayLevels(), readSpxSnapshot()]);
  if (!snapshot) throw new Error("SPX snapshot unavailable or stale — cannot capture candidates");
  const qualification = assessQualification(bars, prior);

  // Next-session SPXW book under the ask cap (dte>0; the nearest forward expiry).
  const forward = snapshot.contracts.filter(contract => contract.dte > 0 && contract.dte <= 4 && contract.ask > 0 && contract.ask <= MAX_ENTRY_ASK && contract.bid > 0);
  if (!forward.length) throw new Error("No next-session SPXW contracts under the ask cap in the snapshot");
  const nextDte = Math.min(...forward.map(contract => contract.dte));
  const candidates = forward.filter(contract => contract.dte === nextDte);
  const expiryDate = candidates[0].expirationDate;

  // Track the harvest-study set: nearest-to-0.25 |delta| per side within the band.
  // The SPX snapshot carries no greeks for SPXW, so when delta is absent fall back to
  // premium proximity (~$3.5 mid ≈ the 0.25Δ zone on next-day SPXW) — without this the
  // tracker selects nothing and the morning burst recorder has nothing to record.
  const trackSet = new Set<string>();
  for (const side of ["call", "put"] as const) {
    const withDelta = candidates
      .filter(contract => contract.side === side && contract.delta != null && Math.abs(contract.delta) >= TRACK_DELTA_MIN && Math.abs(contract.delta) <= TRACK_DELTA_MAX)
      .sort((a, b) => Math.abs(Math.abs(a.delta!) - 0.25) - Math.abs(Math.abs(b.delta!) - 0.25));
    const pool = withDelta.length ? withDelta : candidates
      .filter(contract => contract.side === side && contract.midpoint >= 1 && contract.midpoint <= MAX_ENTRY)
      .sort((a, b) => Math.abs(a.midpoint - 3.5) - Math.abs(b.midpoint - 3.5));
    pool.slice(0, TRACK_PER_SIDE).forEach(contract => trackSet.add(contract.ticker));
  }

  const rows = candidates.map(contract => ({
    session_date: today, expiry_date: expiryDate, ticker: contract.ticker, side: contract.side, strike: contract.strike,
    bid: contract.bid, ask: contract.ask, midpoint: contract.midpoint, spread_pct: contract.spreadPct,
    delta: contract.delta, gamma: contract.gamma, theta: contract.theta, iv: contract.impliedVolatility,
    volume: contract.volume, open_interest: contract.openInterest, underlying_price: contract.underlyingPrice ?? snapshot.spotPrice,
    qualified: qualification.direction != null, direction: qualification.direction, qualification: qualification as unknown as Record<string, unknown>,
    tracked: trackSet.has(contract.ticker),
  }));
  const { error } = await admin.from("convexity_candidates").upsert(rows, { onConflict: "session_date,ticker", ignoreDuplicates: true });
  if (error) throw new Error(`Candidate persistence failed: ${error.message}`);

  const tomorrowEcon = todaysEconomicEvent(new Date(Date.now() + 86_400_000));
  const describe = (contract: Contract) => `${contract.strike}${contract.side === "call" ? "C" : "P"} ask $${contract.ask.toFixed(2)} Δ${contract.delta?.toFixed(2) ?? "—"} spread ${contract.spreadPct.toFixed(1)}%`;
  const wantSide = qualification.direction === "bearish" ? "put" : "call";
  const top = candidates
    .filter(contract => trackSet.has(contract.ticker) && contract.side === wantSide && contract.delta != null && Math.abs(contract.delta) >= 0.15 && Math.abs(contract.delta) <= 0.35)
    .sort((a, b) => Math.abs(Math.abs(a.delta!) - 0.25) - Math.abs(Math.abs(b.delta!) - 0.25))
    .slice(0, 4);
  const checksLine = Object.entries(qualification.checks).map(([name, passed]) => `${name}: ${passed == null ? "n/a" : passed ? "✓" : "✗"}`).join(" · ");

  await createAlert({
    userId, eventKey,
    severity: qualification.direction ? "critical" : "info",
    title: qualification.direction
      ? `Overnight Convexity: QUALIFIED ${qualification.direction.toUpperCase()} — swing window 15:45-16:00`
      : "Overnight Convexity: not qualified — stand down tonight",
    body: qualification.direction
      ? `Pre-close checks — ${checksLine}. Study candidates (0.15-0.35Δ ${wantSide}s, exp ${expiryDate}): ${top.map(describe).join(" · ") || "none in band"}. ${tomorrowEcon ? `⚠️ Tomorrow: ${tomorrowEcon.name} at ${tomorrowEcon.releaseLabel} — size down or skip.` : "No CPI/FOMC/NFP tomorrow."} Research phase: manual entries only, one contract, risk ≤0.5% — treat as 100% losable. Captured ${rows.length} contracts for the study.`
      : `Pre-close checks — ${checksLine}. The tape did not qualify; buying tonight is the negative-expectancy version of this trade. Captured ${rows.length} contracts (${expiryDate}) for the filter-off study anyway.`,
    metadata: { kind: "convexity_scan", qualification, expiryDate, captured: rows.length, tracked: trackSet.size },
  });
  return true;
}

// ------------------------------------------------ job 2: opening burst recorder

async function runBurstRecorder(today: string): Promise<number> {
  const admin = createAdminClient();
  const { data: tracked } = await admin.from("convexity_candidates").select("ticker").eq("expiry_date", today).eq("tracked", true);
  if (!tracked?.length) return 0;
  const snapshot = await readSpxSnapshot();
  if (!snapshot) return 0;
  const wanted = new Set(tracked.map(row => String(row.ticker)));
  const rows = snapshot.contracts
    .filter(contract => wanted.has(contract.ticker))
    .map(contract => ({ session_date: today, ticker: contract.ticker, bid: contract.bid, ask: contract.ask, underlying: contract.underlyingPrice ?? snapshot.spotPrice }));
  if (!rows.length) return 0;
  const { error } = await admin.from("convexity_burst_quotes").insert(rows);
  if (error) throw new Error(`Burst persistence failed: ${error.message}`);
  return rows.length;
}

// ------------------------------------------------ job 3: morning outcome report

export interface HarvestMetrics {
  entryAsk: number; mfeMult: number; maeMult: number; peakBid: number; peakAtMinutes: number | null;
  finalBid: number; quotes: number;
  holdTo1015Pct: number; ladderPct: number; trailPct: number;
}

// Simulated harvest rules against executable bids: hold-to-10:15, thirds ladder at
// 1.75x/2.5x/3.5x (remainder at final), and a 22% bid trail armed at 1.75x.
export function computeHarvest(entryAsk: number, quotes: Array<{ minutes: number; bid: number }>): HarvestMetrics | null {
  const bids = quotes.filter(quote => quote.bid > 0);
  if (!bids.length || entryAsk <= 0) return null;
  const peak = bids.reduce((best, quote) => quote.bid > best.bid ? quote : best, bids[0]);
  const low = Math.min(...bids.map(quote => quote.bid));
  const finalBid = bids.at(-1)!.bid;
  const pnl = (exit: number) => ((exit - entryAsk) / entryAsk) * 100;

  const ladderLevels = [1.75, 2.5, 3.5];
  let remaining = 1; let ladderProceeds = 0;
  for (const quote of bids) {
    while (remaining > 1e-6 && ladderLevels.length && quote.bid >= entryAsk * ladderLevels[0]) {
      ladderProceeds += (1 / 3) * entryAsk * ladderLevels.shift()!;
      remaining -= 1 / 3;
    }
  }
  ladderProceeds += Math.max(remaining, 0) * finalBid;
  const ladderPct = ((ladderProceeds - entryAsk) / entryAsk) * 100;

  let armed = false; let trailPeak = 0; let trailExit: number | null = null;
  for (const quote of bids) {
    if (!armed && quote.bid >= entryAsk * 1.75) armed = true;
    if (armed) {
      trailPeak = Math.max(trailPeak, quote.bid);
      if (quote.bid <= trailPeak * 0.78) { trailExit = quote.bid; break; }
    }
  }
  const trailPct = pnl(trailExit ?? finalBid);

  return {
    entryAsk, mfeMult: Number((peak.bid / entryAsk).toFixed(3)), maeMult: Number((low / entryAsk).toFixed(3)),
    peakBid: peak.bid, peakAtMinutes: peak.minutes, finalBid, quotes: bids.length,
    holdTo1015Pct: Number(pnl(finalBid).toFixed(1)), ladderPct: Number(ladderPct.toFixed(1)), trailPct: Number(trailPct.toFixed(1)),
  };
}

async function runOutcomeReport(today: string): Promise<boolean> {
  const admin = createAdminClient();
  const userId = await ownerId();
  if (!userId) return false;
  const eventKey = `radar-convexity-report-${today}`;
  if (await alertExists(eventKey)) return false;

  const { data: candidates } = await admin.from("convexity_candidates")
    .select("session_date,ticker,side,strike,ask,delta,qualified,direction")
    .eq("expiry_date", today).eq("tracked", true);
  if (!candidates?.length) return false;
  const { data: quotes } = await admin.from("convexity_burst_quotes")
    .select("ticker,at,bid").eq("session_date", today).order("at", { ascending: true }).limit(5000);
  if (!quotes?.length) return false;

  const byTicker = new Map<string, Array<{ minutes: number; bid: number }>>();
  for (const quote of quotes) {
    const list = byTicker.get(String(quote.ticker)) ?? [];
    list.push({ minutes: etParts(new Date(String(quote.at))).minutes, bid: Number(quote.bid) });
    byTicker.set(String(quote.ticker), list);
  }

  const results: Array<{ ticker: string; side: string; strike: number; delta: number | null; metrics: HarvestMetrics }> = [];
  for (const candidate of candidates) {
    const series = byTicker.get(String(candidate.ticker));
    const metrics = series ? computeHarvest(Number(candidate.ask), series) : null;
    if (!metrics) continue;
    results.push({ ticker: String(candidate.ticker), side: String(candidate.side), strike: Number(candidate.strike), delta: candidate.delta == null ? null : Number(candidate.delta), metrics });
    await admin.from("convexity_outcomes").upsert({
      session_date: candidate.session_date, ticker: candidate.ticker, entry_ask: candidate.ask,
      qualified: candidate.qualified, direction: candidate.direction, metrics: metrics as unknown as Record<string, unknown>,
    }, { onConflict: "session_date,ticker", ignoreDuplicates: true });
  }
  if (!results.length) return false;

  const qualified = Boolean(candidates[0].qualified);
  const direction = candidates[0].direction ? String(candidates[0].direction) : null;
  const wantSide = direction === "bearish" ? "put" : "call";
  const band = results.filter(result => result.side === wantSide && result.delta != null && Math.abs(result.delta) >= 0.15 && Math.abs(result.delta) <= 0.35);
  const scored = band.length ? band : results;
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const fmtTime = (minutes: number | null) => minutes == null ? "—" : `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
  const best = [...scored].sort((a, b) => b.metrics.mfeMult - a.metrics.mfeMult).slice(0, 3);

  await createAlert({
    userId, eventKey, severity: "info",
    title: `Overnight Convexity report — ${qualified ? `QUALIFIED ${direction}` : "unqualified"} night`,
    body: [
      `Study band (0.15-0.35Δ ${wantSide}s, ${scored.length} contracts), entry at yesterday's 15:50 ask, exits on executable bids 9:25-10:15:`,
      `Avg hold-to-10:15 ${mean(scored.map(result => result.metrics.holdTo1015Pct)).toFixed(0)}% · avg ladder ${mean(scored.map(result => result.metrics.ladderPct)).toFixed(0)}% · avg 22% trail ${mean(scored.map(result => result.metrics.trailPct)).toFixed(0)}%.`,
      `Best movers: ${best.map(result => `${result.strike}${result.side === "call" ? "C" : "P"} peaked ${result.metrics.mfeMult.toFixed(2)}x at ${fmtTime(result.metrics.peakAtMinutes)} (ladder ${result.metrics.ladderPct.toFixed(0)}%, trail ${result.metrics.trailPct.toFixed(0)}%)`).join(" · ")}.`,
      qualified ? "This night QUALIFIED before the close — it counts toward filter-on expectancy." : "This night did NOT qualify — it counts toward the filter-off baseline (the trades we deliberately skip).",
    ].join(" "),
    metadata: { kind: "convexity_report", qualified, direction, contracts: results.length },
  });
  return true;
}

// ------------------------------------------------ cron entry point

export async function runConvexityCapture(): Promise<{ ran: string[]; errors: string[] }> {
  const clock = etParts();
  const ran: string[] = []; const errors: string[] = [];
  if (["Sat", "Sun"].includes(clock.weekday)) return { ran, errors };
  const guard = async (label: string, run: () => Promise<boolean | number>) => {
    try { const result = await run(); if (result) ran.push(label); }
    catch (error) { errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
  };
  // Pre-close scan window 15:45-15:56 (snapshot as late as possible while leaving the
  // swing window usable); burst 9:25-10:15; report from 10:25.
  if (clock.minutes >= 945 && clock.minutes <= 956) await guard("scan", () => runPreCloseScan(clock.date));
  if (clock.minutes >= 565 && clock.minutes <= 615) await guard("burst", () => runBurstRecorder(clock.date));
  if (clock.minutes >= 625 && clock.minutes <= 640) await guard("report", () => runOutcomeReport(clock.date));
  return { ran, errors };
}

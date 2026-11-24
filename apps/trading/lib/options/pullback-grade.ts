import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { STOCK_FEED } from "@/lib/alpaca/data-plan";

// PULLBACK GRADER (user call 2026-11-23: "they drop and pick up strong — there is
// something underneath"). The mechanics underneath are institutional accumulation
// (big orders worked over hours, buying the dips), the midday liquidity lull, and
// dealer hedging flows into the afternoon. The classic tell separating a HEALTHY
// pullback (second leg coming) from a real reversal: the dip holds the thesis side
// of session VWAP on FADING volume. This module measures that tell instead of
// assuming it: once per day after the close, every shadow-ledger fire gets its first
// meaningful post-fire pullback graded on the UNDERLYING's real tape —
//   heldVwap     at the pullback trough, price still on the thesis side of VWAP
//   volumeFading pullback volume below the preceding leg's volume
//   secondLeg    price later beat the pre-pullback extreme before the close
// Weeks of rows answer "does heldVwap+volumeFading predict the second leg" — and if
// yes, healthy-pullback names earn re-fire priority. MEASUREMENT ONLY: nothing here
// trades, holds, or gates. Ships with its own heartbeat job per the silent-failure
// doctrine.

type MinuteBar = { min: number; c: number; v: number; vw: number };

function etParts(now: Date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" }).formatToParts(now).map(part => [part.type, part.value]));
  return { minutes: Number(parts.hour) * 60 + Number(parts.minute), weekday: String(parts.weekday) };
}

async function dayBars(symbol: string): Promise<MinuteBar[]> {
  const headers = { "APCA-API-KEY-ID": process.env.ALPACA_API_KEY_ID ?? "", "APCA-API-SECRET-KEY": process.env.ALPACA_API_SECRET_KEY ?? "" };
  const start = new Date(Date.now() - 9 * 3_600_000).toISOString(); // generous intraday window; filtered to RTH minutes below
  const url = new URL(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/bars`);
  url.searchParams.set("timeframe", "1Min"); url.searchParams.set("feed", STOCK_FEED);
  url.searchParams.set("start", start); url.searchParams.set("limit", "10000"); url.searchParams.set("sort", "asc");
  const response = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`pullback bars ${response.status} for ${symbol}`);
  const payload = await response.json() as { bars?: Array<{ t: string; c: number; v: number; vw?: number }> };
  return (payload.bars ?? []).map(bar => {
    const parts = etParts(new Date(bar.t));
    return { min: parts.minutes, c: Number(bar.c), v: Number(bar.v) || 0, vw: Number(bar.vw ?? bar.c) };
  }).filter(bar => bar.min >= 570 && bar.min <= 960 && Number.isFinite(bar.c));
}

export function gradePullback(bars: MinuteBar[], fireMin: number, dir: 1 | -1): Record<string, unknown> {
  // Session VWAP per minute (cumulative from the open — that is what institutions track).
  let cumPV = 0, cumV = 0; const vwapAt = new Map<number, number>();
  for (const bar of bars) { cumPV += bar.vw * bar.v; cumV += bar.v; vwapAt.set(bar.min, cumV ? cumPV / cumV : bar.c); }
  const after = bars.filter(bar => bar.min >= fireMin);
  if (after.length < 10) return { pullback: false, reason: "fired too close to the bell" };
  const entry = after[0].c;
  // First leg: running extreme in the thesis direction.
  let extreme = entry, extremeMin = fireMin, extremeIdx = 0;
  let troughIdx: number | null = null; let trough = extreme;
  for (let i = 1; i < after.length; i++) {
    const price = after[i].c;
    if (dir * (price - extreme) > 0) {
      if (troughIdx != null) break; // extreme reclaimed after a pullback was found — leg complete
      extreme = price; extremeMin = after[i].min; extremeIdx = i; continue;
    }
    const leg = Math.abs(extreme - entry);
    const retrace = Math.abs(extreme - price);
    // A pullback counts when the leg moved >=0.3% of price and >=40% of it retraced.
    if (leg / entry >= 0.003 && retrace >= 0.4 * leg) {
      if (troughIdx == null || dir * (price - trough) < 0) { troughIdx = i; trough = price; }
    } else if (troughIdx != null && dir * (price - trough) < 0) { troughIdx = i; trough = price; }
  }
  if (troughIdx == null) return { pullback: false, legPct: Number((100 * dir * (extreme - entry) / entry).toFixed(2)) };
  const troughMin = after[troughIdx].min;
  const vwapAtTrough = vwapAt.get(troughMin) ?? trough;
  const legBars = after.slice(0, extremeIdx + 1);
  const pullBars = after.slice(extremeIdx + 1, troughIdx + 1);
  const avg = (rows: MinuteBar[]) => rows.length ? rows.reduce((sum, bar) => sum + bar.v, 0) / rows.length : 0;
  const secondLeg = after.slice(troughIdx + 1).some(bar => dir * (bar.c - extreme) > 0);
  return {
    pullback: true,
    legPct: Number((100 * dir * (extreme - entry) / entry).toFixed(2)),
    retracePct: Number((100 * Math.abs(extreme - trough) / Math.max(Math.abs(extreme - entry), 1e-9)).toFixed(0)),
    heldVwap: dir * (trough - vwapAtTrough) > 0,
    volumeFading: avg(pullBars) < avg(legBars),
    secondLeg,
    peakMin: extremeMin, troughMin,
  };
}

// LIVE health check (user call 2026-11-23: "spend the last slots using VWAP"): at
// fire time, find today's strongest 30-min leg so far in the thesis direction (the
// year-scan's event definition) and grade its pullback. Score: 2 = dip held VWAP on
// fading volume (85.6% second-leg rate over 1yr; 97% pre-11am), 1 = held VWAP,
// 0 = no meaningful leg/pullback yet (fresh surge — unproven, not penalized),
// -1 = dip broke VWAP (the weak cohort). Best-effort: callers treat errors as 0.
export async function pullbackHealthNow(symbol: string, dir: 1 | -1): Promise<number> {
  const proxy = ["SPX", "SPXW"].includes(symbol.toUpperCase()) ? "SPY" : symbol.toUpperCase();
  const bars = await dayBars(proxy);
  if (bars.length < 45) return 0;
  let best = { move: 0, index: 0 };
  for (let i = 0; i + 30 < bars.length; i++) {
    const move = dir * (bars[i + 30].c - bars[i].c) / bars[i].c;
    if (move > best.move) best = { move, index: i };
  }
  if (best.move < 0.003) return 0;
  const grade = gradePullback(bars, bars[best.index].min, dir) as { pullback?: boolean; heldVwap?: boolean; volumeFading?: boolean };
  if (grade.pullback !== true) return 0;
  if (grade.heldVwap && grade.volumeFading) return 2;
  if (grade.heldVwap) return 1;
  return -1;
}

export async function runPullbackGrades(): Promise<{ graded: number; errors: string[] }> {
  const { minutes, weekday } = etParts(new Date());
  // One shot after the close: 16:05-16:25 ET weekdays; idempotent via the null filter.
  if (["Sat", "Sun"].includes(weekday) || minutes < 965 || minutes > 985) return { graded: 0, errors: [] };
  const admin = createAdminClient();
  const { data: rows, error } = await admin.from("signal_shadow_ledger")
    .select("id,underlying,contract_ticker,created_at")
    .is("pullback_grade", null)
    .gte("created_at", new Date(Date.now() - 12 * 3_600_000).toISOString())
    .limit(40);
  if (error) return { graded: 0, errors: [`ledger read: ${error.message}`] };
  if (!rows?.length) return { graded: 0, errors: [] };
  const errors: string[] = []; let graded = 0;
  const barsBySymbol = new Map<string, MinuteBar[]>();
  for (const row of rows) {
    try {
      // Index fires grade against SPY as the tradable proxy for SPX structure.
      const symbol = ["SPX", "SPXW"].includes(String(row.underlying)) ? "SPY" : String(row.underlying);
      if (!barsBySymbol.has(symbol)) barsBySymbol.set(symbol, await dayBars(symbol));
      const bars = barsBySymbol.get(symbol)!;
      const dir: 1 | -1 = /P\d{8}$/.test(String(row.contract_ticker)) ? -1 : 1;
      const fireMin = etParts(new Date(String(row.created_at))).minutes;
      const grade = gradePullback(bars, fireMin, dir);
      const { error: updateError } = await admin.from("signal_shadow_ledger").update({ pullback_grade: grade }).eq("id", row.id);
      if (updateError) throw new Error(updateError.message);
      graded++;
    } catch (rowError) {
      errors.push(`${row.underlying}: ${rowError instanceof Error ? rowError.message : String(rowError)}`);
    }
  }
  return { graded, errors };
}

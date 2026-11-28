import "server-only";
import { generateSignal } from "@/lib/options/signal";
import { marketStateAt } from "@/lib/options/market-state";
import type { Bar, Underlying } from "@/lib/options/types";
import { etDay, loadSessions, minuteOf, occFor, stepsFor, synthetic, type Row } from "./causal-corpus";

// CAUSAL SWARM CORPUS (2026-11-27, user call: "rebuild the swarm study and test selling
// half at 5x"). The 22-month swarm study that calibrated the convexity sleeve (no stop,
// no target, sell at day+2 close) entered every position at the start of the day's best
// 30-minute move — chosen with hindsight — and a re-run of its own data did not
// reproduce its headline numbers. This rebuilds it with the LIVE sleeve's entry:
//   - the live engine's signal, replayed one minute at a time on stored bars (at minute
//     t it sees bars[0..t] only), with no opening hold and no entry window — the
//     convexity lane has neither;
//   - the sleeve's own gate: the 30-minute leg (close[t] vs close[t-30]) is at least
//     1.5% IN the signal's direction; the first qualifying minute per name per side
//     per day is the fire, entered the minute after the firing bar closes;
//   - the sleeve's own contract: nearest Friday at least 3 calendar days out (Thursday
//     when that Friday has no listing), strike nearest 8% out of the money, and the 4%
//     rung as a second row (the sleeve's fallback when the 8% book is barely there);
//   - the real option tape from the fire through expiry, so any exit rule can be
//     replayed afterwards.
// Prints are trades, not quotes: the study measures before the cost of the spread.

export type SwarmPosition = {
  day: string; sym: string; dir: number; lvl: number; occ: string; fireMin: number; entryPrint: number;
  setup: string; spot: number; leg: number; expiry: string; path: Array<[number, number]>;
};
type SwarmFire = { day: string; sym: string; dir: number; fireMin: number; spot: number; setup: string; leg: number };

const DATA_BASE = "https://data.alpaca.markets";
const MIN_LEG = 0.015;
const DEPTHS = [8, 4] as const; // lvl = depth in % out of the money

function replaySwarmFires(symbol: string, sessions: Map<string, Row[]>, monthPrefix: string, deadline: number, dayFrom: string, dayTo: string): SwarmFire[] {
  const contracts = [synthetic("call", symbol), synthetic("put", symbol)];
  const fires: SwarmFire[] = [];
  let prior: { high: number; low: number; close: number } | null = null;
  for (const day of [...sessions.keys()].sort()) {
    const rows = sessions.get(day)!;
    const levels: { high: number; low: number; close: number } | null = rows.length ? { high: Math.max(...rows.map(r => r.h)), low: Math.min(...rows.map(r => r.l)), close: rows.at(-1)!.c } : prior;
    if (Date.now() > deadline) throw new Error("ml-swarm: time budget exhausted in replay — split the window");
    if (day.startsWith(monthPrefix) && day >= dayFrom && day <= dayTo && rows.length >= 120) {
      const bars: Bar[] = rows.map(r => ({ timestamp: r.ts, open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v, vwap: r.vw }));
      const taken = new Set<number>();
      for (let t = 30; t < bars.length && taken.size < 2; t++) {
        const minute = rows[t]!.min;
        if (minute > 955) break;
        // The leg test is cheap; only minutes that pass it pay for an engine replay.
        const move = bars[t]!.close / bars[t - 30]!.close - 1;
        const legDir = move >= MIN_LEG ? 1 : move <= -MIN_LEG ? -1 : 0;
        if (legDir === 0 || taken.has(legDir)) continue;
        const state = marketStateAt(symbol as Underlying, bars.slice(0, t + 1));
        state.chartSymbol = symbol as Underlying; state.priorDay = prior; state.bars = state.bars.slice(-120);
        const signal = generateSignal(state, contracts, { deltaTarget: 0.45, minDte: 0, trendDayEnabled: true });
        const dir = signal.action === "enter_call" ? 1 : signal.action === "enter_put" ? -1 : 0;
        if (dir !== legDir) continue;
        taken.add(dir);
        fires.push({ day, sym: symbol, dir, fireMin: minute + 1, spot: bars[t]!.close, setup: String(signal.setup), leg: Number((Math.abs(move) * 100).toFixed(2)) });
      }
    }
    prior = levels;
  }
  return fires;
}

const addDays = (day: string, count: number) => new Date(Date.parse(`${day}T12:00:00Z`) + count * 86_400_000).toISOString().slice(0, 10);
// Nearest Friday at least 3 calendar days out — the live sleeve's pickExpiry.
function swarmFriday(day: string): string {
  for (let ahead = 3; ahead <= 10; ahead++) {
    const candidate = addDays(day, ahead);
    if (new Date(`${candidate}T12:00:00Z`).getUTCDay() === 5) return candidate;
  }
  throw new Error("no Friday within 10 days");
}

async function fetchSwarmDay(day: string, fires: SwarmFire[], deadline: number): Promise<SwarmPosition[]> {
  const friday = swarmFriday(day);
  const expiries = [friday, addDays(friday, -1)]; // Thursday covers a Friday market holiday
  const candidates = fires.flatMap(fire => expiries.flatMap(expiry => DEPTHS.flatMap(depth => {
    const target = fire.spot * (1 + fire.dir * depth / 100);
    const strikes = stepsFor(fire.spot).flatMap(step => {
      const near = Math.round(target / step) * step;
      return [near - step, near, near + step];
    }).filter(strike => strike > 0 && (fire.dir > 0 ? strike > fire.spot : strike < fire.spot));
    return [...new Set(strikes.map(strike => Number(strike.toFixed(2))))].map(strike => ({ fire, expiry, depth, strike, occ: occFor(fire.sym, fire.dir, strike, expiry) }));
  })));
  const occs = [...new Set(candidates.map(c => c.occ))];
  const headers = { "APCA-API-KEY-ID": process.env.ALPACA_API_KEY_ID ?? "", "APCA-API-SECRET-KEY": process.env.ALPACA_API_SECRET_KEY ?? "" };
  const baseUtc = Date.parse(`${day}T00:00:00Z`);
  const paths = new Map<string, Array<[number, number]>>();
  for (let chunkStart = 0; chunkStart < occs.length; chunkStart += 40) {
    let pageToken: string | undefined; let pages = 0;
    do {
      if (Date.now() > deadline) throw new Error("ml-swarm: time budget exhausted — split the window");
      const url = new URL(`${DATA_BASE}/v1beta1/options/bars`);
      url.searchParams.set("symbols", occs.slice(chunkStart, chunkStart + 40).join(","));
      url.searchParams.set("timeframe", "1Min"); url.searchParams.set("limit", "10000"); url.searchParams.set("sort", "asc");
      url.searchParams.set("start", `${day}T13:30:00Z`); url.searchParams.set("end", `${friday}T21:15:00Z`);
      if (pageToken) url.searchParams.set("page_token", pageToken);
      const response = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`ml-swarm: Alpaca ${response.status} on ${day} ${(await response.text()).slice(0, 120)}`);
      const payload = await response.json() as { bars?: Record<string, Array<{ t: string; c: number }>>; next_page_token?: string | null };
      for (const [occ, bars] of Object.entries(payload.bars ?? {})) {
        const list = paths.get(occ) ?? [];
        for (const bar of bars) {
          const when = new Date(bar.t);
          const offset = Math.round((Date.parse(`${etDay.format(when)}T00:00:00Z`) - baseUtc) / 86_400_000);
          list.push([offset * 1440 + minuteOf(when), Number(Number(bar.c).toFixed(2))]); // dayOffset*1440 + ET minute
        }
        paths.set(occ, list);
      }
      pageToken = payload.next_page_token ?? undefined;
    } while (pageToken && ++pages < 10);
  }
  const out: SwarmPosition[] = [];
  for (const fire of fires) {
    for (const depth of DEPTHS) {
      // The listed expiry: Friday unless only Thursday traded (holiday week).
      for (const expiry of expiries) {
        // Fillable = a print within 15 minutes of the fire at >= $0.02 and under the
        // sleeve's $3,000-per-contract ceiling; nearest the depth target wins.
        const target = fire.spot * (1 + fire.dir * depth / 100);
        const fillable = candidates.filter(c => c.fire === fire && c.expiry === expiry && c.depth === depth).flatMap(c => {
          const path = (paths.get(c.occ) ?? []).filter(([min]) => min >= fire.fireMin);
          const first = path[0];
          if (!first || first[0] > fire.fireMin + 15 || first[1] < 0.02 || first[1] * 100 > 3000) return [];
          return [{ occ: c.occ, path, entryPrint: first[1], distance: Math.abs(c.strike - target) }];
        }).sort((a, b) => a.distance - b.distance);
        const best = fillable[0];
        if (!best) continue;
        out.push({ day, sym: fire.sym, dir: fire.dir, lvl: depth, occ: best.occ, fireMin: fire.fireMin, entryPrint: best.entryPrint, setup: fire.setup, spot: fire.spot, leg: fire.leg, expiry, path: best.path });
        break;
      }
    }
  }
  return out;
}

export async function runSwarmCorpus(params: Record<string, unknown>, deadline: number): Promise<SwarmPosition[]> {
  const symbol = String(params.symbol ?? ""); const start = String(params.start ?? "");
  if (!symbol || !/^\d{4}-\d{2}-01T00:00:00Z$/.test(start)) throw new Error("ml-swarm: params.symbol and start (YYYY-MM-01T00:00:00Z) required");
  const month = new Date(start);
  const previous = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() - 1, 1)).toISOString().replace(".000Z", "Z");
  const sessions = await loadSessions(symbol, [previous, start]);
  const fires = replaySwarmFires(symbol, sessions, start.slice(0, 7), deadline, String(params.dayFrom ?? "0000-00-00"), String(params.dayTo ?? "9999-99-99"));
  const byDay = new Map<string, SwarmFire[]>();
  for (const fire of fires) byDay.set(fire.day, [...(byDay.get(fire.day) ?? []), fire]);
  const days = [...byDay.keys()].sort();
  const out: SwarmPosition[] = [];
  for (let index = 0; index < days.length; index += 6) {
    const batch = await Promise.all(days.slice(index, index + 6).map(day => fetchSwarmDay(day, byDay.get(day)!, deadline)));
    out.push(...batch.flat());
  }
  return out;
}

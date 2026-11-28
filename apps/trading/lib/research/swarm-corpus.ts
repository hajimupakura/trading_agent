import "server-only";
import { generateSignal } from "@/lib/options/signal";
import { marketStateAt } from "@/lib/options/market-state";
import type { Bar, Underlying } from "@/lib/options/types";
import { etDay, loadSessions, minuteOf, occFor, stepsFor, synthetic, type Row } from "./causal-corpus";

// CAUSAL SWARM CORPUS (2026-11-27, user call: "rebuild the swarm study and test selling
// half at 5x"). The 22-month swarm study that calibrated the convexity sleeve entered
// every position at the start of the day's best 30-minute move (hindsight) and held for
// two CALENDAR days. This rebuilds it with the LIVE sleeve's entry:
//   - the live engine's signal, replayed one minute at a time on stored bars (at minute
//     t it sees bars[0..t] only), no opening hold and no entry window (the convexity
//     lane has neither);
//   - the sleeve's gate: the 30-minute leg (close[t] vs close[t-30]) >= 1.5% IN the
//     signal's direction; first qualifying minute per name per side per day, entered
//     the minute after the firing bar closes;
//   - the sleeve's contract (gen swarm-v2, after Codex's review): the nearest Friday at
//     least 3 calendar days out, or that week's Thursday when the Friday is a market
//     holiday — never "whichever one traded"; strike nearest 8% out of the money, and
//     the 4% rung ONLY when the 8% book was barely there, as live does;
//   - strikes from the RAW (unadjusted) price at the fire: the stored bars are split-
//     adjusted, which built strikes that never existed before NVDA's and SMCI's splits
//     and silently dropped those months (Codex finding);
//   - admission uses only what was knowable at the fire: the contract must have printed
//     in the 30 minutes BEFORE the fire, at <= $30 (the $3,000 ceiling). The entry price
//     is the first print in the 15 minutes after the fire (an order that would not have
//     filled is dropped and counted);
//   - the real option tape from the open of the fire day through expiry.
// Known gap: live signals also need a strictly screened near-dated contract to exist;
// the replay supplies synthetic contracts. On these 14 liquid names that screen almost
// always passes, but it is not replayed. Prints are trades, not quotes.

export type SwarmPosition = {
  day: string; sym: string; dir: number; lvl: number; occ: string; fireMin: number; entryPrint: number;
  setup: string; spot: number; leg: number; expiry: string; path: Array<[number, number]>;
};
type SwarmFire = { day: string; sym: string; dir: number; fireMin: number; spot: number; setup: string; leg: number };

const DATA_BASE = "https://data.alpaca.markets";
const MIN_LEG = 0.015;
const DEPTHS = [8, 4] as const; // lvl = depth in % out of the money
// Friday market holidays in the study window: that week's weekly lists on Thursday.
const FRIDAY_HOLIDAYS = new Set(["2024-03-29", "2025-04-18", "2025-07-04", "2026-04-03", "2026-07-03", "2026-12-25"]);

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
// Nearest Friday at least 3 calendar days out, Thursday in a holiday week — the live
// sleeve's pickExpiry. Returns the listed expiry and the Friday that bounds the tape.
function swarmExpiry(day: string): { expiry: string; friday: string } {
  for (let ahead = 3; ahead <= 10; ahead++) {
    const candidate = addDays(day, ahead);
    if (new Date(`${candidate}T12:00:00Z`).getUTCDay() === 5) return { expiry: FRIDAY_HOLIDAYS.has(candidate) ? addDays(candidate, -1) : candidate, friday: candidate };
  }
  throw new Error("no Friday within 10 days");
}

// Raw (unadjusted) closes for the fire day, by ET minute: the strike grid is built from
// the price that actually traded, not the split-adjusted series the replay runs on.
async function rawCloses(symbol: string, day: string, headers: Record<string, string>, deadline: number): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  let pageToken: string | undefined; let pages = 0;
  do {
    if (Date.now() > deadline) throw new Error("ml-swarm: time budget exhausted — split the window");
    const url = new URL(`${DATA_BASE}/v2/stocks/${encodeURIComponent(symbol)}/bars`);
    url.searchParams.set("timeframe", "1Min"); url.searchParams.set("adjustment", "raw"); url.searchParams.set("limit", "10000"); url.searchParams.set("sort", "asc");
    url.searchParams.set("feed", process.env.ALPACA_DATA_PLAN === "paid" ? "sip" : "iex");
    url.searchParams.set("start", `${day}T13:30:00Z`); url.searchParams.set("end", `${day}T21:05:00Z`);
    if (pageToken) url.searchParams.set("page_token", pageToken);
    const response = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`ml-swarm: Alpaca raw bars ${response.status} for ${symbol} ${day}`);
    const payload = await response.json() as { bars?: Array<{ t: string; c: number }>; next_page_token?: string | null };
    for (const bar of payload.bars ?? []) out.set(minuteOf(new Date(bar.t)), Number(bar.c));
    pageToken = payload.next_page_token ?? undefined;
  } while (pageToken && ++pages < 3);
  return out;
}

async function fetchSwarmDay(day: string, fires: SwarmFire[], deadline: number, counters: { unfilled: string[]; noBook: string[] }): Promise<SwarmPosition[]> {
  const { expiry, friday } = swarmExpiry(day);
  const headers = { "APCA-API-KEY-ID": process.env.ALPACA_API_KEY_ID ?? "", "APCA-API-SECRET-KEY": process.env.ALPACA_API_SECRET_KEY ?? "" };
  const raw = await rawCloses(fires[0]!.sym, day, headers, deadline);
  // Spot for strikes = the raw close of the firing bar (fireMin - 1), nearest earlier minute if missing.
  const rawSpot = (fire: SwarmFire) => {
    for (let minute = fire.fireMin - 1; minute >= fire.fireMin - 10; minute--) { const close = raw.get(minute); if (close && close > 0) return close; }
    return fire.spot;
  };
  const spots = new Map(fires.map(fire => [fire, rawSpot(fire)]));
  const candidates = fires.flatMap(fire => DEPTHS.flatMap(depth => {
    const spot = spots.get(fire)!;
    const target = spot * (1 + fire.dir * depth / 100);
    const strikes = stepsFor(spot).flatMap(step => {
      const near = Math.round(target / step) * step;
      return [near - step, near, near + step];
    }).filter(strike => strike > 0 && (fire.dir > 0 ? strike > spot : strike < spot));
    return [...new Set(strikes.map(strike => Number(strike.toFixed(2))))].map(strike => ({ fire, depth, strike, target, occ: occFor(fire.sym, fire.dir, strike, expiry) }));
  }));
  const occs = [...new Set(candidates.map(c => c.occ))];
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
  // What was knowable at the fire: a print in the 30 minutes before it, at <= $30.
  const bookAt = (c: (typeof candidates)[number]) => {
    const full = paths.get(c.occ) ?? [];
    const before = full.filter(([min]) => min < c.fire.fireMin && min >= c.fire.fireMin - 30);
    const last = before.at(-1);
    return last && last[1] * 100 <= 3000 ? { occ: c.occ, lastBefore: last[1], distance: Math.abs(c.strike - c.target), full } : null;
  };
  const out: SwarmPosition[] = [];
  for (const fire of fires) {
    const pick = (depth: number) => candidates.filter(c => c.fire === fire && c.depth === depth).map(bookAt)
      .filter((book): book is NonNullable<ReturnType<typeof bookAt>> => book != null).sort((a, b) => a.distance - b.distance)[0] ?? null;
    // Live: nearest-to-8% contract; the 4% rung only when that book is barely there.
    let depth = 8; let chosen = pick(8);
    if (!chosen || chosen.lastBefore < 0.03) { depth = 4; chosen = pick(4); }
    if (!chosen) { counters.noBook.push(day); continue; }
    const path = chosen.full.filter(([min]) => min >= fire.fireMin);
    const first = path[0];
    if (!first || first[0] > fire.fireMin + 15 || first[1] < 0.02) { counters.unfilled.push(day); continue; }
    out.push({ day, sym: fire.sym, dir: fire.dir, lvl: depth, occ: chosen.occ, fireMin: fire.fireMin, entryPrint: first[1], setup: fire.setup, spot: spots.get(fire)!, leg: fire.leg, expiry, path });
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
  const counters = { unfilled: [] as string[], noBook: [] as string[] };
  for (let index = 0; index < days.length; index += 6) {
    const batch = await Promise.all(days.slice(index, index + 6).map(day => fetchSwarmDay(day, byDay.get(day)!, deadline, counters)));
    out.push(...batch.flat());
  }
  // Fires that found no contract, or whose order would not have filled, are recorded
  // as zero-path rows so the export can report how many fires the corpus lost.
  for (const day of counters.noBook) out.push({ day, sym: symbol, dir: 0, lvl: -1, occ: "NO_BOOK", fireMin: 0, entryPrint: 0, setup: "", spot: 0, leg: 0, expiry: "", path: [] });
  for (const day of counters.unfilled) out.push({ day, sym: symbol, dir: 0, lvl: -2, occ: "UNFILLED", fireMin: 0, entryPrint: 0, setup: "", spot: 0, leg: 0, expiry: "", path: [] });
  return out;
}

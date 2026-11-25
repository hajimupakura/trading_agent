import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateSignal } from "@/lib/options/signal";
import { marketStateAt } from "@/lib/options/market-state";
import type { Bar, Contract, Underlying } from "@/lib/options/types";

// CAUSAL CORPUS (2026-11-25). The first option corpus entered every historical trade at
// the START of that day's strongest 30-minute move — a minute nobody can know in
// advance — so every study built on it was optimistic. This builder replaces the event
// definition with the live engine's own: it replays generateSignal one minute at a time
// over stored minute bars (at minute t it sees bars[0..t] only), takes the first fire
// per side per day (plus the first fire at/after 9:45, the paper lane's opening hold),
// and fetches the real option tape from the minute AFTER the firing bar closed.
//
// One request = one symbol-month: params { symbol, start: "YYYY-MM-01T00:00:00Z", gen }.
// Contract = first strike out of the money at the fire's spot, on the two nearest
// expiries that actually traded (the lane buys the earliest expiry; the second one
// answers the "one more day of time" question). Mirrors research-bench/replay_engine.cts.
// NOT replayed: SPX (no native bars), earnings/economic guards, chain-quality screens.

const DATA_BASE = "https://data.alpaca.markets";
type StoredBar = { t: string; o?: number; h?: number; l?: number; c: number; v: number; vw?: number };
type Row = { min: number; ts: number; o: number; h: number; l: number; c: number; v: number; vw: number };
export type CausalPosition = { day: string; sym: string; dir: number; lvl: number; occ: string; fireMin: number; entryPrint: number; setup: string; spot: number; path: Array<[number, number]> };

const etDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" });
const etClock = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const minuteOf = (when: Date) => { const p = Object.fromEntries(etClock.formatToParts(when).map(part => [part.type, part.value])); return Number(p.hour) * 60 + Number(p.minute); };

const synthetic = (side: "call" | "put", sym: string) => ({
  ticker: `REPLAY-${side}`, underlying: sym as Underlying, expirationDate: "", dte: 0, side, strike: 0, exerciseStyle: "american",
  bid: 1, ask: 1.02, midpoint: 1.01, spreadPct: 2, quoteUpdatedAt: null, volume: 1000, openInterest: 1000, volumeToOpenInterest: 1,
  impliedVolatility: null, delta: side === "call" ? 0.45 : -0.45, gamma: null, theta: null, underlyingPrice: null,
  liquidityScore: 1, eligible: true, rejectionReasons: [],
}) as unknown as Contract;

async function loadSessions(symbol: string, starts: string[]): Promise<Map<string, Row[]>> {
  const admin = createAdminClient();
  const sessions = new Map<string, Row[]>();
  for (const start of starts) {
    const { data, error } = await admin.from("research_requests").select("result").eq("kind", "stock-bars").eq("status", "done")
      .is("params->>probe", null).eq("params->>start", start).contains("params", { symbols: [symbol] }).limit(2);
    if (error) throw new Error(`ml-causal bars read: ${error.message}`);
    for (const row of data ?? []) {
      for (const bar of ((row.result as Record<string, StoredBar[]> | null)?.[symbol] ?? [])) {
        const when = new Date(bar.t); const min = minuteOf(when);
        if (min < 570 || min >= 960) continue;
        const day = etDay.format(when);
        if (!sessions.has(day)) sessions.set(day, []);
        sessions.get(day)!.push({ min, ts: when.getTime(), o: bar.o ?? bar.c, h: bar.h ?? bar.c, l: bar.l ?? bar.c, c: bar.c, v: bar.v, vw: bar.vw ?? bar.c });
      }
    }
  }
  for (const [day, rows] of sessions) {
    rows.sort((a, b) => a.min - b.min);
    sessions.set(day, rows.filter((row, index) => index === 0 || rows[index - 1]!.min !== row.min));
  }
  return sessions;
}

type Fire = { day: string; sym: string; dir: number; fireMin: number; spot: number; setup: string };

function replayMonth(symbol: string, sessions: Map<string, Row[]>, monthPrefix: string): Fire[] {
  const contracts = [synthetic("call", symbol), synthetic("put", symbol)];
  const fires: Fire[] = [];
  let prior: { high: number; low: number; close: number } | null = null;
  for (const day of [...sessions.keys()].sort()) {
    const rows = sessions.get(day)!;
    const levels: { high: number; low: number; close: number } | null = rows.length ? { high: Math.max(...rows.map(r => r.h)), low: Math.min(...rows.map(r => r.l)), close: rows.at(-1)!.c } : prior;
    if (day.startsWith(monthPrefix) && rows.length >= 120) {
      const bars: Bar[] = rows.map(r => ({ timestamp: r.ts, open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v, vwap: r.vw }));
      const first = new Set<number>(); const firstLate = new Set<number>();
      for (let t = 0; t < bars.length; t++) {
        const minute = rows[t]!.min;
        if (minute > 885) break; // the live entry window ends 14:45
        if (first.size === 2 && firstLate.size === 2) break;
        const state = marketStateAt(symbol as Underlying, bars.slice(0, t + 1));
        state.chartSymbol = symbol as Underlying; state.priorDay = prior; state.bars = state.bars.slice(-120);
        const signal = generateSignal(state, contracts, { deltaTarget: 0.45, minDte: 0, trendDayEnabled: true });
        if (signal.action !== "enter_call" && signal.action !== "enter_put") continue;
        const dir = signal.action === "enter_call" ? 1 : -1;
        // Knowable when the firing bar CLOSES, so the earliest honest entry is the next minute.
        const fire: Fire = { day, sym: symbol, dir, fireMin: minute + 1, spot: bars[t]!.close, setup: String(signal.setup) };
        const isFirst = !first.has(dir); const isFirstLate = minute >= 585 && !firstLate.has(dir);
        if (isFirst) first.add(dir);
        if (isFirstLate) firstLate.add(dir);
        if (isFirst || isFirstLate) fires.push(fire); // identical minute for both = one row
      }
    }
    prior = levels;
  }
  return fires;
}

const incFor = (spot: number) => spot >= 500 ? 5 : spot >= 250 ? 2.5 : spot >= 100 ? 1 : 0.5;
const occFor = (sym: string, dir: number, strike: number, expiry: string) => `${sym}${expiry.slice(2).replaceAll("-", "")}${dir > 0 ? "C" : "P"}${String(Math.round(strike * 1000)).padStart(8, "0")}`;
function weekdaysFrom(day: string, count: number): string[] {
  const out: string[] = []; const base = Date.parse(`${day}T12:00:00Z`);
  for (let add = 0; out.length < count; add++) {
    const candidate = new Date(base + add * 86_400_000);
    if (candidate.getUTCDay() >= 1 && candidate.getUTCDay() <= 5) out.push(candidate.toISOString().slice(0, 10));
  }
  return out;
}

async function fetchDay(day: string, fires: Fire[], deadline: number): Promise<CausalPosition[]> {
  const expiries = weekdaysFrom(day, 6); // always spans a Friday
  const windowEnd = weekdaysFrom(day, 2)[1]!; // tape through the NEXT session's close
  const candidates = fires.flatMap(fire => expiries.flatMap(expiry => {
    const inc = incFor(fire.spot); const alt = inc * 2.5 <= 5 ? inc * 2.5 : inc * 2;
    const pick = (step: number) => fire.dir > 0 ? Math.ceil(fire.spot / step) * step : Math.floor(fire.spot / step) * step;
    return [...new Set([pick(inc), pick(alt)])].map(strike => ({ fire, expiry, occ: occFor(fire.sym, fire.dir, strike, expiry) }));
  }));
  const occs = [...new Set(candidates.map(c => c.occ))];
  const headers = { "APCA-API-KEY-ID": process.env.ALPACA_API_KEY_ID ?? "", "APCA-API-SECRET-KEY": process.env.ALPACA_API_SECRET_KEY ?? "" };
  const baseUtc = Date.parse(`${day}T00:00:00Z`);
  const paths = new Map<string, Array<[number, number]>>();
  for (let chunkStart = 0; chunkStart < occs.length; chunkStart += 40) {
    let pageToken: string | undefined; let pages = 0;
    do {
      if (Date.now() > deadline) throw new Error("ml-causal: time budget exhausted — split the month");
      const url = new URL(`${DATA_BASE}/v1beta1/options/bars`);
      url.searchParams.set("symbols", occs.slice(chunkStart, chunkStart + 40).join(","));
      url.searchParams.set("timeframe", "1Min"); url.searchParams.set("limit", "10000"); url.searchParams.set("sort", "asc");
      url.searchParams.set("start", `${day}T13:30:00Z`); url.searchParams.set("end", `${windowEnd}T21:15:00Z`);
      if (pageToken) url.searchParams.set("page_token", pageToken);
      const response = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`ml-causal: Alpaca ${response.status} on ${day} ${(await response.text()).slice(0, 120)}`);
      const payload = await response.json() as { bars?: Record<string, Array<{ t: string; c: number }>>; next_page_token?: string | null };
      for (const [occ, bars] of Object.entries(payload.bars ?? {})) {
        const list = paths.get(occ) ?? [];
        for (const bar of bars) {
          const when = new Date(bar.t);
          const offset = Math.round((Date.parse(`${etDay.format(when)}T00:00:00Z`) - baseUtc) / 86_400_000);
          list.push([offset * 1440 + minuteOf(when), Number(Number(bar.c).toFixed(2))]); // path minute = dayOffset*1440 + ET minute
        }
        paths.set(occ, list);
      }
      pageToken = payload.next_page_token ?? undefined;
    } while (pageToken && ++pages < 8);
  }
  const out: CausalPosition[] = [];
  for (const fire of fires) {
    let kept = 0;
    for (const expiry of expiries) { // nearest first
      if (kept >= 2) break;
      const best = candidates.filter(c => c.fire === fire && c.expiry === expiry).map(c => ({ occ: c.occ, path: paths.get(c.occ) ?? [] })).sort((a, b) => b.path.length - a.path.length)[0];
      // "Traded" is judged on the FIRE DAY up to the fire minute plus the tape after it:
      // a contract with almost no prints is not one the lane could have bought.
      if (!best || best.path.length < 30) continue;
      const path = best.path.filter(([min]) => min >= fire.fireMin);
      const firstPrint = path[0];
      if (!firstPrint || firstPrint[0] > fire.fireMin + 10 || firstPrint[1] <= 0.04) continue; // no print within 10 min of the fire = not fillable
      out.push({ day, sym: fire.sym, dir: fire.dir, lvl: kept, occ: best.occ, fireMin: fire.fireMin, entryPrint: firstPrint[1], setup: fire.setup, spot: fire.spot, path });
      kept++;
    }
  }
  return out;
}

export async function runCausalCorpus(params: Record<string, unknown>, deadline: number): Promise<CausalPosition[]> {
  const symbol = String(params.symbol ?? ""); const start = String(params.start ?? "");
  if (!symbol || !/^\d{4}-\d{2}-01T00:00:00Z$/.test(start)) throw new Error("ml-causal: params.symbol and start (YYYY-MM-01T00:00:00Z) required");
  const month = new Date(start);
  const previous = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() - 1, 1)).toISOString().replace(".000Z", "Z");
  const sessions = await loadSessions(symbol, [previous, start]); // previous month only supplies prior-day levels
  const fires = replayMonth(symbol, sessions, start.slice(0, 7));
  const byDay = new Map<string, Fire[]>();
  for (const fire of fires) byDay.set(fire.day, [...(byDay.get(fire.day) ?? []), fire]);
  const days = [...byDay.keys()].sort();
  const out: CausalPosition[] = [];
  for (let index = 0; index < days.length; index += 6) { // six fire-days at a time
    const batch = await Promise.all(days.slice(index, index + 6).map(day => fetchDay(day, byDay.get(day)!, deadline)));
    out.push(...batch.flat());
  }
  return out;
}

// CAUSAL ENGINE REPLAY (2026-11-25). Feeds the LIVE signal engine one minute at a time
// over historical minute bars — at minute t it sees bars[0..t] only — and records every
// minute it would have fired. This replaces the first corpus's event definition (the
// START of each day's strongest 30-minute move, knowable only in hindsight) with the
// engine's own, causally observable fire times.
//
// Faithful to apps/trading/lib/options/provider.ts getEquityMarketState: technicals over
// the full session so far, state.bars = last 120, prior-day levels attached. Contracts
// are two synthetic eligible 0DTE picks (the engine only needs "a call and a put exist").
// NOT replayed: SPX (no native bars), the earnings/economic guards, chain quality screens.
//
// run:  npx tsx research-bench/replay_engine.cts <dir with part-*.csv> <out fires.csv>
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateSignal } from "../apps/trading/lib/options/signal";
import { marketStateAt } from "../apps/trading/lib/options/market-state";
import type { Bar, Contract, Underlying } from "../apps/trading/lib/options/types";

const [dir, out] = process.argv.slice(2);
if (!dir || !out) throw new Error("usage: replay_engine.ts <bars dir> <out csv>");

const etHour = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hourCycle: "h23" });
function etToEpoch(day: string, minute: number): number {
  const [y, m, d] = day.split("-").map(Number);
  for (const offset of [5, 4]) {
    const guess = Date.UTC(y, m - 1, d, Math.floor(minute / 60) + offset, minute % 60);
    if (Number(etHour.format(new Date(guess))) === Math.floor(minute / 60)) return guess;
  }
  throw new Error(`cannot place ${day} ${minute}`);
}

type Row = { min: number; o: number; h: number; l: number; c: number; v: number; vw: number };
const sessions = new Map<string, Map<string, Row[]>>(); // sym -> day -> rows
for (const file of readdirSync(dir).filter(name => name.endsWith(".csv")).sort()) {
  const lines = readFileSync(join(dir, file), "utf8").split("\n");
  const header = lines[0].split(",");
  if (header.join(",") !== "day,sym,min,open,high,low,close,vol,vw") throw new Error(`${file}: unexpected header ${lines[0]}`);
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(",");
    if (p.length < 9) continue;
    const [day, sym] = p;
    if (!sessions.has(sym)) sessions.set(sym, new Map());
    const days = sessions.get(sym)!;
    if (!days.has(day)) days.set(day, []);
    days.get(day)!.push({ min: +p[2], o: +p[3], h: +p[4], l: +p[5], c: +p[6], v: +p[7], vw: p[8] === "" ? +p[6] : +p[8] });
  }
}

const mk = (side: "call" | "put", sym: string): Contract => ({
  ticker: `REPLAY-${side}`, underlying: sym as Underlying, expirationDate: "", dte: 0, side, strike: 0, exerciseStyle: "american",
  bid: 1, ask: 1.02, midpoint: 1.01, spreadPct: 2, quoteUpdatedAt: null, volume: 1000, openInterest: 1000, volumeToOpenInterest: 1,
  impliedVolatility: null, delta: side === "call" ? 0.45 : -0.45, gamma: null, theta: null, underlyingPrice: null,
  liquidityScore: 1, eligible: true, rejectionReasons: [],
} as Contract);

const outLines = ["day,sym,min,dir,setup,price,first,minsSinceExtreme,offExtremePct,dayOpen,vwap,rsi,relVol"];
let nSessions = 0, nFires = 0;
for (const [sym, days] of sessions) {
  const contracts = [mk("call", sym), mk("put", sym)];
  const dayKeys = [...days.keys()].sort();
  let prior: { high: number; low: number; close: number } | null = null;
  for (const day of dayKeys) {
    const rows = days.get(day)!.filter(r => r.min >= 570 && r.min < 960).sort((a, b) => a.min - b.min);
    const dedup: Row[] = [];
    for (const r of rows) if (!dedup.length || dedup[dedup.length - 1].min !== r.min) dedup.push(r);
    if (dedup.length < 120) { if (dedup.length) prior = { high: Math.max(...dedup.map(r => r.h)), low: Math.min(...dedup.map(r => r.l)), close: dedup[dedup.length - 1].c }; continue; }
    nSessions++;
    const bars: Bar[] = dedup.map(r => ({ timestamp: etToEpoch(day, r.min), open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v, vwap: r.vw }));
    const seen = new Set<number>();
    let hi = -Infinity, lo = Infinity, hiAt = 0, loAt = 0;
    for (let t = 0; t < bars.length; t++) {
      const bar = bars[t]; const minute = dedup[t].min;
      if (bar.high > hi) { hi = bar.high; hiAt = minute; }
      if (bar.low < lo) { lo = bar.low; loAt = minute; }
      if (minute > 885) continue; // live entry window ends 14:45
      const state = marketStateAt(sym as Underlying, bars.slice(0, t + 1));
      state.chartSymbol = sym as Underlying; state.priorDay = prior; state.bars = state.bars.slice(-120);
      const signal = generateSignal(state, contracts, { deltaTarget: 0.45, minDte: 0, trendDayEnabled: true });
      if (signal.action !== "enter_call" && signal.action !== "enter_put") continue;
      const dirN = signal.action === "enter_call" ? 1 : -1;
      const first = seen.has(dirN) ? 0 : 1; seen.add(dirN);
      const extremeAt = dirN > 0 ? hiAt : loAt; const extreme = dirN > 0 ? hi : lo;
      const offPct = dirN > 0 ? (extreme - bar.close) / extreme * 100 : (bar.close - extreme) / extreme * 100;
      const tech = state.technicals;
      outLines.push([day, sym, minute, dirN, signal.setup, bar.close, first, minute - extremeAt, offPct.toFixed(3), bars[0].open, state.referencePrice.toFixed(3),
        tech.rsi14 == null ? "" : tech.rsi14.toFixed(1), tech.relativeVolume == null ? "" : tech.relativeVolume.toFixed(2)].join(","));
      nFires++;
    }
    prior = { high: Math.max(...dedup.map(r => r.h)), low: Math.min(...dedup.map(r => r.l)), close: dedup[dedup.length - 1].c };
  }
  console.error(`${sym}: done (${dayKeys.length} days)`);
}
writeFileSync(out, outLines.join("\n"));
console.error(`sessions ${nSessions} | fire-minutes ${nFires} -> ${out}`);

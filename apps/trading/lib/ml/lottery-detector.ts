// LOTTERY-DAY DETECTOR — SHADOW SCORE ONLY (2026-11-28). It never arms anything.
//
// The frozen logistic candidate from the 11/28 causal rebuild (Codex, re-verified by an
// independent Opus check): fit on 2024-25, 21 inputs that all exist at 11:00 ET. On
// unseen 2026 it ranked days well (AUC 0.77, range 0.57-0.99) but on only THREE positive
// days, and acting on it did not improve swarm P&L per trade (-$6 [-$569, +$646]). So it
// is recorded, not used: lottery-stamp.ts writes its probability next to the day's
// inputs with armed=false, which builds an honest forward test for free. Promote it only
// after months of stamps show armed days really carry the 5x swarms.
//
// Pure and dependency-free so the parity test can pin it to the Python scores.
import shadow from "./lottery-shadow-v3.json";

export const LOTTERY_SHADOW_MODEL = "lottery-shadow-v3-2026-11-28";

type Model = { mu: number[]; sd: number[]; coef: number[]; threshold: number; features: string[] };
const model = shadow.model as Model;
export const LOTTERY_FEATURES = model.features;
export const LOTTERY_THRESHOLD = model.threshold;

// Same transform as research common.score: standardize, clip to +/-8, logistic.
export function scoreLotteryDay(vector: number[]): number {
  if (vector.length !== model.mu.length) throw new Error(`lottery detector expects ${model.mu.length} inputs, got ${vector.length}`);
  let raw = model.coef[0];
  vector.forEach((value, i) => {
    if (!Number.isFinite(value)) throw new Error(`lottery detector input ${model.features[i]} is not a number`);
    raw += model.coef[i + 1] * Math.min(8, Math.max(-8, (value - model.mu[i]) / model.sd[i]));
  });
  return 1 / (1 + Math.exp(-Math.min(35, Math.max(-35, raw))));
}

export type MinuteBar = { min: number; open: number; high: number; low: number; close: number };

// Prior-session context for one index ETF, exactly as research prior_features:
// [range / prior close, realized minute vol, today's open gap, missing flag]. Missing
// (all zeros, flag 1) when the prior session's tape ends >15 min before its close or
// today's first regular bar is later than 9:35.
export function priorSessionFeatures(prior: MinuteBar[], today: MinuteBar[], priorCloseMin: number): [number, number, number, number] {
  if (!prior.length || !today.length || prior[prior.length - 1].min < priorCloseMin - 15 || today[0].min > 575) return [0, 0, 0, 1];
  const lastClose = prior[prior.length - 1].close;
  let high = -Infinity; let low = Infinity; let squares = 0;
  prior.forEach((bar, i) => {
    high = Math.max(high, bar.high); low = Math.min(low, bar.low);
    if (i > 0) squares += Math.log(bar.close / prior[i - 1].close) ** 2;
  });
  return [(high - low) / lastClose, Math.sqrt(squares), today[0].open / lastClose - 1, 0];
}

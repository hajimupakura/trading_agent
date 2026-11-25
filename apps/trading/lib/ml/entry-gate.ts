import "server-only";
import scorer from "./entry-scorer-v1.json";
import { predictProba, type HistGbtModel } from "./histgbt";

// ENTRY-QUALITY GATE (user program 2026-11-24; walk-forward verdict same day):
// at fire time, a tree model estimates P(dying) — the chance this fire never even
// reaches +10% — from facts knowable in that second: the underlying's 30-minute leg,
// time of day, direction, index-vs-single, weekday, premium. CUTOFF = skip the worst
// 30% (user call 2026-11-25; was 40%): re-tuned on validation for TOTAL $ under the
// 7/day cap, because skipped fires are lost slots, not saved money. Deployed-model
// scoreboard ($500/trade, capped): Jun-Sep $90k (65% win) vs 40%-cutoff $102k vs no
// gate $49k; Oct-Nov holdout $54k (73% win) vs 40%-cutoff $50k vs no gate $54k. A real
// trade-off: the strict cutoff won the earlier window, the looser one the most recent.
// Skips are visible (shadow-tracked + alerted).
const MODEL = scorer as HistGbtModel;
// Loud port guard: refuse to score if the bundled JSON drifts from sklearn's checks.
for (const check of (MODEL.checks ?? []).slice(0, 3)) {
  const xs = check.x.map(v => (v == null ? Number.NaN : v));
  if (Math.abs(predictProba(MODEL, xs) - check.p) > 1e-6) throw new Error("entry scorer JSON fails its sklearn checks");
}

export function scoreEntry(input: { bars: Array<{ close: number }>; etMinutes: number; dir: 1 | -1; isIndex: boolean; dow: number; premium: number }): { prob: number; skip: boolean; threshold: number; legPct: number | null } {
  const { bars } = input;
  const legPct = bars.length >= 31 ? (bars[bars.length - 1].close / bars[bars.length - 31].close - 1) * 100 * input.dir : null;
  const prob = predictProba(MODEL, [legPct ?? Number.NaN, input.etMinutes, input.dir, input.isIndex ? 1 : 0, input.dow, input.premium]);
  return { prob, skip: prob > MODEL.threshold, threshold: MODEL.threshold, legPct };
}

import "server-only";
import scorer from "./entry-scorer-v1.json";
import { predictProba, type HistGbtModel } from "./histgbt";

// The old model was validated on hindsight-selected entries. Its verdict is
// observational by default; only an explicit control value enables enforcement.
export function entryGateDecision(verdict: ReturnType<typeof scoreEntry>, mode: "shadow" | "enforce") {
  return { mode, score: verdict.prob, threshold: verdict.threshold, wouldSkip: verdict.skip, legPct: verdict.legPct };
}

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

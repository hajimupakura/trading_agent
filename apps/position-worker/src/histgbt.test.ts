import { describe, expect, it } from "vitest";
import model from "./models/exit-advisor-v1.json" with { type: "json" };
import { predictProba, type HistGbtModel } from "./histgbt.js";

// The exported JSON carries 40 feature vectors with sklearn's own predict_proba.
// If the TS traversal ever drifts from sklearn's (feature index, threshold
// comparison, missing-value side, baseline), these fail loudly instead of the
// advisor silently stamping wrong opinions.
describe("histgbt predictor matches sklearn", () => {
  const m = model as HistGbtModel;
  it("reproduces all 40 sklearn probabilities to 1e-6", () => {
    expect(m.checks?.length).toBe(40);
    for (const check of m.checks ?? []) {
      expect(Math.abs(predictProba(m, check.x) - check.p)).toBeLessThan(1e-6);
    }
  });
  it("carries the tuned hold/exit threshold", () => {
    expect(m.threshold).toBe(0.55);
    expect(m.feats).toEqual(["gain", "peakGain", "drawdownFromPeak", "minutesHeld", "minuteOfDay", "entryPrem", "dir"]);
  });
});

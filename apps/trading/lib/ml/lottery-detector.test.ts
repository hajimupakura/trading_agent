import { describe, expect, it } from "vitest";
import shadow from "./lottery-shadow-v3.json";
import { LOTTERY_FEATURES, priorSessionFeatures, scoreLotteryDay, type MinuteBar } from "./lottery-detector";

describe("lottery shadow detector", () => {
  it("reproduces the research (Python) probabilities on real census days", () => {
    expect(shadow.checks.length).toBeGreaterThanOrEqual(10);
    for (const check of shadow.checks) expect(scoreLotteryDay(check.x)).toBeCloseTo(check.p, 9);
  });

  it("has the 21 inputs the research froze, in order", () => {
    expect(LOTTERY_FEATURES).toHaveLength(21);
    expect(LOTTERY_FEATURES.slice(0, 4)).toEqual(["n_by11", "maxleg_by11", "syms_by11", "first_fire"]);
    expect(LOTTERY_FEATURES.at(-1)).toBe("morning_missing");
  });

  it("refuses a wrong-length or non-numeric vector instead of guessing", () => {
    expect(() => scoreLotteryDay([1, 2, 3])).toThrow();
    expect(() => scoreLotteryDay(Array(21).fill(Number.NaN))).toThrow();
  });

  it("computes prior-session range, realized vol and gap like the research", () => {
    const prior: MinuteBar[] = Array.from({ length: 390 }, (_, i) => ({ min: 570 + i, open: 100 + i * 0.01, high: 100.2 + i * 0.01, low: 99.9 + i * 0.01, close: 100 + i * 0.012 }));
    const today: MinuteBar[] = [{ min: 570, open: 101.3, high: 101.5, low: 101.1, close: 101.4 }];
    const [range, rv, gap, missing] = priorSessionFeatures(prior, today, 960);
    // Values printed by research task_b.prior_features on the same arrays.
    expect(range).toBeCloseTo(0.04003133718041806, 12);
    expect(rv).toBeCloseTo(0.0023133912233104198, 12);
    expect(gap).toBeCloseTo(-0.03217793403905689, 12);
    expect(missing).toBe(0);
  });

  it("flags missing context when the prior tape ends early or today opens late", () => {
    const prior: MinuteBar[] = [{ min: 900, open: 1, high: 1, low: 1, close: 1 }];
    const today: MinuteBar[] = [{ min: 570, open: 1, high: 1, low: 1, close: 1 }];
    expect(priorSessionFeatures(prior, today, 960)).toEqual([0, 0, 0, 1]);
    expect(priorSessionFeatures([{ ...prior[0], min: 959 }], [{ ...today[0], min: 580 }], 960)).toEqual([0, 0, 0, 1]);
    // Half day: tape to 12:59 against a 13:00 close is complete.
    expect(priorSessionFeatures([{ ...prior[0], min: 779 }], today, 780)[3]).toBe(0);
  });
});

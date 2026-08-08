import { describe, expect, it } from "vitest";
import { detectSurge } from "./surge-trigger";

const prior = { o: 750, h: 758.58, l: 749.21, c: 758.01 };

describe("surge trigger", () => {
  // The 8/3 SPY session (the day before the 96x): decisive, closed near high, broke prior high.
  it("fires up on the 8/3-style breakout close", () =>
    expect(detectSurge({ o: 749.5, h: 758.58, l: 749.21, c: 758.01 }, { o: 745, h: 748.86, l: 737.7, c: 748.37 })).toBe("up"));
  it("fires down on the mirror breakdown close", () =>
    expect(detectSurge({ o: 757, h: 757.5, l: 748, c: 748.4 }, { o: 750, h: 756, l: 749.5, c: 750.2 })).toBe("down"));
  it("rejects an indecisive day even at the highs", () =>
    // V-shaped day: closed near high but body is tiny relative to range (like 7/31 daily bar).
    expect(detectSurge({ o: 757.5, h: 758.8, l: 747.7, c: 758.37 }, prior)).toBeNull());
  it("rejects a strong close that failed to break the prior high", () =>
    expect(detectSurge({ o: 750, h: 757, l: 749.5, c: 756.8 }, prior)).toBeNull());
  it("rejects a trend day that faded off its high", () =>
    expect(detectSurge({ o: 750, h: 762, l: 749.5, c: 759 }, prior)).toBeNull());
});

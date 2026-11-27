import { describe, expect, it } from "vitest";
import { morningLegs } from "./morning-legs";

// 9:30 ET on 2026-11-27 (EST, UTC-5) = 14:30 UTC.
const OPEN = Date.parse("2026-11-27T14:30:00Z");
const bars = (closes: number[], startMinute = 0) => closes.map((close, i) => ({ timestamp: OPEN + (startMinute + i) * 60_000, close }));

describe("morning 30-minute legs", () => {
  it("finds the strongest completed 30-bar move and where it started", () => {
    // flat 100 for 10 bars, then a steady climb to 103 over the next 30, then flat
    const closes = [...Array(10).fill(100), ...Array.from({ length: 30 }, (_, i) => 100 + (i + 1) * 0.1), ...Array(20).fill(103)];
    const legs = morningLegs("TEST", bars(closes));
    expect(legs).toHaveLength(1);
    expect(legs[0].dir).toBe(1); expect(legs[0].legPct).toBeCloseTo(3, 1); expect(legs[0].startMin).toBe(579);
  });
  it("ignores moves under 1.5% and reports each direction separately", () => {
    expect(morningLegs("QUIET", bars(Array.from({ length: 80 }, (_, i) => 100 + i * 0.01)))).toHaveLength(0);
    const down = morningLegs("DROP", bars(Array.from({ length: 60 }, (_, i) => 100 - i * 0.1)));
    expect(down).toHaveLength(1); expect(down[0].dir).toBe(-1);
  });
  it("never uses bars from 11:00 on — a leg must be complete by then", () => {
    // flat until 10:45, then a 5% ramp that only completes after 11:00
    const closes = [...Array(75).fill(100), ...Array.from({ length: 45 }, (_, i) => 100 + (i + 1) * (5 / 30))];
    const legs = morningLegs("LATE", bars(closes));
    // only the 15 ramp bars before 11:00 are visible: 15 * (5/30) = 2.5% from a start 30 bars back
    expect(legs[0]?.legPct ?? 0).toBeLessThan(2.6);
    expect(morningLegs("AFTER", bars(closes.slice(90), 90))).toHaveLength(0);
  });
});

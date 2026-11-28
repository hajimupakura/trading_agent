import { describe, expect, it } from "vitest";
import { eligibleBySessions, indexDteAllowed, weekdayDte } from "./session-dte";

describe("weekday DTE", () => {
  it("counts Friday -> Monday as one session", () => {
    // 2026-12-04 is a Friday; Monday 2026-12-07 is 3 calendar days out.
    expect(weekdayDte("2026-12-07", 3)).toBe(1);
    expect(weekdayDte("2026-12-08", 4)).toBe(2); // Friday -> Tuesday
  });
  it("leaves weekday spans and same-day alone", () => {
    expect(weekdayDte("2026-12-02", 1)).toBe(1); // Tue -> Wed
    expect(weekdayDte("2026-12-03", 2)).toBe(2); // Tue -> Thu
    expect(weekdayDte("2026-12-01", 0)).toBe(0);
  });
  it("never shortens a real span", () => {
    expect(weekdayDte("2026-12-11", 7)).toBe(5); // Fri -> next Fri
  });
  it("lets the Monday index contract through on a Friday, not the week after", () => {
    expect(indexDteAllowed([0, 1, 2], { expirationDate: "2026-12-07", dte: 3 })).toBe(true);
    expect(indexDteAllowed([0, 1, 2], { expirationDate: "2026-12-09", dte: 5 })).toBe(false);
    expect(indexDteAllowed([0], { expirationDate: "2026-12-07", dte: 3 })).toBe(false);
  });
});

describe("eligible by sessions (paper next-expiry choice only)", () => {
  const monday = { expirationDate: "2026-12-07", dte: 3 };
  it("forgives only the calendar-DTE rejection", () => {
    expect(eligibleBySessions({ ...monday, eligible: false, rejectionReasons: ["Next-session expiry — the engine trades 0-2 calendar DTE; manual entries only"] }, [0, 1, 2])).toBe(true);
  });
  it("still rejects a contract that fails any other screen", () => {
    expect(eligibleBySessions({ ...monday, eligible: false, rejectionReasons: ["Next-session expiry — x", "Spread exceeds 10%"] }, [0, 1, 2])).toBe(false);
    expect(eligibleBySessions({ expirationDate: "2026-12-09", dte: 5, eligible: false, rejectionReasons: ["Next-session expiry — x"] }, [0, 1, 2])).toBe(false);
  });
});

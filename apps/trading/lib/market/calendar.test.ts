import { describe, expect, it } from "vitest";
import { MarketCalendar } from "./calendar";

describe("app market calendar (fallback table)", () => {
  const calendar = new MarketCalendar();
  it("knows the 2026-2027 holidays and early closes", () => {
    expect(calendar.isTradingDay("2026-11-26")).toBe(false);
    expect(calendar.session("2026-11-27")?.closeMin).toBe(780);
    expect(calendar.isTradingDay("2027-03-26")).toBe(false); // Good Friday 2027
    expect(calendar.session("2026-11-30")?.closeMin).toBe(960);
  });
});

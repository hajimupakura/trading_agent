import { describe, expect, it } from "vitest";
import { MarketCalendar, buyBlockReason } from "./calendar";

describe("app market calendar (fallback table)", () => {
  const calendar = new MarketCalendar();
  it("knows the 2026-2027 holidays and early closes", () => {
    expect(calendar.isTradingDay("2026-11-26")).toBe(false);
    expect(calendar.session("2026-11-27")?.closeMin).toBe(780);
    expect(calendar.isTradingDay("2027-03-26")).toBe(false); // Good Friday 2027
    expect(calendar.session("2026-11-30")?.closeMin).toBe(960);
  });
});

describe("buy gate for taps, manual and queued orders", () => {
  const calendar = new MarketCalendar();
  it("refuses any buy on Thanksgiving", () => expect(buyBlockReason(calendar, new Date("2026-11-26T15:00:00Z"), "2026-11-27")).toContain("market holiday"));
  it("refuses any buy after the 1:00 pm early close", () => expect(buyBlockReason(calendar, new Date("2026-11-27T18:05:00Z"), "2026-12-04")).toContain("closed right now"));
  it("refuses a same-day contract after the 12:10 half-day forced exit", () => expect(buyBlockReason(calendar, new Date("2026-11-27T17:42:00Z"), "2026-11-27")).toContain("force-sold"));
  it("allows a later-expiry contract at 12:42 on the half day", () => expect(buyBlockReason(calendar, new Date("2026-11-27T17:42:00Z"), "2026-12-04")).toBe(null));
  it("allows a same-day contract at 3:00 pm on a regular day, refuses it at 3:10 pm", () => {
    expect(buyBlockReason(calendar, new Date("2026-11-30T20:00:00Z"), "2026-11-30")).toBe(null);
    expect(buyBlockReason(calendar, new Date("2026-11-30T20:10:00Z"), "2026-11-30")).toContain("force-sold");
  });
});

describe("next trading session", () => {
  const calendar = new MarketCalendar();
  it("skips the weekend: Friday -> Monday", () => expect(calendar.nextSession("2026-11-27")).toBe("2026-11-30"));
  it("skips a holiday: Wednesday before Thanksgiving -> Friday", () => expect(calendar.nextSession("2026-11-25")).toBe("2026-11-27"));
});

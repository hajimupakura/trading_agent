import { describe, expect, it } from "vitest";
import { evaluateExit } from "./exit-engine.js";
import { MarketCalendar } from "./market-calendar.js";
import type { ManagedPosition } from "./types.js";

// Thanksgiving week 2026 as Alpaca publishes it: Thu 11/26 closed, Fri 11/27 closes 13:00.
const week = new MarketCalendar(new Map([
  ["2026-11-23", { openMin: 570, closeMin: 960 }], ["2026-11-24", { openMin: 570, closeMin: 960 }],
  ["2026-11-25", { openMin: 570, closeMin: 960 }], ["2026-11-27", { openMin: 570, closeMin: 780 }],
  ["2026-11-30", { openMin: 570, closeMin: 960 }], ["2026-12-01", { openMin: 570, closeMin: 960 }],
]), "2026-11-23", "2026-12-01");
const fallback = new MarketCalendar(); // the built-in table, as used during an Alpaca outage
const et = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00-05:00`); // November = EST

const base: ManagedPosition = { ticker: "O:SNDK261204C00078000", alpacaSymbol: "SNDK261204C00078000", side: "call", quantity: 7, entryPrice: 3.9, peakBid: 3.9,
  openedAt: Date.parse("2026-11-25T19:07:00Z"), signalId: "s", userId: "u", market: { openingRangeHigh: 1, openingRangeLow: 0, referencePrice: 1, chartSymbol: "SNDK" },
  closeOrderId: null, closeOrderSubmittedAt: null, exitMode: "convexity" };

describe("market calendar", () => {
  it("knows Thanksgiving is closed and Friday is a half day, from Alpaca or the fallback table", () => {
    for (const calendar of [week, fallback]) {
      expect(calendar.isTradingDay("2026-11-26")).toBe(false);
      expect(calendar.session("2026-11-27")).toEqual({ openMin: 570, closeMin: 780 });
      expect(calendar.inSession("2026-11-26", 600)).toBe(false);
      expect(calendar.inSession("2026-11-27", 790)).toBe(false);
    }
  });
  it("counts trading sessions, not weekdays", () => {
    expect(week.tradingDaysBetween("2026-11-25", "2026-11-27")).toBe(1); // Thursday is a holiday
    expect(week.tradingDaysBetween("2026-11-25", "2026-11-30")).toBe(2);
    expect(week.tradingDaysBetween("2026-11-24", "2026-11-27")).toBe(2);
  });
  it("moves 'minutes before the close' rules to the early close", () => {
    expect(week.beforeClose("2026-11-27", 910)).toBe(730); // 15:10 flat -> 12:10
    expect(week.beforeClose("2026-11-27", 945)).toBe(765); // 15:45 -> 12:45
    expect(week.beforeClose("2026-11-30", 910)).toBe(910);
  });
});

describe("exits on Thanksgiving week", () => {
  it("a swarm bought Wednesday is not sold on Friday (only 1 session held) and sells Monday 15:45", () => {
    expect(evaluateExit({ position: base, bid: 9.5, underlyingPrice: null, now: et("2026-11-27", "12:50"), calendar: week })).toBe(null);
    expect(evaluateExit({ position: base, bid: 9.5, underlyingPrice: null, now: et("2026-11-30", "15:40"), calendar: week })).toBe(null);
    expect(evaluateExit({ position: base, bid: 9.5, underlyingPrice: null, now: et("2026-11-30", "15:45"), calendar: week })).toBe("mandatory_time_exit");
  });
  it("a swarm bought Tuesday hits day+2 on the half day and sells at 12:45, before the 13:00 close", () => {
    const tuesday = { ...base, openedAt: Date.parse("2026-11-24T15:02:00Z") };
    expect(evaluateExit({ position: tuesday, bid: 1, underlyingPrice: null, now: et("2026-11-27", "12:40"), calendar: week })).toBe(null);
    expect(evaluateExit({ position: tuesday, bid: 1, underlyingPrice: null, now: et("2026-11-27", "12:45"), calendar: week })).toBe("mandatory_time_exit");
  });
  it("sells a swarm expiring on the half day at 12:30, not at the open", () => {
    const expiring = { ...base, ticker: "O:SPCX261127P00119000", alpacaSymbol: "SPCX261127P00119000", openedAt: Date.parse("2026-11-26T15:00:00Z") };
    expect(evaluateExit({ position: expiring, bid: 0.5, underlyingPrice: null, now: et("2026-11-27", "09:31"), calendar: week })).toBe(null);
    expect(evaluateExit({ position: expiring, bid: 0.5, underlyingPrice: null, now: et("2026-11-27", "12:29"), calendar: week })).toBe(null);
    expect(evaluateExit({ position: expiring, bid: 0.5, underlyingPrice: null, now: et("2026-11-27", "12:30"), calendar: week })).toBe("mandatory_time_exit");
  });
  it("never fires a time exit on the holiday itself", () => {
    const tuesday = { ...base, openedAt: Date.parse("2026-11-24T15:02:00Z") };
    expect(evaluateExit({ position: tuesday, bid: 1, underlyingPrice: null, now: et("2026-11-26", "15:50"), calendar: week })).toBe(null);
  });
  it("flats a same-day option at 12:10 on the half day, before it expires at 13:00", () => {
    const sameDay: ManagedPosition = { ...base, ticker: "O:SPY261127C00726000", alpacaSymbol: "SPY261127C00726000", entryPrice: 1, peakBid: 1.2, openedAt: Date.parse("2026-11-27T16:38:00Z"), exitMode: "burst" };
    expect(evaluateExit({ position: sameDay, bid: 1.15, underlyingPrice: null, now: et("2026-11-27", "12:05"), calendar: week })).toBe(null);
    expect(evaluateExit({ position: sameDay, bid: 1.15, underlyingPrice: null, now: et("2026-11-27", "12:10"), calendar: week })).toBe("mandatory_time_exit");
  });
});

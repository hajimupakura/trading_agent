import { describe, expect, it } from "vitest";
import { evaluateExit } from "./exit-engine.js";
import type { ManagedPosition } from "./types.js";

const base:ManagedPosition = { ticker:"O:SPY260806C00770000", alpacaSymbol:"SPY260806C00770000", side:"call", quantity:1, entryPrice:4, peakBid:4, openedAt:Date.parse("2026-08-06T14:00:00Z"), signalId:"signal", userId:"user", market:{ openingRangeHigh:770, openingRangeLow:765, referencePrice:768, chartSymbol:"SPY" }, closeOrderId:null, closeOrderSubmittedAt:null, exitMode:"burst" };
const at = (time:string) => new Date(`2026-08-06T${time}:00Z`);
describe("automatic paper exit engine", () => {
  it("triggers the 30% premium stop", () => expect(evaluateExit({ position:base, bid:2.8, underlyingPrice:771, now:at("14:05") })).toBe("premium_stop"));
  it("invalidates a failed call breakout", () => expect(evaluateExit({ position:base, bid:3.9, underlyingPrice:769.9, now:at("14:05") })).toBe("underlying_invalidation"));
  it("protects a winner with the 20% trail", () => expect(evaluateExit({ position:{...base,peakBid:6}, bid:4.8, underlyingPrice:771, now:at("14:05") })).toBe("trailing_stop"));
  it("tightens the trail after a 100% gain", () => expect(evaluateExit({ position:{...base,peakBid:8}, bid:6.79, underlyingPrice:771, now:at("14:05") })).toBe("trailing_stop"));
  it("exits after ten minutes without 10% follow-through", () => expect(evaluateExit({ position:{...base,peakBid:4.2}, bid:3.9, underlyingPrice:771, now:at("14:11") })).toBe("no_follow_through"));
  it("forces the time exit at 3:10 p.m. ET", () => expect(evaluateExit({ position:base, bid:4, underlyingPrice:771, now:at("19:10") })).toBe("mandatory_time_exit"));
  it("closes an overnight position when the next session opens", () => expect(evaluateExit({ position:base, bid:4, underlyingPrice:771, now:new Date("2026-08-07T13:30:00Z") })).toBe("mandatory_time_exit"));
});

const swing:ManagedPosition = { ...base, openedAt:Date.parse("2026-08-06T19:46:00Z") }; // 15:46 ET
describe("swing exit handling", () => {
  it("does not force-flat a swing entry before the close", () => expect(evaluateExit({ position:swing, bid:4, underlyingPrice:771, now:at("19:55") })).toBe(null));
  it("skips the ten-minute follow-through test for swing entries", () => expect(evaluateExit({ position:{...swing,peakBid:4.1}, bid:3.9, underlyingPrice:771, now:at("19:57") })).toBe(null));
  it("holds a swing position through the next open", () => expect(evaluateExit({ position:swing, bid:4.5, underlyingPrice:771, now:new Date("2026-08-07T13:35:00Z") })).toBe(null));
  it("stops out a swing position on a gap down at the open", () => expect(evaluateExit({ position:swing, bid:2.5, underlyingPrice:771, now:new Date("2026-08-07T13:31:00Z") })).toBe("premium_stop"));
  it("keeps holding through the next morning while no sell criterion is met", () => expect(evaluateExit({ position:swing, bid:4.5, underlyingPrice:771, now:new Date("2026-08-07T14:30:00Z") })).toBe(null));
  it("keeps holding into the next afternoon while no sell criterion is met", () => expect(evaluateExit({ position:swing, bid:4.5, underlyingPrice:771, now:new Date("2026-08-07T18:00:00Z") })).toBe(null));
  it("goes flat at 15:10 on the day after entry to beat expiry", () => expect(evaluateExit({ position:swing, bid:4.5, underlyingPrice:771, now:new Date("2026-08-07T19:10:00Z") })).toBe("mandatory_time_exit"));
});

const scalp:ManagedPosition = { ...base, exitMode:"scalp" };
describe("scalp exit handling (v2: replay-calibrated — patient exits on scalp entries)", () => {
  it("keeps the 30% premium stop", () => expect(evaluateExit({ position:scalp, bid:2.8, underlyingPrice:771, now:at("14:05") })).toBe("premium_stop"));
  it("does not sell a double — winners ride the trail", () => expect(evaluateExit({ position:{...scalp,peakBid:8}, bid:8, underlyingPrice:771, now:at("14:05") })).toBe(null));
  it("trails 20% once up 40%", () => expect(evaluateExit({ position:{...scalp,peakBid:6}, bid:4.8, underlyingPrice:771, now:at("14:05") })).toBe("trailing_stop"));
  it("tightens the trail to 15% after 2x", () => expect(evaluateExit({ position:{...scalp,peakBid:8}, bid:6.79, underlyingPrice:771, now:at("14:05") })).toBe("trailing_stop"));
  it("has no 30-minute time box (winners need an hour)", () => expect(evaluateExit({ position:{...scalp,peakBid:4.4}, bid:4.2, underlyingPrice:771, now:at("14:31") })).toBe(null));
  it("skips the 10-minute follow-through test", () => expect(evaluateExit({ position:{...scalp,peakBid:4.2}, bid:3.9, underlyingPrice:771, now:at("14:11") })).toBe(null));
  it("ignores underlying invalidation (reclaim entries have no ORB context)", () => expect(evaluateExit({ position:scalp, bid:3.9, underlyingPrice:769.9, now:at("14:05") })).toBe(null));
  it("still goes flat at 15:10 as a backstop", () => expect(evaluateExit({ position:scalp, bid:4, underlyingPrice:771, now:at("19:10") })).toBe("mandatory_time_exit"));
});

describe("long-dated position handling", () => {
  it("does not force-flat long-dated positions at 15:10", () => expect(evaluateExit({ position:base, bid:4, underlyingPrice:771, longDated:true, now:at("19:10") })).toBe(null));
  it("keeps the 30% stop for long-dated positions", () => expect(evaluateExit({ position:base, bid:2.7, underlyingPrice:771, longDated:true, now:at("19:10") })).toBe("premium_stop"));
  it("keeps the trailing stop for long-dated positions", () => expect(evaluateExit({ position:{...base,peakBid:8}, bid:6.7, underlyingPrice:771, longDated:true, now:at("14:05") })).toBe("trailing_stop"));
});

import { describe, expect, it } from "vitest";
import { evaluateExit } from "./exit-engine.js";
import type { ManagedPosition } from "./types.js";

const base:ManagedPosition = { ticker:"O:SPY260806C00770000", alpacaSymbol:"SPY260806C00770000", side:"call", quantity:1, entryPrice:4, peakBid:4, openedAt:Date.parse("2026-08-06T14:00:00Z"), signalId:"signal", userId:"user", market:{ openingRangeHigh:770, openingRangeLow:765, referencePrice:768, chartSymbol:"SPY" }, closeOrderId:null, closeOrderSubmittedAt:null };
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

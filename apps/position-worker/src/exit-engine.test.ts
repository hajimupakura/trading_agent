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
  // Breakeven ratchet: a +25%-peaked winner never round-trips into a loss…
  it("ratchets a +25% peak to breakeven when bid returns to entry", () => expect(evaluateExit({ position:{...base,peakBid:5.1}, bid:4, underlyingPrice:771, now:at("14:05") })).toBe("breakeven_ratchet"));
  // …but holds while the bid stays above entry (trail at 33/20 not yet armed at +27%).
  it("does not ratchet while the bid holds above entry", () => expect(evaluateExit({ position:{...base,peakBid:5.1}, bid:4.2, underlyingPrice:771, now:at("14:05") })).toBe(null));
  it("forces the time exit at 3:10 p.m. ET", () => expect(evaluateExit({ position:base, bid:4, underlyingPrice:771, now:at("19:10") })).toBe("mandatory_time_exit"));
  // Morning grace (2026-08-14): overnight positions are NOT dumped at the bell — the
  // open gets until 9:45 to show its hand. Losers flat at 9:45; winners keep riding.
  it("holds an overnight position through the 9:30-9:44 grace window", () => expect(evaluateExit({ position:base, bid:4, underlyingPrice:771, now:new Date("2026-08-07T13:30:00Z") })).toBe(null));
  it("flats an overnight loser at 9:45", () => expect(evaluateExit({ position:base, bid:3.9, underlyingPrice:771, now:new Date("2026-08-07T13:45:00Z") })).toBe("mandatory_time_exit"));
  it("lets an overnight winner keep riding at 9:45", () => expect(evaluateExit({ position:{...base,peakBid:4.4}, bid:4.4, underlyingPrice:771, now:new Date("2026-08-07T13:45:00Z") })).toBe(null));
  // Dollar lock stays awake during overnight grace: a big-dollar winner fading in the
  // 9:30-9:44 window locks in 60% of the peak gain instead of round-tripping asleep.
  it("locks a big overnight winner during the morning grace window", () => expect(evaluateExit({ position:{...base,peakBid:12}, bid:8, underlyingPrice:771, now:new Date("2026-08-07T13:35:00Z") })).toBe("trailing_stop"));
  it("still holds a modest overnight winner through the grace window", () => expect(evaluateExit({ position:{...base,peakBid:5}, bid:4.5, underlyingPrice:771, now:new Date("2026-08-07T13:35:00Z") })).toBe(null));
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

describe("convexity swarm mode (time-only exits)", () => {
  // Entry Monday 2026-08-03, Friday 2026-08-07 expiry (4 DTE), far-OTM swarm.
  const conv:ManagedPosition = { ...base, ticker:"O:NVDA260807C00200000", alpacaSymbol:"NVDA260807C00200000", entryPrice:0.10, peakBid:0.10, openedAt:Date.parse("2026-08-03T14:00:00Z"), exitMode:"convexity" };
  it("never premium-stops: a -70% bid holds", () => expect(evaluateExit({ position:conv, bid:0.03, underlyingPrice:null, now:new Date("2026-08-03T18:00:00Z") })).toBe(null));
  it("never trails: a 10x spike fading 50% holds", () => expect(evaluateExit({ position:{...conv,peakBid:1.0}, bid:0.5, underlyingPrice:null, now:new Date("2026-08-04T18:00:00Z") })).toBe(null));
  it("is exempt from the $300 dollar lock", () => expect(evaluateExit({ position:{...conv,quantity:250,peakBid:0.40}, bid:0.20, underlyingPrice:null, now:new Date("2026-08-04T18:00:00Z") })).toBe(null));
  it("holds through day+1 close", () => expect(evaluateExit({ position:conv, bid:0.30, underlyingPrice:null, now:new Date("2026-08-04T20:50:00Z") })).toBe(null));
  it("flats at day+2 15:45 ET", () => expect(evaluateExit({ position:conv, bid:0.30, underlyingPrice:null, now:new Date("2026-08-05T19:45:00Z") })).toBe("mandatory_time_exit"));
  it("holds day+2 before 15:45 ET", () => expect(evaluateExit({ position:conv, bid:0.30, underlyingPrice:null, now:new Date("2026-08-05T19:30:00Z") })).toBe(null));
  // Friday entry -> Tuesday is day+2 (the weekend never counts as held days).
  it("counts trading days across a weekend", () => expect(evaluateExit({ position:{...conv,alpacaSymbol:"NVDA260814C00200000",ticker:"O:NVDA260814C00200000",openedAt:Date.parse("2026-08-07T15:00:00Z")}, bid:0.30, underlyingPrice:null, now:new Date("2026-08-10T19:50:00Z") })).toBe(null));
  it("flats at expiry-day 12:30 ET as the last guard (half-day safe)", () => expect(evaluateExit({ position:{...conv,openedAt:Date.parse("2026-08-06T18:00:00Z")}, bid:0.30, underlyingPrice:null, now:new Date("2026-08-07T16:31:00Z") })).toBe("mandatory_time_exit"));
  it("still holds on expiry morning before 12:30", () => expect(evaluateExit({ position:{...conv,openedAt:Date.parse("2026-08-06T18:00:00Z")}, bid:0.30, underlyingPrice:null, now:new Date("2026-08-07T16:00:00Z") })).toBe(null));
});

// ML HYBRID (2026-11-24): when the manager supplies the advisor's probability, the
// model replaces the trail and ratchet on plain same-day positions — the V0 floor
// (stop, flat, no-follow-through, invalidation) always keeps the last word.
const ML_HOLD = { prob: 0.9, threshold: 0.55 };
const ML_SELL = { prob: 0.2, threshold: 0.55 };
describe("ml hybrid exits", () => {
  it("holds through what the old trail would have sold when the model likes the tape", () =>
    expect(evaluateExit({ position:{...base,peakBid:6}, bid:4.8, underlyingPrice:771, now:at("14:05"), ml:ML_HOLD })).toBe(null));
  it("skips the breakeven ratchet while the model holds", () =>
    expect(evaluateExit({ position:{...base,peakBid:5.1}, bid:4, underlyingPrice:771, now:at("14:05"), ml:ML_HOLD })).toBe(null));
  it("sells when the model says the upside is spent", () =>
    expect(evaluateExit({ position:base, bid:4.1, underlyingPrice:771, now:at("14:05"), ml:ML_SELL })).toBe("ml_advisor_exit"));
  it("gives a fresh fill three minutes before the model may sell", () =>
    expect(evaluateExit({ position:base, bid:4.1, underlyingPrice:771, now:at("14:02"), ml:ML_SELL })).toBe(null));
  it("hard stop outranks a bullish model", () =>
    expect(evaluateExit({ position:base, bid:2.8, underlyingPrice:771, now:at("14:05"), ml:ML_HOLD })).toBe("premium_stop"));
  it("15:10 flat outranks a bullish model", () =>
    expect(evaluateExit({ position:base, bid:4.5, underlyingPrice:771, now:at("19:10"), ml:ML_HOLD })).toBe("mandatory_time_exit"));
  it("no-follow-through floor still fires under a bullish model", () =>
    expect(evaluateExit({ position:{...base,peakBid:4.2}, bid:3.9, underlyingPrice:771, now:at("14:11"), ml:ML_HOLD })).toBe("no_follow_through"));
  it("overnight positions ignore the model and keep V0 (out of distribution)", () =>
    expect(evaluateExit({ position:{...base,peakBid:6}, bid:4.7, underlyingPrice:771, now:new Date("2026-08-07T14:30:00Z"), ml:ML_HOLD })).toBe("trailing_stop"));
  it("big-premium contracts keep their calibrated envelope, not the model", () =>
    expect(evaluateExit({ position:{...base,entryPrice:40,peakBid:46}, bid:42, underlyingPrice:771, now:at("14:05"), ml:ML_SELL })).toBe("trailing_stop"));
  it("without the advisor the old trail applies unchanged", () =>
    expect(evaluateExit({ position:{...base,peakBid:6}, bid:4.8, underlyingPrice:771, now:at("14:05") })).toBe("trailing_stop"));
});

// REAL LANE + ML (user call 2026-11-24: "small amount of real money — activate the ml
// models, same exit strategy as paper"): the Robinhood lane runs the identical hybrid.
const realPos:ManagedPosition = { ...base, userId:"robinhood" };
describe("ml hybrid on the real lane", () => {
  it("real lane holds through the old +20/15 trail when the model likes the tape", () =>
    expect(evaluateExit({ position:{...realPos,peakBid:5}, bid:4.2, underlyingPrice:771, now:at("14:05"), ml:ML_HOLD })).toBe(null));
  it("real lane sells on the model's word", () =>
    expect(evaluateExit({ position:realPos, bid:4.1, underlyingPrice:771, now:at("14:05"), ml:ML_SELL })).toBe("ml_advisor_exit"));
  it("real lane hard stop still outranks a bullish model", () =>
    expect(evaluateExit({ position:realPos, bid:2.8, underlyingPrice:771, now:at("14:05"), ml:ML_HOLD })).toBe("premium_stop"));
  it("real lane without the advisor keeps its calibrated +20/15 trail", () =>
    expect(evaluateExit({ position:{...realPos,peakBid:5}, bid:4.2, underlyingPrice:771, now:at("14:05") })).toBe("trailing_stop"));
});

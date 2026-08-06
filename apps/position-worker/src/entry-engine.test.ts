import { describe, expect, it } from "vitest";
import { planEntryOrder } from "./entry-engine.js";

describe("entry-order escalation", () => {
  const quote = { ask:2.10, midpoint:2.00 };
  it("holds at the midpoint while fresh", () => expect(planEntryOrder({ ageMs:5_000, ...quote, currentLimit:2.00 })).toEqual({ action:"hold" }));
  it("escalates halfway to the ask after 15s", () => expect(planEntryOrder({ ageMs:16_000, ...quote, currentLimit:2.00 })).toEqual({ action:"reprice", price:2.05 }));
  it("goes to the ask after 30s", () => expect(planEntryOrder({ ageMs:31_000, ...quote, currentLimit:2.05 })).toEqual({ action:"reprice", price:2.10 }));
  it("never lowers a buy limit when the market drops", () => expect(planEntryOrder({ ageMs:31_000, ask:1.80, midpoint:1.70, currentLimit:2.05 })).toEqual({ action:"hold" }));
  it("cancels a stale unfilled entry", () => expect(planEntryOrder({ ageMs:76_000, ...quote, currentLimit:2.10 })).toEqual({ action:"cancel" }));
});

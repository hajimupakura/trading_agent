import { describe, expect, it } from "vitest";
import { validatePaperEntry } from "./risk";
import type { Contract, Signal } from "@/lib/options/types";

const contract = { ticker:"O:SPY260806C00770000", underlying:"SPY", expirationDate:"2026-08-06", dte:0, side:"call", strike:770, exerciseStyle:"american", bid:7.7, ask:8, midpoint:7.85, spreadPct:3.8, quoteUpdatedAt:Date.now(), volume:5000, openInterest:2000, volumeToOpenInterest:2.5, impliedVolatility:.2, delta:.5, gamma:.1, theta:-.3, underlyingPrice:770, liquidityScore:90, eligible:true, rejectionReasons:[] } satisfies Contract;
const signal = { id:"SPY-signal-entry", generatedAt:Date.now(), action:"enter_call", setup:"opening_range", confidence:80, reasons:[], invalidation:"below VWAP", contract, market:{} as Signal["market"] } satisfies Signal;
const account = { id:"paper", status:"ACTIVE", currency:"USD", equity:"100000", last_equity:"100000", cash:"100000", buying_power:"400000", options_buying_power:"100000", options_approved_level:2 };
const inWindow = new Date("2026-08-06T14:00:00.000Z");

describe("paper-entry risk gate", () => {
  it("allows one $800 contract in a flat $100k paper account", () => {
    expect(validatePaperEntry({ signal, contract, account, positions:[], orders:[], tradesToday:0, now:inWindow }).allowed).toBe(true);
  });
  it("blocks the entry after a one-percent daily loss", () => {
    const result = validatePaperEntry({ signal, contract, account:{ ...account, equity:"99000" }, positions:[], orders:[], tradesToday:0, now:inWindow });
    expect(result.errors).toContain("Daily loss limit has been reached");
  });
  it("blocks a fourth entry and any concurrent option position", () => {
    const position = { symbol:"SPY260806C00770000", asset_class:"us_option", qty:"1", market_value:"800", cost_basis:"800", unrealized_pl:"0", unrealized_plpc:"0" };
    const result = validatePaperEntry({ signal, contract, account, positions:[position], orders:[], tradesToday:3, now:inWindow });
    expect(result.errors).toContain("Maximum three entries per day reached");
    expect(result.errors).toContain("An option position is already open");
  });
  it("blocks entries outside the approved time window", () => {
    const result = validatePaperEntry({ signal, contract, account, positions:[], orders:[], tradesToday:0, now:new Date("2026-08-06T19:00:00.000Z") });
    expect(result.errors).toContain("Entries are limited to 9:45 a.m.–2:45 p.m. ET");
  });
});

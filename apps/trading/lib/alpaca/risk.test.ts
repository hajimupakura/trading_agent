import { describe, expect, it } from "vitest";
import { computePositionSize, entryCooldownActive, validatePaperEntry } from "./risk";
import { DEFAULT_RISK_SETTINGS } from "@/lib/settings/config";
import type { Contract, Signal } from "@/lib/options/types";

const contract = { ticker:"O:SPY260806C00770000", underlying:"SPY", expirationDate:"2026-08-06", dte:0, side:"call", strike:770, exerciseStyle:"american", bid:7.7, ask:8, midpoint:7.85, spreadPct:3.8, quoteUpdatedAt:Date.now(), volume:5000, openInterest:2000, volumeToOpenInterest:2.5, impliedVolatility:.2, delta:.5, gamma:.1, theta:-.3, underlyingPrice:770, liquidityScore:90, eligible:true, rejectionReasons:[] } satisfies Contract;
const signal = { id:"SPY-signal-entry", generatedAt:Date.now(), action:"enter_call", setup:"opening_range", confidence:80, reasons:[], invalidation:"below VWAP", contract, market:{} as Signal["market"] } satisfies Signal;
const account = { id:"paper", status:"ACTIVE", currency:"USD", equity:"100000", last_equity:"100000", cash:"100000", buying_power:"400000", options_buying_power:"100000", options_approved_level:2 };
const inWindow = new Date("2026-08-06T14:00:00.000Z");

describe("paper-entry risk gate", () => {
  it("allows one $800 contract in a flat $100k paper account", () => {
    expect(validatePaperEntry({ signal, contract, account, positions:[], orders:[], tradesToday:0, now:inWindow }).allowed).toBe(true);
  });
  it("blocks the entry after the configured absolute daily loss", () => {
    const result = validatePaperEntry({ signal, contract, account:{ ...account, equity:"99000" }, positions:[], orders:[], tradesToday:0, now:inWindow });
    expect(result.errors).toContain("Daily loss limit of $500 has been reached");
  });
  it("blocks a fourth entry and any concurrent option position", () => {
    const position = { symbol:"SPY260806C00770000", asset_class:"us_option", qty:"1", market_value:"800", cost_basis:"800", unrealized_pl:"0", unrealized_plpc:"0" };
    const result = validatePaperEntry({ signal, contract, account, positions:[position], orders:[], tradesToday:3, now:inWindow });
    expect(result.errors).toContain("Maximum 3 entries per day reached");
    expect(result.errors).toContain("Maximum 1 open option positions reached");
  });
  it("blocks entries outside the approved time window", () => {
    const result = validatePaperEntry({ signal, contract, account, positions:[], orders:[], tradesToday:0, now:new Date("2026-08-06T19:00:00.000Z") });
    expect(result.errors).toContain("Current time is outside the configured ET entry window");
  });
  it("enforces a tighter saved debit limit",()=>{const result=validatePaperEntry({signal,contract,account,positions:[],orders:[],tradesToday:0,now:inWindow,settings:{maxOptionAsk:8,maxTradeDebit:500,maxDailyLoss:500,maxTradesPerDay:3,allowedUnderlyings:["SPY","SPX"],allowedDte:[0,1,2],minContractVolume:100,maxSpreadPct:10,maxOpenPositions:1,entryStartMinutes:585,entryEndMinutes:885,paperTradingEnabled:true,aiReviewEnabled:false,riskPerTradePct:.005,maxContractsPerTrade:5,deltaTarget:.45,swingTradingEnabled:false,swingEntryStartMinutes:945,swingEntryEndMinutes:958,trendDayEntriesEnabled:true}});expect(result.errors).toContain("Total debit (1 contract) exceeds the $500 per-trade limit");});
});

describe("position sizing", () => {
  it("sizes by risk budget then applies the tightest debit cap", () => {
    // $2 ask: risk budget $500 (0.5% of $100k), $60 risk/contract -> 8 by risk,
    // but $800 trade cap -> 4 and 1% equity cap -> 5; tightest wins.
    expect(computePositionSize({ ask:2, equity:100_000, optionsBuyingPower:100_000, settings:DEFAULT_RISK_SETTINGS })).toBe(4);
  });
  it("caps at maxContractsPerTrade for cheap contracts", () => {
    expect(computePositionSize({ ask:.2, equity:100_000, optionsBuyingPower:100_000, settings:DEFAULT_RISK_SETTINGS })).toBe(5);
  });
  it("never sizes below one contract", () => {
    expect(computePositionSize({ ask:8, equity:1_000, optionsBuyingPower:100, settings:DEFAULT_RISK_SETTINGS })).toBe(1);
  });
  it("multi-contract debit is validated in total", () => {
    const cheap = { ...contract, ask:5, bid:4.8, midpoint:4.9 };
    const result = validatePaperEntry({ signal, contract:cheap, account, positions:[], orders:[], tradesToday:0, now:inWindow, quantity:2 });
    expect(result.debit).toBe(1000);
    expect(result.errors).toContain("Total debit (2 contracts) exceeds the $800 per-trade limit");
  });
});

describe("swing entry window", () => {
  const swingSettings = { ...DEFAULT_RISK_SETTINGS, swingTradingEnabled:true };
  const lateDay = new Date("2026-08-06T19:50:00.000Z"); // 15:50 ET, inside the 15:45-15:58 window
  it("rejects 0DTE contracts in the swing window", () => {
    const result = validatePaperEntry({ signal, contract, account, positions:[], orders:[], tradesToday:0, now:lateDay, settings:swingSettings });
    expect(result.errors).toContain("0DTE contracts expire at today's close and cannot be held overnight; swing entries require 1-2 DTE");
  });
  it("allows a 1DTE swing entry in the window", () => {
    const overnight = { ...contract, dte:1 as const, expirationDate:"2026-08-07" };
    expect(validatePaperEntry({ signal, contract:overnight, account, positions:[], orders:[], tradesToday:0, now:lateDay, settings:swingSettings }).allowed).toBe(true);
  });
  it("still rejects the late-day window when swing mode is off", () => {
    const result = validatePaperEntry({ signal, contract:{ ...contract, dte:1 as const }, account, positions:[], orders:[], tradesToday:0, now:lateDay });
    expect(result.errors).toContain("Current time is outside the configured ET entry window");
  });
});

describe("re-entry cooldown", () => {
  const now = new Date("2026-08-06T15:00:00.000Z");
  const stopExit = { contractTicker:"O:SPY260806C00770000", exitReason:"premium_stop", at:"2026-08-06T14:50:00.000Z" };
  it("blocks a same-direction entry within 20 minutes of a stop", () => {
    expect(entryCooldownActive({ action:"enter_call", recentExits:[stopExit], now })).not.toBeNull();
  });
  it("allows the opposite direction", () => {
    expect(entryCooldownActive({ action:"enter_put", recentExits:[stopExit], now })).toBeNull();
  });
  it("expires after 20 minutes", () => {
    expect(entryCooldownActive({ action:"enter_call", recentExits:[{ ...stopExit, at:"2026-08-06T14:35:00.000Z" }], now })).toBeNull();
  });
  it("ignores winners released by the trailing stop", () => {
    expect(entryCooldownActive({ action:"enter_call", recentExits:[{ ...stopExit, exitReason:"trailing_stop" }], now })).toBeNull();
  });
});

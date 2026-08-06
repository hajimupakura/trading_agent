import type { Contract, Signal } from "@/lib/options/types";
import type { AlpacaAccount, AlpacaOrder, AlpacaPosition } from "./paper";
import type { RiskSettings } from "@/lib/settings/config";
import { DEFAULT_RISK_SETTINGS } from "@/lib/settings/config";

export const PAPER_RULES = {
  maxPremium: 8, maxDebitPct: .01, dailyLossPct: .01, maxTradesPerDay: 3, maxOpenPositions: 1,
  entryStartMinutes:9 * 60 + 45, entryEndMinutes:14 * 60 + 45,
  stopLossPct: .30, // must match EXIT_RULES.stopLossPct in apps/position-worker/src/exit-engine.ts
} as const;

// Fixed-fractional sizing: risk (debit x stop distance) targets riskPerTradePct of equity,
// bounded by the per-trade debit cap, the 1%-of-equity debit cap, buying power, and the contract cap.
export function computePositionSize(input:{ask:number;equity:number;optionsBuyingPower:number;settings:RiskSettings}) {
  const { ask, equity, optionsBuyingPower, settings } = input;
  const perContractDebit = ask * 100;
  if (!(perContractDebit > 0) || !Number.isFinite(equity) || equity <= 0) return 1;
  const riskBudget = equity * settings.riskPerTradePct;
  const perContractRisk = perContractDebit * PAPER_RULES.stopLossPct;
  const byRisk = Math.floor(riskBudget / perContractRisk);
  const byTradeDebit = Math.floor(settings.maxTradeDebit / perContractDebit);
  const byEquityDebit = Math.floor(equity * PAPER_RULES.maxDebitPct / perContractDebit);
  const byBuyingPower = Number.isFinite(optionsBuyingPower) ? Math.floor(optionsBuyingPower / perContractDebit) : 0;
  return Math.max(1, Math.min(byRisk, byTradeDebit, byEquityDebit, byBuyingPower, settings.maxContractsPerTrade));
}

function easternMinutes(now: Date) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone:"America/New_York", hour:"2-digit", minute:"2-digit", hourCycle:"h23", weekday:"short" }).formatToParts(now);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { minutes:Number(value.hour) * 60 + Number(value.minute), weekday:value.weekday };
}

export function validatePaperEntry(input: { signal:Signal; contract:Contract; account:AlpacaAccount; positions:AlpacaPosition[]; orders:AlpacaOrder[]; tradesToday:number; settings?:RiskSettings; quantity?:number; now?:Date }) {
  const errors:string[] = [];
  const { signal, contract, account, positions, orders, tradesToday } = input;
  const settings=input.settings??DEFAULT_RISK_SETTINGS;
  const quantity = Math.max(1, Math.floor(input.quantity ?? 1));
  const clock = easternMinutes(input.now ?? new Date());
  const equity = Number(account.equity);
  const lastEquity = Number(account.last_equity);
  const optionsBuyingPower = Number(account.options_buying_power);
  const debit = contract.ask * 100 * quantity;
  if (!signal.action.startsWith("enter_")) errors.push("The current engine decision is not an entry");
  if(!settings.paperTradingEnabled)errors.push("Paper entries are disabled in risk settings");
  if(!(settings.allowedUnderlyings as readonly string[]).includes(contract.underlying))errors.push(`${contract.underlying} is disabled in risk settings`);
  if (!contract.eligible || !settings.allowedDte.includes(contract.dte as 0|1|2)) errors.push("Contract DTE is disabled or ineligible");
  if (contract.ask <= 0 || contract.ask > settings.maxOptionAsk) errors.push(`Contract ask exceeds the $${settings.maxOptionAsk.toFixed(2)} limit`);
  if(debit>settings.maxTradeDebit)errors.push(`Total debit (${quantity} contract${quantity===1?"":"s"}) exceeds the $${settings.maxTradeDebit.toFixed(0)} per-trade limit`);
  if (!Number.isFinite(equity) || debit > equity * PAPER_RULES.maxDebitPct) errors.push("Total debit exceeds 1% of account equity");
  if (!Number.isFinite(optionsBuyingPower) || debit > optionsBuyingPower) errors.push("Insufficient options buying power");
  if (Number.isFinite(lastEquity) && equity - lastEquity <= -settings.maxDailyLoss) errors.push(`Daily loss limit of $${settings.maxDailyLoss.toFixed(0)} has been reached`);
  if (tradesToday >= settings.maxTradesPerDay) errors.push(`Maximum ${settings.maxTradesPerDay} entries per day reached`);
  if (positions.length >= settings.maxOpenPositions) errors.push(`Maximum ${settings.maxOpenPositions} open option positions reached`);
  if (orders.some(order => ["new","accepted","pending_new","partially_filled"].includes(order.status))) errors.push("An Alpaca order is already open");
  const inDayWindow = clock.minutes >= settings.entryStartMinutes && clock.minutes <= settings.entryEndMinutes;
  const inSwingWindow = settings.swingTradingEnabled && clock.minutes >= settings.swingEntryStartMinutes && clock.minutes <= settings.swingEntryEndMinutes;
  if (["Sat","Sun"].includes(clock.weekday) || (!inDayWindow && !inSwingWindow)) errors.push("Current time is outside the configured ET entry window");
  if (inSwingWindow && !inDayWindow && contract.dte < 1) errors.push("0DTE contracts expire at today's close and cannot be held overnight; swing entries require 1-2 DTE");
  if (account.status !== "ACTIVE") errors.push(`Alpaca paper account is ${account.status}`);
  return { allowed:errors.length === 0, errors, equity, dayPnl:equity - lastEquity, debit, quantity };
}

import type { Contract, Signal } from "@/lib/options/types";
import type { AlpacaAccount, AlpacaOrder, AlpacaPosition } from "./paper";

export const PAPER_RULES = {
  maxPremium: 8, maxDebitPct: .01, dailyLossPct: .01, maxTradesPerDay: 3, maxOpenPositions: 1,
  entryStartMinutes:9 * 60 + 45, entryEndMinutes:14 * 60 + 45,
} as const;

function easternMinutes(now: Date) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone:"America/New_York", hour:"2-digit", minute:"2-digit", hourCycle:"h23", weekday:"short" }).formatToParts(now);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { minutes:Number(value.hour) * 60 + Number(value.minute), weekday:value.weekday };
}

export function validatePaperEntry(input: { signal:Signal; contract:Contract; account:AlpacaAccount; positions:AlpacaPosition[]; orders:AlpacaOrder[]; tradesToday:number; now?:Date }) {
  const errors:string[] = [];
  const { signal, contract, account, positions, orders, tradesToday } = input;
  const clock = easternMinutes(input.now ?? new Date());
  const equity = Number(account.equity);
  const lastEquity = Number(account.last_equity);
  const optionsBuyingPower = Number(account.options_buying_power);
  const debit = contract.ask * 100;
  if (!signal.action.startsWith("enter_")) errors.push("The current engine decision is not an entry");
  if (!contract.eligible || contract.dte < 0 || contract.dte > 2) errors.push("Contract is outside the eligible 0–2 DTE universe");
  if (contract.ask <= 0 || contract.ask > PAPER_RULES.maxPremium) errors.push("Contract ask exceeds the $8.00 limit");
  if (!Number.isFinite(equity) || debit > equity * PAPER_RULES.maxDebitPct) errors.push("Full option debit exceeds 1% of account equity");
  if (!Number.isFinite(optionsBuyingPower) || debit > optionsBuyingPower) errors.push("Insufficient options buying power");
  if (Number.isFinite(lastEquity) && equity - lastEquity <= -(lastEquity * PAPER_RULES.dailyLossPct)) errors.push("Daily loss limit has been reached");
  if (tradesToday >= PAPER_RULES.maxTradesPerDay) errors.push("Maximum three entries per day reached");
  if (positions.length >= PAPER_RULES.maxOpenPositions) errors.push("An option position is already open");
  if (orders.some(order => ["new","accepted","pending_new","partially_filled"].includes(order.status))) errors.push("An Alpaca order is already open");
  if (["Sat","Sun"].includes(clock.weekday) || clock.minutes < PAPER_RULES.entryStartMinutes || clock.minutes > PAPER_RULES.entryEndMinutes) errors.push("Entries are limited to 9:45 a.m.–2:45 p.m. ET");
  if (account.status !== "ACTIVE") errors.push(`Alpaca paper account is ${account.status}`);
  return { allowed:errors.length === 0, errors, equity, dayPnl:equity - lastEquity, debit };
}

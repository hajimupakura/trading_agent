import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAlert } from "@/lib/alerts/server";
import { getPaperTradingState, submitPaperOptionOrder } from "./paper";
import { PAPER_RULES, computePositionSize, entryCooldownActive, validatePaperEntry } from "./risk";
import { loadRiskSettings } from "@/lib/settings/risk-settings";
import { activeEarningsGuard } from "@/lib/options/earnings-guard";
import type { CommandCenter } from "@/lib/options/types";

// Fully autonomous PAPER entries — SPY plus every watchlist ticker (SPX excluded:
// Alpaca has no index options). Runs from the every-minute cron right after each
// refresh: if a fresh engine signal exists and EVERY deterministic gate passes
// (window, cooldown, sizing, daily loss, trades/day, one position, economic guard,
// kill switch — all GLOBAL across tickers), the order submits itself. Purpose:
// measure the strategies cleanly — a paper record built without waiting on a human
// is the evidence the promotion ladder needs.
// Off by default (settings.autoEntriesEnabled). Every entry telegrams instantly.

async function entriesToday(userId: string) {
  const now = new Date();
  const dateParts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now).map(part => [part.type, part.value]));
  const midnightGuess = Date.UTC(Number(dateParts.year), Number(dateParts.month) - 1, Number(dateParts.day));
  const localAtGuess = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(midnightGuess)).map(part => [part.type, part.value]));
  const representedAsUtc = Date.UTC(Number(localAtGuess.year), Number(localAtGuess.month) - 1, Number(localAtGuess.day), Number(localAtGuess.hour), Number(localAtGuess.minute), Number(localAtGuess.second));
  const since = new Date(midnightGuess - (representedAsUtc - midnightGuess)).toISOString();
  const { count, error } = await createAdminClient().from("paper_trade_orders").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("action", "buy_to_open").gte("created_at", since).neq("status", "rejected");
  if (error) throw new Error(`Trade journal unavailable: ${error.message}`);
  return count ?? 0;
}

export async function runAutoEntry(snapshot: CommandCenter | null, underlying: string): Promise<{ entered: string | null; skipped?: string }> {
  if (underlying === "SPX") return { entered: null };
  const signal = snapshot?.signal;
  const contract = signal?.contract;
  if (!signal || !contract || !["enter_call", "enter_put"].includes(signal.action)) return { entered: null };
  // Freshness: act only on signals generated within the last two minutes.
  if (Date.now() - signal.generatedAt > 120_000) return { entered: null, skipped: "stale signal" };
  const admin = createAdminClient();
  const { data: owner } = await admin.from("profiles").select("id").limit(1).maybeSingle();
  if (!owner) return { entered: null };
  const settings = await loadRiskSettings(owner.id);
  if (!settings.autoEntriesEnabled || !settings.paperTradingEnabled) return { entered: null, skipped: "autonomy off" };
  if (signal.setup === "scalp_reclaim" && !settings.scalpEntriesEnabled) return { entered: null, skipped: "scalp lane off" };
  // One order per signal, ever.
  const { data: existing } = await admin.from("paper_trade_orders").select("id").eq("signal_id", signal.id).limit(1).maybeSingle();
  if (existing) return { entered: null, skipped: "signal already traded" };
  const { data: control } = await admin.from("position_manager_control").select("kill_switch").eq("id", true).single();
  if (control?.kill_switch) return { entered: null, skipped: "kill switch" };
  const [trading, tradesToday, { data: recentExits, error: recentExitsError }] = await Promise.all([
    getPaperTradingState(), entriesToday(owner.id),
    admin.from("paper_trade_orders").select("contract_ticker,risk_snapshot,updated_at").eq("user_id", owner.id).eq("action", "sell_to_close").gte("updated_at", new Date(Date.now() - PAPER_RULES.cooldownMinutes * 60_000).toISOString()),
  ]);
  // FAIL CLOSED (2026-08-18 doctrine): an unanswerable cooldown question means NO —
  // a transient query error must never read as "no recent exits, clear to enter".
  if (recentExitsError) return { entered: null, skipped: `cooldown data unavailable: ${recentExitsError.message}` };
  const cooldown = entryCooldownActive({ action: signal.action, recentExits: (recentExits ?? []).map(row => ({ contractTicker: String(row.contract_ticker), exitReason: (row.risk_snapshot as { exitReason?: string } | null)?.exitReason ?? null, at: String(row.updated_at) })) });
  if (cooldown) return { entered: null, skipped: "cooldown" };
  const etMin = (() => { const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()); return Number(parts.find(part => part.type === "hour")?.value) * 60 + Number(parts.find(part => part.type === "minute")?.value); })();
  // MORNING-ONLY ENTRIES (2026-08-27): two weeks of round trips split cleanly by
  // entry time — 9:30-9:59 made +$2,212 (52% wins) while 10:00-10:59 lost -$4,532
  // (26% wins): after 10:00 the system chases moves that already happened. Opening
  // drives keep their measured 10:14 handoff window; everything else stops at 10:00.
  const entryWindowEnd = signal.setup === "opening_drive" ? 615 : 600;
  if (etMin >= entryWindowEnd) return { entered: null, skipped: `outside morning entry window (${signal.setup} entries close at ${entryWindowEnd === 615 ? "10:15" : "10:00"} ET)` };
  const earningsBlock = await activeEarningsGuard(underlying, { swingEntry: etMin >= 930 });
  if (earningsBlock) return { entered: null, skipped: earningsBlock };
  // Never re-enter a contract already held: with maxOpenPositions > 1 the global cap
  // permits a second position, but doubling the SAME contract is unintended averaging.
  if (trading.positions.some(position => `O:${position.symbol}` === contract.ticker)) return { entered: null, skipped: "already holding this contract" };
  // NOTE: event-day caution applies to the REAL-MONEY lane only — paper deliberately
  // trades unfiltered (its record measures the raw strategy, event days included).
  const quantity = computePositionSize({ ask: contract.ask, equity: Number(trading.account.equity), optionsBuyingPower: Number(trading.account.options_buying_power), settings });
  const risk = validatePaperEntry({ signal, contract, ...trading, tradesToday, settings, quantity });
  if (!risk.allowed) return { entered: null, skipped: risk.errors[0] ?? "risk gate" };
  const clientOrderId = `velocity-auto-${signal.id}`.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48);
  const entryLimit = Math.max(0.01, Number(contract.midpoint.toFixed(2)));
  const order = await submitPaperOptionOrder({ symbol: contract.ticker, limitPrice: entryLimit, clientOrderId, quantity: risk.quantity });
  await createAlert({
    userId: owner.id, signalId: signal.id, eventKey: `paper-entry-${order.id}`, severity: "success",
    title: `AUTONOMOUS entry: bought ${risk.quantity} ${signal.action === "enter_call" ? "call" : "put"}${risk.quantity === 1 ? "" : "s"} on ${underlying}`,
    body: `The engine fired a ${signal.setup.replaceAll("_", " ")} signal (confidence ${signal.confidence}) and entered on its own: BUY ${risk.quantity} × ${contract.ticker} at a $${entryLimit.toFixed(2)} limit — about $${risk.debit.toFixed(0)} at risk, sized to the account. The worker guards the exit from here (stop, trail, time rules). Emergency stop in the dashboard halts future entries anytime.`,
    metadata: { kind: "auto_entry", orderId: order.id, contractTicker: contract.ticker, limitPrice: entryLimit, quantity: risk.quantity, maxDebit: risk.debit },
  }).catch(error => console.error("auto entry alert failed", error));
  const { error: journalError } = await admin.from("paper_trade_orders").insert({
    user_id: owner.id, signal_id: signal.id, alpaca_order_id: order.id, client_order_id: order.client_order_id,
    action: "buy_to_open", underlying, contract_ticker: contract.ticker,
    quantity: risk.quantity, order_type: "limit", limit_price: entryLimit, max_debit: risk.debit, status: order.status,
    risk_snapshot: { autonomous: true, strategy: signal.setup, equity: risk.equity, dayPnl: risk.dayPnl, rules: settings, systemCaps: PAPER_RULES }, broker_response: order,
  });
  if (journalError) console.error("auto entry journal failed", journalError);
  return { entered: contract.ticker };
}

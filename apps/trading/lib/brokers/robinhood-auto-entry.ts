import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAlert } from "@/lib/alerts/server";
import { loadRiskSettings } from "@/lib/settings/risk-settings";
import { activeEconomicGuard } from "@/lib/options/economic-calendar";
import { getRobinhoodAccounts, resolveOptionInstrument, reviewAndPlaceOptionOrder } from "./robinhood-trading";
import type { CommandCenter } from "@/lib/options/types";

// Fully autonomous REAL-MONEY entries on the Robinhood agentic account — SPY + SPX.\n// SPY preferred at small caps (strong strikes fit $250; tighter spreads); SPX resumes\n// primacy when caps afford its real strikes.
// Mirrors the Alpaca paper auto-entry gate chain, but with its own (tighter) caps
// because these are real dollars: rhAutoEntriesEnabled is OFF by default and every
// gate is deterministic. Exits need no wiring here — the Railway worker discovers
// any agentic position within one cycle and manages stop/trail/time rules.
//
// Gate chain (ALL must pass): toggle on · fresh signal (<2 min) · signal not already
// traded · kill switch off · economic guard clear · inside the entry window · zero
// open agentic positions · under trades/day · cooldown after a stop-out · contract
// affordable under the per-trade debit cap.

const etMinutes = () => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  return Number(parts.find(part => part.type === "hour")?.value) * 60 + Number(parts.find(part => part.type === "minute")?.value);
};
const etDayStartIso = () => {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
  return new Date(`${today}T00:00:00-04:00`).toISOString();
};

export async function runRobinhoodAutoEntry(snapshot: CommandCenter | null): Promise<{ entered: string | null; skipped?: string }> {
  const signal = snapshot?.signal;
  const contract = signal?.contract;
  if (!signal || !contract || !["enter_call", "enter_put"].includes(signal.action)) return { entered: null };
  if (!["SPX", "SPY"].includes(contract.underlying)) return { entered: null, skipped: "not SPX/SPY" };
  // Real-money lane: every decision on a real signal is journaled, and an unexpected
  // throw pages as critical — a silent miss here is itself an incident (2026-08-11:
  // a $180 in-cap signal at 10:25 skipped with no trace; cause unrecoverable).
  const outcome = await runGates(snapshot, signal, contract).catch(async error => {
    const message = error instanceof Error ? error.message : String(error);
    const { data: owner } = await createAdminClient().from("profiles").select("id").limit(1).maybeSingle();
    if (owner) await createAlert({
      userId: String(owner.id), eventKey: `rh-auto-entry-error-${signal.id}`, severity: "critical",
      title: "Real-money entry lane hit an unexpected error",
      body: `A live SPX signal (${contract.ticker}) could not be processed: ${message}. No order was placed. If this repeats, the real-money lane needs attention.`,
      metadata: { kind: "rh_auto_entry_error", signalId: signal.id, error: message },
    }).catch(() => undefined);
    return { entered: null, skipped: `error: ${message}` };
  });
  await createAdminClient().from("rh_entry_decisions").insert({ signal_id: signal.id, outcome: outcome.entered ? "entered" : "skipped", detail: outcome.entered ?? outcome.skipped ?? null }).then(({ error }) => { if (error) console.error("rh decision journal failed", error.message); });
  return outcome;
}

async function runGates(snapshot: CommandCenter, signal: NonNullable<CommandCenter["signal"]>, contract: NonNullable<NonNullable<CommandCenter["signal"]>["contract"]>): Promise<{ entered: string | null; skipped?: string }> {
  if (Date.now() - signal.generatedAt > 120_000) return { entered: null, skipped: "stale signal" };
  const admin = createAdminClient();
  const { data: connection } = await admin.from("broker_connections").select("user_id").eq("broker", "robinhood").eq("status", "connected").limit(1).maybeSingle();
  if (!connection?.user_id) return { entered: null, skipped: "robinhood not connected" };
  const userId = String(connection.user_id);
  const settings = await loadRiskSettings(userId);
  if (!settings.rhAutoEntriesEnabled) return { entered: null, skipped: "rh autonomy off" };
  if (signal.setup === "scalp_reclaim" && !settings.scalpEntriesEnabled) return { entered: null, skipped: "scalp lane off" };
  // One order per signal, ever — and the same signal must not be double-traded here
  // even if Alpaca also acted on it (separate journals, separate venues).
  const { data: existing } = await admin.from("rh_entry_orders").select("id").eq("signal_id", signal.id).limit(1).maybeSingle();
  if (existing) return { entered: null, skipped: "signal already traded" };
  const { data: control } = await admin.from("position_manager_control").select("kill_switch").eq("id", true).single();
  if (control?.kill_switch) return { entered: null, skipped: "kill switch" };
  if (settings.economicGuardEnabled && activeEconomicGuard()) return { entered: null, skipped: "economic guard" };
  const minutes = etMinutes();
  if (minutes < settings.entryStartMinutes || minutes > settings.entryEndMinutes) return { entered: null, skipped: "outside entry window" };
  if (!settings.allowedDte.includes(contract.dte as 0 | 1 | 2)) return { entered: null, skipped: `dte ${contract.dte} not allowed` };
  // Zero open agentic positions: the worker keeps rh_position_monitors current within
  // seconds in-session, so an active row means money is already on the table.
  const { count: openCount } = await admin.from("rh_position_monitors").select("id", { count: "exact", head: true }).in("status", ["monitoring", "closing", "error"]);
  if ((openCount ?? 0) > 0) return { entered: null, skipped: "position already open" };
  const { count: todayCount } = await admin.from("rh_entry_orders").select("id", { count: "exact", head: true }).gte("created_at", etDayStartIso()).neq("status", "rejected");
  if ((todayCount ?? 0) >= settings.rhMaxTradesPerDay) return { entered: null, skipped: "daily trade cap" };
  // Cooldown: no re-entry within 30 minutes of any monitor closing (stop-out or otherwise).
  const { data: recentClose } = await admin.from("rh_position_monitors").select("id").eq("status", "closed").gte("updated_at", new Date(Date.now() - 30 * 60_000).toISOString()).limit(1).maybeSingle();
  if (recentClose) return { entered: null, skipped: "cooldown after exit" };
  // Sizing: whole contracts under the per-trade debit cap, priced at the ask so the
  // limit is marketable. If the SIGNAL's contract (delta-targeted ~0.45, often $500+
  // on SPX) exceeds the cap, shop the same expiry for the strongest contract that
  // FITS — highest |delta| with ask*100 <= cap — instead of standing down. On a $250
  // cap this trades the $1.50-2.50 wings, which is exactly the affordable-SPX style;
  // the exit engine's rules are identical either way.
  let chosen = contract;
  if (!(chosen.ask > 0) || chosen.ask * 100 > settings.rhMaxTradeDebit) {
    const affordable = (snapshot.contracts ?? [])
      .filter(candidate => candidate.eligible && candidate.side === contract.side && candidate.expirationDate === contract.expirationDate
        && candidate.ask > 0 && candidate.ask * 100 <= settings.rhMaxTradeDebit && candidate.delta != null)
      .sort((a, b) => Math.abs(b.delta!) - Math.abs(a.delta!))[0];
    if (!affordable) return { entered: null, skipped: `no eligible contract fits the $${settings.rhMaxTradeDebit} cap` };
    chosen = affordable;
  }
  const limitPrice = Number(chosen.ask.toFixed(2));
  const quantity = Math.min(Math.floor(settings.rhMaxTradeDebit / (limitPrice * 100)), settings.maxContractsPerTrade);
  if (quantity < 1) return { entered: null, skipped: `contract too expensive ($${(limitPrice * 100).toFixed(0)} > $${settings.rhMaxTradeDebit} cap)` };
  const debit = quantity * limitPrice * 100;
  const accounts = await getRobinhoodAccounts(userId);
  const agentic = accounts.find((account: any) =>
    [account?.agentic_allowed, account?.is_agentic].some(flag => flag === true || flag === "true" || flag === 1)
    || String(account?.account_type ?? account?.type ?? "").toLowerCase().includes("agentic"));
  if (!agentic?.account_number) return { entered: null, skipped: "no agentic account" };
  const chainSymbol = /^O:([A-Z]+?)\d{6}[CP]/.exec(chosen.ticker)?.[1] ?? "SPXW";
  const instrument = await resolveOptionInstrument(userId, { chainSymbol, expirationDate: chosen.expirationDate, strike: chosen.strike, type: chosen.side });
  const refId = crypto.randomUUID();
  // Journal FIRST (unique signal_id is the concurrency lock), then place. A placement
  // failure marks the row rejected so the signal can never fire a second live order.
  const { error: journalError } = await admin.from("rh_entry_orders").insert({
    user_id: userId, signal_id: signal.id, ref_id: refId, underlying: contract.underlying, contract_ticker: chosen.ticker,
    quantity, limit_price: limitPrice, max_debit: debit, status: "submitted",
    strategy: signal.setup === "scalp_reclaim" ? "scalp" : "orb",
  });
  if (journalError) return { entered: null, skipped: `journal: ${journalError.message}` };
  try {
    const { order } = await reviewAndPlaceOptionOrder(userId, {
      accountNumber: String(agentic.account_number), optionId: instrument.id, side: "buy", positionEffect: "open",
      quantity, limitPrice, chainSymbol, underlyingType: chainSymbol === "SPXW" ? "index" as const : "equity" as const, refId,
    });
    await admin.from("rh_entry_orders").update({ broker_response: order ?? null }).eq("ref_id", refId);
    await createAlert({
      userId, signalId: signal.id, eventKey: `rh-auto-entry-${refId}`, severity: "success",
      title: `AUTONOMOUS Robinhood entry: bought ${quantity} ${contract.underlying} ${chosen.side}${quantity === 1 ? "" : "s"} (real money)`,
      body: `The engine fired a ${signal.setup.replaceAll("_", " ")} signal (confidence ${signal.confidence}) and entered on the agentic account: BUY ${quantity} × ${chainSymbol} ${chosen.expirationDate} ${chosen.strike}${chosen.side === "call" ? "C" : "P"} at a $${limitPrice.toFixed(2)} limit — about $${debit.toFixed(0)} of real money at risk. The worker guards the exit (30% stop, profit trail, 3:10 PM hard exit). Emergency stop in the dashboard halts future entries; the Robinhood autonomy toggle is in Settings.`,
      metadata: { kind: "rh_auto_entry", refId, contractTicker: chosen.ticker, limitPrice, quantity, maxDebit: debit },
    }).catch(error => console.error("rh auto entry alert failed", error));
    return { entered: contract.ticker };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await admin.from("rh_entry_orders").update({ status: "rejected", broker_response: { error: message } }).eq("ref_id", refId);
    await createAlert({
      userId, eventKey: `rh-auto-entry-fail-${refId}`, severity: "critical",
      title: "Autonomous Robinhood entry FAILED at the broker",
      body: `The engine tried to buy ${quantity} × ${chainSymbol} ${chosen.expirationDate} ${chosen.strike}${chosen.side === "call" ? "C" : "P"} but Robinhood rejected it: ${message}. No money moved. The signal is marked used and will not retry.`,
      metadata: { kind: "rh_auto_entry_failed", refId, error: message },
    }).catch(alertError => console.error("rh auto entry failure alert failed", alertError));
    return { entered: null, skipped: `broker: ${message}` };
  }
}

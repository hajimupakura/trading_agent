import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAlert } from "@/lib/alerts/server";
import { loadRiskSettings } from "@/lib/settings/risk-settings";
import { activeEconomicGuard, todaysEconomicEvent } from "@/lib/options/economic-calendar";
import { activeEarningsGuard } from "@/lib/options/earnings-guard";
import { getRobinhoodAccounts, resolveOptionInstrument, reviewAndPlaceOptionOrder } from "./robinhood-trading";
import type { CommandCenter } from "@/lib/options/types";

// Fully autonomous REAL-MONEY entries on the Robinhood agentic account — SPY/SPX/QQQ/NVDA/TSLA/GOOGL/SPCX.
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
  // INDEX-ONLY (user call, 2026-08-17 after the -$247 morning): real money trades
  // SPY/SPX/QQQ only — deep liquidity, tight spreads, replay-validated setups, no
  // single-name gap mania. Single names live on paper until their record earns a
  // promotion the user approves.
  if (!["SPX", "SPY", "QQQ"].includes(contract.underlying)) return { entered: null, skipped: "not in RH universe (index-only)" };
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
  // Event-day caution (prior-based; see paper lane note): delayed start + half cap.
  // Guarded events only (CPI/NFP/FOMC) — brief-only releases like PPI don't restrict.
  const econToday = todaysEconomicEvent();
  const cautionEvent = econToday?.guarded ? econToday : null;
  if (cautionEvent && cautionEvent.releaseLabel.startsWith("8:30") && etMinutes() < 630) return { entered: null, skipped: `event-day caution: entries begin 10:30 on ${cautionEvent.name} days` };
  // SPX carries its own (higher) per-trade cap: same-day SPX contracts at the open run
  // $400-800, so a shared $300 cap silently excluded the user's preferred underlying.
  const baseCap = contract.underlying === "SPX" ? settings.rhMaxTradeDebitSpx : settings.rhMaxTradeDebit;
  const effectiveCap = cautionEvent ? baseCap / 2 : baseCap;
  const earningsBlock = await activeEarningsGuard(contract.underlying);
  if (earningsBlock) return { entered: null, skipped: earningsBlock };
  const minutes = etMinutes();
  if (minutes < settings.entryStartMinutes || minutes > settings.entryEndMinutes) return { entered: null, skipped: "outside entry window" };
  const singleNameDteOk = !["SPY", "SPX"].includes(contract.underlying) && contract.dte <= 14; // 14: some Mondays only a ~11-DTE series exists (SPCX/SNDK 8/17)
  if (!settings.allowedDte.includes(contract.dte as 0 | 1 | 2) && !singleNameDteOk) return { entered: null, skipped: `dte ${contract.dte} not allowed` };
  // Concurrency: max 3 open positions, in CORRELATION GROUPS — SPY and SPX are the
  // same market (never both open); QQQ/NVDA/TSLA/GOOGL/SPCX each their own slot.
  // The worker keeps rh_position_monitors current within seconds in-session.
  const { data: openRows } = await admin.from("rh_position_monitors").select("occ_ticker,option_type").in("status", ["monitoring", "closing", "error"]);
  const open = (openRows ?? []).map(row => String(row.occ_ticker));
  if (open.length >= 3) return { entered: null, skipped: "three positions already open" };
  // Groups: SPY/SPX are one market; each other underlying is its own slot. Max 2 open.
  const groupOf = (occ: string) => /^O:(SPXW|SPY)\d/.test(occ) ? "sp" : (/^O:([A-Z]+?)\d{6}[CP]/.exec(occ)?.[1] ?? "other");
  const entryGroup = ["SPX", "SPY"].includes(contract.underlying) ? "sp" : contract.underlying;
  if (open.some(occ => groupOf(occ) === entryGroup)) return { entered: null, skipped: `a ${entryGroup === "sp" ? "SPY/SPX" : entryGroup} position is already open` };
  if (open.includes(contract.ticker)) return { entered: null, skipped: "same contract already open" };
  // SAME-UNDERLYING gates read the ENTRY JOURNAL, not the monitors — monitors lag fills
  // by worker-sighting latency, which let two MU entries through 3 minutes apart on
  // 2026-08-17 (the group gate saw no open MU yet; both stopped out, −$173). The journal
  // row exists before placement, so this cannot race: 45-minute per-underlying re-entry
  // cooldown, and a name that already took 2 entries today is DONE for the day.
  const { data: sameNameToday } = await admin.from("rh_entry_orders").select("id,created_at")
    .eq("underlying", contract.underlying).neq("status", "rejected").gte("created_at", etDayStartIso());
  if ((sameNameToday ?? []).length >= 2) return { entered: null, skipped: `${contract.underlying} already traded twice today — done with this name` };
  if ((sameNameToday ?? []).some(row => Date.now() - Date.parse(String(row.created_at)) < 45 * 60_000)) return { entered: null, skipped: `${contract.underlying} re-entry cooldown (45 min)` };
  // SAME-DIRECTION cap (2026-08-14): correlation groups treat QQQ/NVDA/GOOGL as
  // independent slots, but on an index move they are ONE bet — the 8/14 morning bought
  // three tech puts in 28 minutes and one fake breakdown stopped all three. At most 2
  // open positions in the same direction; the third needs the other side of the tape.
  const sameDirection = (openRows ?? []).filter(row => String(row.option_type) === contract.side).length;
  if (sameDirection >= 2) return { entered: null, skipped: `already holding ${sameDirection} ${contract.side} positions — same-direction cap` };
  // Daily-loss circuit breaker: equity (mark-to-market, unrealized included) down more
  // than the cap from the morning baseline halts NEW entries for the day. Exits and
  // stops keep running — this stops the digging, not the climbing out.
  const tradeDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
  const [{ data: baseline }, { data: portfolioRow }] = await Promise.all([
    admin.from("rh_daily_baseline").select("equity").eq("trade_date", tradeDate).maybeSingle(),
    admin.from("broker_portfolio_snapshots").select("payload").eq("broker", "robinhood").maybeSingle(),
  ]);
  const equityNow = Number((portfolioRow?.payload as { totalValue?: number } | null)?.totalValue ?? NaN);
  if (baseline && Number.isFinite(equityNow) && Number(baseline.equity) - equityNow >= settings.rhMaxDailyLoss) {
    return { entered: null, skipped: `daily loss breaker: down $${(Number(baseline.equity) - equityNow).toFixed(0)} of $${settings.rhMaxDailyLoss} allowed — no new entries today` };
  }
  const { count: todayCount } = await admin.from("rh_entry_orders").select("id", { count: "exact", head: true }).gte("created_at", etDayStartIso()).neq("status", "rejected");
  if ((todayCount ?? 0) >= settings.rhMaxTradesPerDay) return { entered: null, skipped: "daily trade cap" };
  // NO PDT GUARD — deliberately. The SEC eliminated the pattern-day-trader rule
  // effective 2026-06-04; there is no day-trade count to protect. A leftover guard
  // here silently blocked real entries on 2026-08-13 (user standing order: never
  // add PDT limits). Daily caps + the loss breaker above are the real risk bounds.
  // Cooldown: no re-entry within 30 minutes of any monitor closing (stop-out or otherwise).
  const { data: recentClose } = await admin.from("rh_position_monitors").select("id").eq("status", "closed").gte("updated_at", new Date(Date.now() - 30 * 60_000).toISOString()).limit(1).maybeSingle();
  if (recentClose) return { entered: null, skipped: "cooldown after exit" };
  // Sizing: fill the debit cap with the best AGGREGATE exposure. For every eligible
  // same-expiry contract (the strict volume/spread/liquidity screen is the
  // "fundamentals" gate), compute how many fit under the cap and score by
  // quantity x |delta| — 5 cheap contracts summing to $250 beat 1 mid strike when
  // their combined exposure is larger. Ties go to the higher per-contract delta
  // (fewer, stronger contracts bleed less to spreads and time decay).
  // QUALITY FIRST (2026-08-14 audit): the old score (quantity × delta) maximized
  // aggregate exposure, which systematically swapped the signal's ~0.45Δ pick for
  // strips of cheap far-OTM contracts — the 8/14 morning bought 8× 0.18Δ NVDA puts
  // and 7× ~0.2Δ QQQ puts and stopped out fast on ordinary wiggles. Win probability
  // lives near the money: when ANY contract >= 0.35|Δ| fits the cap, take the one
  // nearest the validated 0.45Δ target (liquidity breaking ties) and size within the
  // cap. Quantity-maximized strips only when no quality strike is affordable.
  const affordable = [contract, ...(snapshot.contracts ?? [])]
    .filter(candidate => candidate.eligible && candidate.side === contract.side && candidate.expirationDate === contract.expirationDate
      && candidate.ask > 0 && candidate.ask * 100 <= effectiveCap && candidate.delta != null);
  const qualityPick = affordable.filter(candidate => Math.abs(candidate.delta!) >= 0.35)
    .sort((a, b) => Math.abs(Math.abs(a.delta!) - 0.45) - Math.abs(Math.abs(b.delta!) - 0.45) || b.liquidityScore - a.liquidityScore)[0];
  let basket = qualityPick
    ? { candidate: qualityPick, fit: Math.min(Math.floor(effectiveCap / (qualityPick.ask * 100)), settings.maxContractsPerTrade), score: Math.abs(qualityPick.delta!) }
    : affordable
      .map(candidate => {
        const fit = Math.min(Math.floor(effectiveCap / (candidate.ask * 100)), settings.maxContractsPerTrade);
        return { candidate, fit, score: fit * Math.abs(candidate.delta!) };
      })
      .filter(entry => entry.fit >= 1)
      .sort((a, b) => b.score - a.score || Math.abs(b.candidate.delta!) - Math.abs(a.candidate.delta!))[0];
  if (basket && basket.fit < 1) basket = undefined as unknown as typeof basket;
  // CONVEXITY FALLBACK (2026-08-13, user directive after SNDK's +$220 day): on
  // high-priced names every 0.25-0.70 delta contract can exceed the cap — but on the
  // trend days that fire these signals, the cheap 0.10-0.25 delta strike is exactly
  // the piece that pays (an under-$2 SNDK call printed >10x). When nothing in the
  // band fits, take the best contract that failed ONLY the delta screen and fits the
  // cap: same spread/volume/freshness quality bar, deliberately lottery-shaped.
  // REAL-MONEY LOTTERY FALLBACK DISABLED (2026-08-17): it bought 13 far-OTM MU
  // contracts near a spike top and stopped out -$173 within the hour — directly
  // against the standing directive ("small consistent gains", "quality positions").
  // When no quality strike fits the cap, real money SKIPS (journaled) and paper
  // carries the thesis at proper size. Flip to true to re-enable deliberately.
  const REAL_LOTTERY_FALLBACK = false;
  let lottery = false;
  if (!basket && REAL_LOTTERY_FALLBACK) {
    basket = [contract, ...(snapshot.contracts ?? [])]
      .filter(candidate => !candidate.eligible && candidate.rejectionReasons.every(reason => reason.startsWith("Absolute delta outside"))
        && candidate.side === contract.side && candidate.expirationDate === contract.expirationDate
        && candidate.ask > 0 && candidate.ask * 100 <= effectiveCap
        && candidate.delta != null && Math.abs(candidate.delta) >= 0.10 && Math.abs(candidate.delta) < 0.25)
      .map(candidate => {
        const fit = Math.min(Math.floor(effectiveCap / (candidate.ask * 100)), settings.maxContractsPerTrade);
        return { candidate, fit, score: fit * Math.abs(candidate.delta!) };
      })
      .filter(entry => entry.fit >= 1)
      .sort((a, b) => b.score - a.score || Math.abs(b.candidate.delta!) - Math.abs(a.candidate.delta!))[0];
    lottery = basket != null;
  }
  if (!basket) return { entered: null, skipped: `no eligible contract fits the $${effectiveCap} cap` };
  let chosen = basket.candidate;

  const accounts = await getRobinhoodAccounts(userId);
  const agentic = accounts.find((account: any) =>
    [account?.agentic_allowed, account?.is_agentic].some(flag => flag === true || flag === "true" || flag === 1)
    || String(account?.account_type ?? account?.type ?? "").toLowerCase().includes("agentic"));
  if (!agentic?.account_number) return { entered: null, skipped: "no agentic account" };
  let chainSymbol = /^O:([A-Z]+?)\d{6}[CP]/.exec(chosen.ticker)?.[1] ?? "SPXW";
  let instrument;
  try {
    instrument = await resolveOptionInstrument(userId, { chainSymbol, expirationDate: chosen.expirationDate, strike: chosen.strike, type: chosen.side });
  } catch (resolveError) {
    // Robinhood commonly refuses same-day contracts (expiration-date trading is an
    // account permission; even enabled it closes at 15:30 ET). Fall back to the best
    // cap-filling basket on the NEXT expiry instead of abandoning the signal.
    if (chosen.dte !== 0) throw resolveError;
    const fallback = [contract, ...(snapshot.contracts ?? [])]
      .filter(candidate => candidate.eligible && candidate.side === contract.side && candidate.expirationDate !== chosen.expirationDate
        && candidate.dte <= 14 && candidate.ask > 0 && candidate.ask * 100 <= effectiveCap && candidate.delta != null)
      .map(candidate => ({ candidate, fit: Math.min(Math.floor(effectiveCap / (candidate.ask * 100)), settings.maxContractsPerTrade) }))
      .filter(entry => entry.fit >= 1)
      .sort((a, b) => b.fit * Math.abs(b.candidate.delta!) - a.fit * Math.abs(a.candidate.delta!))[0];
    if (!fallback) return { entered: null, skipped: `0DTE refused by Robinhood and no next-expiry contract fits the cap` };
    chosen = fallback.candidate;
    chainSymbol = /^O:([A-Z]+?)\d{6}[CP]/.exec(chosen.ticker)?.[1] ?? chainSymbol;
    instrument = await resolveOptionInstrument(userId, { chainSymbol, expirationDate: chosen.expirationDate, strike: chosen.strike, type: chosen.side });
  }
  // Entry limit: midpoint + 1/3 of the half-spread, NOT the full ask. Paying the ask
  // cost real trades a consistent 4-17 points vs identical paper signals (2026-08-12
  // audit: SPY 771P paper -18% vs real -35% on the same signal) — a ~10-15% round-trip
  // toll on sub-$1 0DTEs. Still marketable enough to fill anything moving; the worker's
  // 10-minute stale-entry leash cancels what doesn't fill.
  const limitPrice = Math.max(0.01, Number((chosen.midpoint + (chosen.ask - chosen.midpoint) / 3).toFixed(2)));
  const quantity = Math.min(Math.floor(effectiveCap / (limitPrice * 100)), settings.maxContractsPerTrade);
  if (quantity < 1) return { entered: null, skipped: "chosen contract no longer fits the cap" };
  const debit = quantity * limitPrice * 100;
  const refId = crypto.randomUUID();
  // Journal FIRST (unique signal_id is the concurrency lock), then place. A placement
  // failure marks the row rejected so the signal can never fire a second live order.
  const { error: journalError } = await admin.from("rh_entry_orders").insert({
    user_id: userId, signal_id: signal.id, ref_id: refId, underlying: contract.underlying, contract_ticker: chosen.ticker,
    quantity, limit_price: limitPrice, max_debit: debit, status: "submitted",
    strategy: signal.setup === "scalp_reclaim" ? "scalp" : signal.setup === "opening_drive" ? "drive" : "orb",
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
      body: `The engine fired a ${signal.setup.replaceAll("_", " ")} signal (confidence ${signal.confidence}) and entered on the agentic account: BUY ${quantity} × ${chainSymbol} ${chosen.expirationDate} ${chosen.strike}${chosen.side === "call" ? "C" : "P"} at a $${limitPrice.toFixed(2)} limit — about $${debit.toFixed(0)} of real money at risk.${lottery ? ` CONVEXITY PICK: every standard-delta contract exceeded the cap on this high-priced name, so this is a deliberate ${Math.abs(chosen.delta ?? 0).toFixed(2)}-delta lottery strike — it can expire worthless fast, and on a real trend day it can pay many times over.` : ""} The worker guards the exit (30% stop, profit trail, 3:10 PM hard exit). Emergency stop in the dashboard halts future entries; the Robinhood autonomy toggle is in Settings.`,
      metadata: { kind: "rh_auto_entry", refId, contractTicker: chosen.ticker, limitPrice, quantity, maxDebit: debit, lottery },
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

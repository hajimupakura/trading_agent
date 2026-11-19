import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAlert } from "@/lib/alerts/server";
import { getPaperTradingState, submitPaperOptionOrder } from "./paper";
import { PAPER_RULES, computePositionSize, entryCooldownActive, validatePaperEntry } from "./risk";
import { loadRiskSettings } from "@/lib/settings/risk-settings";
import { activeEarningsGuard } from "@/lib/options/earnings-guard";
import { recordShadowSkip } from "@/lib/options/shadow-ledger";
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

// Housekeeping skips — the setup is already expressed (holding / duplicate id) or
// the lane deliberately doesn't cover the symbol. EVERY skip of a fresh qualified
// fire is recorded and displayed (user call, 2026-11-19: "I want to see those
// skipped rows"); this list only decides which ones ALSO page Telegram, so a held
// position doesn't ping the phone every hour while the setup keeps re-firing.
const SILENT_SKIPS = ["paper lane is SPX-only", "stale signal", "signal already traded", "already holding this contract", "scalp lane off"];

export async function runAutoEntry(snapshot: CommandCenter | null, underlying: string): Promise<{ entered: string | null; skipped?: string }> {
  const result = await evaluateAutoEntry(snapshot, underlying);
  const signal = snapshot?.signal;
  if (result.skipped && signal?.contract && ["enter_call", "enter_put"].includes(signal.action)
    && Date.now() - signal.generatedAt <= 120_000) {
    try {
      // recordShadowSkip dedupes to one row per action+setup per hour; the Telegram
      // alert rides the same gate so a persisting setup pings once, not every minute.
      const { recorded } = await recordShadowSkip({ signal, underlying, skipReason: result.skipped });
      if (recorded && !SILENT_SKIPS.some(prefix => result.skipped!.startsWith(prefix))) {
        const { data: owner } = await createAdminClient().from("profiles").select("id").limit(1).maybeSingle();
        if (owner) {
          const side = signal.action === "enter_call" ? "CALL" : "PUT";
          await createAlert({
            userId: owner.id, signalId: signal.id, eventKey: `signal-skip-${underlying}-${signal.action}-${signal.generatedAt}`, severity: "warning",
            title: `SIGNAL fired, NOT traded: ${underlying} ${side} (${signal.setup.replaceAll("_", " ")})`,
            body: `The engine qualified ${signal.contract.ticker.replace("O:", "")} asking $${signal.contract.ask.toFixed(2)} with ${underlying} at ${signal.market.price.toFixed(2)}, but the paper lane skipped it: ${result.skipped}. ${signal.reasons[0] ?? ""} The miss is now shadow-tracked — the dashboard's Signal Feed shows what it would have done.`,
            metadata: { kind: "signal_skip", underlying, contractTicker: signal.contract.ticker, ask: signal.contract.ask, skipReason: result.skipped },
          });
        }
      }
    } catch (shadowError) { console.error("shadow skip recording failed", shadowError instanceof Error ? shadowError.message : shadowError); }
  }
  return result;
}

async function evaluateAutoEntry(snapshot: CommandCenter | null, underlying: string): Promise<{ entered: string | null; skipped?: string }> {
  // SPX-ONLY (user call, 2026-11-19): the desk trades one index now. Alpaca added
  // index options this year, so the old "SPX excluded — no index options at Alpaca"
  // rule inverted: SPX is the ONLY underlying the paper lane enters. Each qualifying
  // signal takes a PAIR: the near-the-money quality pick (risk-sized) plus one cheap
  // away-from-the-money contract under $200 — the convex kicker (DKNG lesson).
  if (underlying !== "SPX") return { entered: null, skipped: "paper lane is SPX-only" };
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
  // MORNING-ONLY RULE REMOVED (user call, 2026-11-19): the 2026-08-27 cutoff was
  // measured on 10:00-10:59 CHASES of spent moves; on 11/19 it vetoed a FRESH
  // 11:55 AM opening-range breakdown (SPX 7275P, +~175% unbought). The engine's
  // 0.10-0.65 ATR extension gate is the anti-chase control now — it only qualifies
  // breakouts as they happen, at any hour. The configurable risk-settings window
  // (currently 9:30-14:45 ET in validatePaperEntry) remains the outer bound.
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
  // CONVEX KICKER (user call, 2026-11-19): alongside the quality contract, one cheap
  // away-from-the-money contract under $200 — highest-delta eligible strike at ask
  // <= $2.00, same side and expiry. Its failure never voids the primary entry.
  try {
    // NOT gated on `eligible`: the quality screens (10% spread cap especially) are
    // built for the primary leg and structurally reject every sub-$2 contract — a
    // $0.10 spread on a $0.60 option is 17%. The kicker's screen is a two-sided
    // market with real volume; the ticket price caps the risk.
    const lottery = (snapshot?.contracts ?? [])
      .filter(candidate => candidate.side === contract.side && candidate.expirationDate === contract.expirationDate
        && candidate.ticker !== contract.ticker && candidate.ask > 0 && candidate.ask <= 2 && candidate.bid > 0 && candidate.volume >= 50)
      .sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0))[0];
    if (lottery) {
      const lotteryLimit = Math.max(0.01, Number(lottery.midpoint.toFixed(2)));
      const lotteryOrder = await submitPaperOptionOrder({ symbol: lottery.ticker, limitPrice: lotteryLimit, clientOrderId: `velocity-auto-lot-${signal.id}`.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48), quantity: 1 });
      await admin.from("paper_trade_orders").insert({
        user_id: owner.id, signal_id: signal.id, alpaca_order_id: lotteryOrder.id, client_order_id: lotteryOrder.client_order_id,
        action: "buy_to_open", underlying, contract_ticker: lottery.ticker,
        quantity: 1, order_type: "limit", limit_price: lotteryLimit, max_debit: lotteryLimit * 100, status: lotteryOrder.status,
        risk_snapshot: { autonomous: true, strategy: `${signal.setup}-kicker`, pairedWith: contract.ticker }, broker_response: lotteryOrder,
      }).then(({ error }) => { if (error) console.error("kicker journal failed", error.message); });
      await createAlert({
        userId: owner.id, signalId: signal.id, eventKey: `paper-entry-kicker-${lotteryOrder.id}`, severity: "info",
        title: `Convex kicker: 1 × ${lottery.ticker.replace("O:", "")} at $${lotteryLimit.toFixed(2)}`,
        body: `Paired with the ${contract.ticker.replace("O:", "")} entry — about $${(lotteryLimit * 100).toFixed(0)} at risk, the ticket IS the stop. If the drive runs, this is the convexity.`,
        metadata: { kind: "auto_entry_kicker", contractTicker: lottery.ticker, pairedWith: contract.ticker },
      }).catch(() => undefined);
    }
  } catch (kickerError) { console.error("convex kicker failed", kickerError instanceof Error ? kickerError.message : kickerError); }
  return { entered: contract.ticker };
}

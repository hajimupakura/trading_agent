import { createClient } from "@supabase/supabase-js";
import { config } from "./config.js";
import { evaluateExit, easternClock } from "./exit-engine.js";
import { getSnapshotQuote, MassiveQuoteStream } from "./massive.js";
import { getLatestOptionQuote } from "./alpaca.js";
import type { ManagedPosition, OptionQuote } from "./types.js";

// Robinhood agentic-account exit management (v2: 24/7 discovery, session-gated exits).
// The worker owns rules + timing; all
// broker I/O goes through the app's /api/cron/rh-exec endpoint (Bearer CRON_SECRET),
// because Robinhood tokens are only decryptable at app runtime.

interface RhPosition {
  optionId: string; accountNumber: string; chainSymbol: string; optionType: "call" | "put";
  strike: number; expirationDate: string; occTicker: string; quantity: number; entryPrice: number;
}
interface RhOrder { id: string; state: string; createdAt: string | null; optionIds: string[]; side: string | null; positionEffect: string | null; price: string | null }

const db = createClient(config.supabaseUrl, config.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const OPEN_STATES = ["queued", "confirmed", "unconfirmed", "partially_filled", "pending_cancelled"];
const fresh = (quote: OptionQuote | null, now: number) => quote && now - quote.timestamp <= 15_000 ? quote : null;
const snapshotUnderlying = (chainSymbol: string) => chainSymbol === "SPXW" ? "SPX" : chainSymbol;

async function appExec(path: string, init: RequestInit = {}) {
  if (!config.APP_URL || !config.CRON_SECRET) throw new Error("APP_URL / CRON_SECRET are not configured for Robinhood management");
  const response = await fetch(`${config.APP_URL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${config.CRON_SECRET}`, "Content-Type": "application/json", ...init.headers },
    signal: AbortSignal.timeout(25_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error ?? `rh-exec ${response.status}`);
  return body;
}

async function loadMonitor(occTicker: string) {
  const { data, error } = await db.from("rh_position_monitors").select("*").eq("occ_ticker", occTicker).maybeSingle();
  if (error) throw new Error(`rh monitor load ${occTicker}: ${error.message}`);
  return data;
}

async function saveMonitor(position: RhPosition, patch: Record<string, unknown>) {
  const { error } = await db.from("rh_position_monitors").upsert({
    occ_ticker: position.occTicker, account_number: position.accountNumber, option_id: position.optionId,
    chain_symbol: position.chainSymbol, option_type: position.optionType, strike: position.strike,
    expiration_date: position.expirationDate, quantity: position.quantity, entry_price: position.entryPrice,
    updated_at: new Date().toISOString(), ...patch,
  });
  if (error) throw new Error(`rh monitor save ${position.occTicker}: ${error.message}`);
}

function openedAtFromOrders(position: RhPosition, orders: RhOrder[]) {
  const fills = orders.filter(order => order.state === "filled" && order.side === "buy" && order.positionEffect === "open" && order.optionIds.includes(position.optionId) && order.createdAt);
  const latest = fills.map(order => Date.parse(order.createdAt!)).filter(Number.isFinite).sort((a, b) => b - a)[0];
  return latest ?? null;
}

export class RobinhoodExitManager {
  managedCount = 0;

  async cycle(quotes: MassiveQuoteStream, manageExits: boolean): Promise<{ symbols: string[]; errors: string[] }> {
    this.managedCount = 0;
    const errors: string[] = [];
    if (!config.APP_URL || !config.CRON_SECRET) return { symbols: [], errors: [] };
    const state = await appExec("/api/cron/rh-exec");
    // Surface silent failure modes: a detection error pages via cycle errors; an
    // empty-but-connected book logs its diagnostic for railway-log debugging.
    if (state.error) errors.push(`rh-exec: ${String(state.error)}`);
    if (state.diag) console.log(JSON.stringify({ event: "rh_no_positions", diag: String(state.diag) }));
    const positions = (state.positions ?? []) as RhPosition[];
    const orders = (state.orders ?? []) as RhOrder[];
    // Stale ENTRY leash: a buy-to-open limit still working after 10 minutes is a
    // thesis that already expired — cancel it rather than risk a late fill exactly
    // when the move reverses through the limit (real money; exits have their own
    // escalation and are never touched here).
    for (const order of orders) {
      if (order.side !== "buy" || order.positionEffect !== "open" || !OPEN_STATES.includes(order.state)) continue;
      const age = order.createdAt ? Date.now() - Date.parse(order.createdAt) : 0;
      if (age < 10 * 60_000) continue;
      try {
        const accountNumber = positions[0]?.accountNumber ?? (state.accountNumber as string | undefined);
        if (!accountNumber) continue;
        await appExec("/api/cron/rh-exec", { method: "POST", body: JSON.stringify({ op: "cancel", accountNumber, orderId: order.id }) });
        console.log(JSON.stringify({ event: "rh_stale_entry_cancelled", orderId: order.id, ageMinutes: Math.round(age / 60_000) }));
      } catch (error) {
        errors.push(`stale entry cancel ${order.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // Close monitors for positions that no longer exist at the broker.
    const openTickers = positions.map(position => position.occTicker);
    await db.from("rh_position_monitors").update({ status: "closed", updated_at: new Date().toISOString() }).eq("status", "monitoring").not("occ_ticker", "in", `(${openTickers.length ? openTickers.map(ticker => `"${ticker}"`).join(",") : '""'})`);
    await db.from("rh_position_monitors").update({ status: "closed", updated_at: new Date().toISOString() }).eq("status", "closing").not("occ_ticker", "in", `(${openTickers.length ? openTickers.map(ticker => `"${ticker}"`).join(",") : '""'})`);
    for (const position of positions) {
      try {
        if (manageExits) {
          await this.manage(position, orders, quotes);
        } else {
          // Off-session (or exits disabled): keep the monitor row registered and visible
          // without evaluating exits — quotes are legitimately stale then. opened_at
          // mirrors manage(): existing row first, then the actual buy fill, then now.
          const monitor = await loadMonitor(position.occTicker);
          const orderOpenedAt = openedAtFromOrders(position, orders);
          const openedAt = monitor?.opened_at ? Date.parse(monitor.opened_at) : orderOpenedAt ?? Date.now();
          await saveMonitor(position, { status: "monitoring", last_error: null, opened_at: new Date(openedAt).toISOString(), opened_at_exact: monitor?.opened_at_exact ?? orderOpenedAt != null });
        }
        this.managedCount++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${position.occTicker}: ${message}`);
        await saveMonitor(position, { status: "error", last_error: message }).catch(() => undefined);
      }
    }
    return { symbols: openTickers, errors };
  }

  private async manage(position: RhPosition, orders: RhOrder[], quotes: MassiveQuoteStream) {
    const now = Date.now();
    const monitor = await loadMonitor(position.occTicker);
    // Autonomous entries record their strategy; scalp entries get the scalp exit
    // envelope (2x target, 25% stop, 30-min box) instead of the burst profile.
    const { data: entryOrder } = await db.from("rh_entry_orders").select("strategy")
      .eq("contract_ticker", position.occTicker).neq("status", "rejected")
      .gte("created_at", new Date(now - 48 * 3_600_000).toISOString())
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    const exitMode = entryOrder?.strategy === "scalp" ? "scalp" as const : entryOrder?.strategy === "drive" ? "drive" as const : "burst" as const;
    const orderOpenedAt = openedAtFromOrders(position, orders);
    const openedAt = monitor?.opened_at ? Date.parse(monitor.opened_at) : orderOpenedAt ?? now;
    const openedAtExact = monitor?.opened_at_exact ?? orderOpenedAt != null;
    // Quote ladder: Massive stream (fresh <=15s) -> Alpaca live option quote (equity
    // contracts, <=60s) -> minutes-stale chain snapshot as last resort. The snapshot
    // path alone let a TSLA put spike +55% invisibly on 8/14 (peaks & the 10-minute
    // follow-through test are only as good as the freshest quote the worker sees).
    const restQuote = position.chainSymbol === "SPXW" ? null : await getLatestOptionQuote(position.occTicker);
    const restFresh = restQuote && now - restQuote.timestamp <= 60_000 ? restQuote : null;
    const quote = fresh(quotes.get(position.occTicker), now) ?? restFresh ?? await getSnapshotQuote(snapshotUnderlying(position.chainSymbol), position.occTicker);
    if (!quote || now - quote.timestamp > 30_000) {
      await saveMonitor(position, { status: "error", last_error: "No fresh option quote", opened_at: new Date(openedAt).toISOString(), opened_at_exact: openedAtExact });
      throw new Error(`No fresh option quote for ${position.occTicker}`);
    }
    const peakBid = Math.max(Number(monitor?.peak_bid ?? 0), quote.bid, position.entryPrice);
    const managed: ManagedPosition = {
      ticker: position.occTicker, alpacaSymbol: position.occTicker.slice(2), side: position.optionType,
      quantity: position.quantity, entryPrice: position.entryPrice, peakBid,
      openedAt, signalId: "", userId: "robinhood", exitMode,
      market: { openingRangeHigh: 0, openingRangeLow: 0, referencePrice: 0, chartSymbol: position.chainSymbol },
      closeOrderId: monitor?.close_order_id ?? null,
      closeOrderSubmittedAt: monitor?.close_submitted_at ? Date.parse(monitor.close_submitted_at) : null,
    };
    // Manual Robinhood entries carry no opening-range context -> underlying invalidation is
    // disabled (underlyingPrice null). No-follow-through only applies with an exact open time.
    const dte = Math.max(0, Math.round((Date.parse(`${position.expirationDate}T16:00:00-04:00`) - now) / 86_400_000));
    let reason = evaluateExit({ position: managed, bid: quote.bid, underlyingPrice: null, longDated: dte > 2 });
    if (reason === "no_follow_through" && !openedAtExact) reason = null;
    const base = { opened_at: new Date(openedAt).toISOString(), opened_at_exact: openedAtExact, peak_bid: peakBid, latest_bid: quote.bid };
    if (!reason) { await saveMonitor(position, { ...base, status: "monitoring", last_error: null }); return; }
    const urgent = reason === "premium_stop" || reason === "mandatory_time_exit";
    const limit = Math.max(0.01, Number((urgent ? quote.bid * 0.95 : quote.bid).toFixed(2)));
    const openClose = orders.find(order => OPEN_STATES.includes(order.state) && order.side === "sell" && order.positionEffect === "close" && order.optionIds.includes(position.optionId));
    if (openClose) {
      const submittedAt = monitor?.close_submitted_at ? Date.parse(monitor.close_submitted_at) : now;
      const currentLimit = Number(monitor?.close_limit ?? openClose.price ?? 0);
      // Escalation: cancel + re-place 5% through the bid after 30 seconds working.
      if (now - submittedAt >= 30_000 && Math.abs(currentLimit - limit) >= 0.01) {
        await appExec("/api/cron/rh-exec", { method: "POST", body: JSON.stringify({ op: "cancel", accountNumber: position.accountNumber, orderId: openClose.id }) });
        const refId = crypto.randomUUID();
        const aggressive = Math.max(0.01, Number((quote.bid * 0.95).toFixed(2)));
        await appExec("/api/cron/rh-exec", { method: "POST", body: JSON.stringify({ op: "close", accountNumber: position.accountNumber, optionId: position.optionId, chainSymbol: position.chainSymbol, underlyingType: position.chainSymbol === "SPXW" ? "index" : "equity", quantity: Math.round(position.quantity), limitPrice: aggressive, refId, reason: `${reason}_escalated` }) });
        await saveMonitor(position, { ...base, status: "closing", exit_reason: reason, close_order_id: refId, close_submitted_at: new Date(now).toISOString(), close_limit: aggressive, last_error: null });
        return;
      }
      await saveMonitor(position, { ...base, status: "closing", exit_reason: reason, close_order_id: openClose.id, close_limit: currentLimit || limit, last_error: null });
      return;
    }
    const refId = crypto.randomUUID();
    await appExec("/api/cron/rh-exec", { method: "POST", body: JSON.stringify({ op: "close", accountNumber: position.accountNumber, optionId: position.optionId, chainSymbol: position.chainSymbol, underlyingType: position.chainSymbol === "SPXW" ? "index" : "equity", quantity: Math.round(position.quantity), limitPrice: limit, refId, reason }) });
    await saveMonitor(position, { ...base, status: "closing", exit_reason: reason, close_order_id: refId, close_submitted_at: new Date(now).toISOString(), close_limit: limit, last_error: null });
    console.log(JSON.stringify({ event: "rh_exit_submitted", symbol: position.occTicker, reason, limitPrice: limit }));
    void easternClock; // referenced for parity with the Alpaca path; time rules live in evaluateExit
  }
}

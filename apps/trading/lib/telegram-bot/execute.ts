import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAlert } from "@/lib/alerts/server";
import { getRobinhoodAccounts, resolveOptionInstrument, reviewAndPlaceOptionOrder } from "@/lib/brokers/robinhood-trading";
import type { CommandCenter, Contract } from "@/lib/options/types";

// Execution layer for the Telegram bot. Buys and sells both run through the SAME
// broker wrappers the autonomous lanes use, with the human's tap standing in for the
// autonomy gates. What stays hard even on a tap: kill switch (buys), fresh quotes,
// journal-first ordering, and atomic ticket claims (a double-tap can never double-buy).
// Alerts here are severity "info" ON PURPOSE: the bot already answers in-chat, and an
// instant-tier alert would mirror every action to Telegram twice.

const admin = () => createAdminClient();

export async function rhUserId(): Promise<string | null> {
  const { data } = await admin().from("broker_connections").select("user_id").eq("broker", "robinhood").eq("status", "connected").limit(1).maybeSingle();
  return data?.user_id ? String(data.user_id) : null;
}

async function agenticAccountNumber(userId: string): Promise<string | null> {
  const accounts = await getRobinhoodAccounts(userId);
  const agentic = accounts.find((account: any) =>
    [account?.agentic_allowed, account?.is_agentic].some(flag => flag === true || flag === "true" || flag === 1)
    || String(account?.account_type ?? account?.type ?? "").toLowerCase().includes("agentic"));
  return agentic?.account_number ? String(agentic.account_number) : null;
}

async function killSwitchOn(): Promise<boolean> {
  const { data } = await admin().from("position_manager_control").select("kill_switch").eq("id", true).maybeSingle();
  return Boolean(data?.kill_switch);
}

async function freshContract(underlying: string, ticker: string): Promise<Contract | null> {
  const { data } = await admin().from("options_monitor_snapshots").select("payload").eq("underlying", underlying).maybeSingle();
  const contract = ((data?.payload as CommandCenter | null)?.contracts ?? []).find(candidate => candidate.ticker === ticker) ?? null;
  if (!contract) return null;
  // A quote that stopped updating must not price an order (frozen-chain doctrine).
  if (contract.quoteUpdatedAt == null || Date.now() - contract.quoteUpdatedAt > 10 * 60_000) return null;
  return contract;
}

export type BuyPayload = { underlying: string; side: "call" | "put"; signalId?: string; setup?: string; ticker: string; strike: number; expirationDate: string; quantity: number; askAtProposal: number; override: boolean; cap: number };

export async function executeBuyTicket(ticketId: string): Promise<string> {
  const db = admin();
  // Atomic claim: only one tap ever owns a ticket.
  const { data: claimed } = await db.from("tg_tickets")
    .update({ status: "executing", decided_at: new Date().toISOString() })
    .eq("id", ticketId).eq("status", "proposed").select("id,payload,source,created_at,tg_message_id").maybeSingle();
  if (!claimed) return "Ticket already handled (or expired).";
  const finish = async (status: "executed" | "failed" | "expired", result: Record<string, unknown>, reply: string) => {
    await db.from("tg_tickets").update({ status, result }).eq("id", ticketId);
    return reply;
  };
  const payload = claimed.payload as BuyPayload;
  const ageMs = Date.now() - Date.parse(String(claimed.created_at));
  if (claimed.source === "engine" && ageMs > 15 * 60_000) return finish("expired", { reason: "stale" }, `⌛ That ${payload.underlying} card is ${Math.round(ageMs / 60_000)} min old — the quote has moved on. Reply "buy ${payload.quantity} ${Math.round(payload.strike)}${payload.side === "put" ? "p" : "c"}" for a fresh ticket.`);
  if (await killSwitchOn()) return finish("failed", { reason: "kill switch" }, "🛑 Kill switch is ON — no buys until it is cleared in the dashboard.");
  const userId = await rhUserId();
  if (!userId) return finish("failed", { reason: "rh disconnected" }, "🛑 Robinhood is not connected — reconnect in the dashboard first.");
  const live = await freshContract(payload.underlying, payload.ticker);
  if (!live) return finish("expired", { reason: "no fresh quote" }, `⌛ No fresh quote for ${payload.ticker.replace("O:", "")} right now — the chain may have rotated or gone stale. Re-issue the buy when the scan refreshes.`);
  if (live.ask > payload.askAtProposal * 2) return finish("expired", { reason: "quote doubled" }, `⚠️ ${payload.ticker.replace("O:", "")} now asks $${live.ask.toFixed(2)} — more than double the card's $${payload.askAtProposal.toFixed(2)}. Not buying on a blown-out quote; re-issue if you still want it.`);
  const limitPrice = Math.max(0.01, Number((live.midpoint + (live.ask - live.midpoint) / 3).toFixed(2)));
  const debit = payload.quantity * limitPrice * 100;
  if (!payload.override && debit > payload.cap * 1.05) return finish("expired", { reason: "moved past cap" }, `⚠️ Price moved: ${payload.quantity}× now costs ~$${debit.toFixed(0)}, above the $${payload.cap} cap this card was sized to. Reply with "override" if you want it anyway.`);
  const accountNumber = await agenticAccountNumber(userId);
  if (!accountNumber) return finish("failed", { reason: "no agentic account" }, "🛑 No agentic Robinhood account found on the connection.");
  const chainSymbol = /^O:([A-Z]+?)\d{6}[CP]/.exec(payload.ticker)?.[1] ?? payload.underlying;
  const refId = crypto.randomUUID();
  // Journal FIRST — a placement failure marks the row rejected; nothing retries silently.
  const { error: journalError } = await db.from("rh_entry_orders").insert({
    user_id: userId, signal_id: `tg-${ticketId}`, ref_id: refId, underlying: payload.underlying,
    contract_ticker: payload.ticker, quantity: payload.quantity, limit_price: limitPrice,
    max_debit: debit, status: "submitted", strategy: "telegram",
  });
  if (journalError) return finish("failed", { reason: journalError.message }, `🛑 Journal failed (${journalError.message}) — order NOT placed.`);
  try {
    const instrument = await resolveOptionInstrument(userId, { chainSymbol, expirationDate: payload.expirationDate, strike: payload.strike, type: payload.side });
    const { order } = await reviewAndPlaceOptionOrder(userId, {
      accountNumber, optionId: instrument.id, side: "buy", positionEffect: "open",
      quantity: payload.quantity, limitPrice, chainSymbol,
      underlyingType: chainSymbol === "SPXW" || chainSymbol === "SPX" ? "index" : "equity", refId,
    });
    await db.from("rh_entry_orders").update({ broker_response: order ?? null }).eq("ref_id", refId);
    await createAlert({
      userId, eventKey: `tg-buy-${refId}`, severity: "info",
      title: `Telegram buy: ${payload.quantity}× ${payload.ticker.replace("O:", "")}`,
      body: `You approved ${payload.quantity}× ${payload.ticker.replace("O:", "")} at a $${limitPrice.toFixed(2)} limit (~$${debit.toFixed(0)}${payload.override ? ", over-cap override" : ""}) from the Telegram bot. MANUAL EXIT: the position starts in manual_hold — the worker watches it but never exits; selling is the human's call.`,
      metadata: { kind: "tg_buy", refId, ticketId, contractTicker: payload.ticker, limitPrice, quantity: payload.quantity, override: payload.override },
    }).catch(() => undefined);
    await finish("executed", { refId, limitPrice, debit }, "");
    return `✅ BUY submitted: ${payload.quantity}× ${payload.ticker.replace("O:", "")} @ $${limitPrice.toFixed(2)} limit (~$${debit.toFixed(0)}${payload.override ? " — over-cap, your call" : ""}). MANUAL EXIT mode: no stops or trails will fire — the exit is yours (expires ${payload.expirationDate}; I'll page you at 2:30 PM on expiry day if it's still open). /positions to manage it.`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.from("rh_entry_orders").update({ status: "rejected", broker_response: { error: message } }).eq("ref_id", refId);
    return finish("failed", { reason: message }, `🛑 Robinhood rejected the order: ${message.slice(0, 250)}. No money moved.`);
  }
}

export async function skipTickets(id: string): Promise<string> {
  const db = admin();
  // A card can carry sibling tickets (capped + over-cap buy); skipping skips them all.
  const { data: ticket } = await db.from("tg_tickets").select("tg_message_id").eq("id", id).maybeSingle();
  const query = db.from("tg_tickets").update({ status: "skipped", decided_at: new Date().toISOString() }).eq("status", "proposed");
  await (ticket?.tg_message_id != null ? query.eq("tg_message_id", ticket.tg_message_id) : query.eq("id", id));
  return "Skipped.";
}

export async function executeSell(occTicker: string, quantityWanted: number | "all" | "half"): Promise<string> {
  const db = admin();
  const { data: monitor } = await db.from("rh_position_monitors").select("*").eq("occ_ticker", occTicker).maybeSingle();
  if (!monitor) return `No position found for ${occTicker.replace("O:", "")}.`;
  if (monitor.status === "closing") return `The worker is already selling ${occTicker.replace("O:", "")} — not stacking a second close order.`;
  if (!["monitoring", "manual_hold", "error"].includes(String(monitor.status))) return `${occTicker.replace("O:", "")} is ${monitor.status} — nothing to sell.`;
  const held = Math.floor(Number(monitor.quantity));
  const quantity = quantityWanted === "all" ? held : quantityWanted === "half" ? Math.max(1, Math.floor(held / 2)) : Math.min(held, Math.floor(quantityWanted));
  if (quantity < 1) return "Nothing to sell at that quantity.";
  // In-flight guard: one sell per contract per 90 seconds (double-tap protection).
  const { data: inflight, error: inflightError } = await db.from("tg_tickets").select("id").eq("kind", "sell")
    .gte("created_at", new Date(Date.now() - 90_000).toISOString())
    .in("status", ["executing", "executed"]).contains("payload", { occTicker });
  if (inflightError) return `Sell guard unavailable (${inflightError.message}) — not selling blind; try again.`;
  if (inflight?.length) return "A sell for this contract is already in flight — give it a minute, then /positions to check.";
  const { data: ticket, error: ticketError } = await db.from("tg_tickets").insert({
    user_id: String(monitor.user_id ?? (await rhUserId())), kind: "sell", source: "command", status: "executing",
    payload: { occTicker, quantity, requested: String(quantityWanted) },
  }).select("id").single();
  if (ticketError || !ticket) return `Could not journal the sell (${ticketError?.message}) — not placed.`;
  const finish = async (status: "executed" | "failed", result: Record<string, unknown>, reply: string) => {
    await db.from("tg_tickets").update({ status, result, decided_at: new Date().toISOString() }).eq("id", ticket.id);
    return reply;
  };
  const userId = await rhUserId();
  if (!userId) return finish("failed", { reason: "rh disconnected" }, "🛑 Robinhood is not connected.");
  // Price freshness ladder: the worker's bid only while its row is a live pulse
  // (<3 min); when the worker is silent, fall back to the scan's own quote. A sell
  // priced off a frozen bid can sit unfilled above a falling market while the user
  // believes they're out — never price a close blind.
  const workerAgeMs = Date.now() - Date.parse(String(monitor.updated_at));
  let bid = workerAgeMs < 3 * 60_000 ? Number(monitor.latest_bid ?? 0) : 0;
  let priceSource = "worker";
  if (!(bid > 0)) {
    const chain = String(monitor.chain_symbol);
    const snapUnderlying = ["SPXW", "SPX"].includes(chain) ? "SPX" : chain;
    const live = await freshContract(snapUnderlying, occTicker);
    if (live && live.bid > 0) { bid = live.bid; priceSource = "scan"; }
  }
  if (!(bid > 0)) return finish("failed", { reason: "no fresh quote" }, `🛑 No fresh quote on ${occTicker.replace("O:", "")} — worker quotes are ${Math.round(workerAgeMs / 60_000)} min old and the scan has nothing live. Refusing to price a sell blind; if the worker is down, check Railway, or sell directly in Robinhood.`);
  // Hand the position to the manual lane BEFORE selling so the worker never races
  // this close with its own stop/trail order on the same contract.
  if (monitor.status === "monitoring") {
    await db.from("rh_position_monitors").update({ status: "manual_hold", updated_at: new Date().toISOString() }).eq("occ_ticker", occTicker).eq("status", "monitoring");
  }
  const refId = crypto.randomUUID();
  try {
    const { order } = await reviewAndPlaceOptionOrder(userId, {
      accountNumber: String(monitor.account_number), optionId: String(monitor.option_id), side: "sell", positionEffect: "close",
      quantity, limitPrice: Math.max(0.01, Number(bid.toFixed(2))), chainSymbol: String(monitor.chain_symbol),
      underlyingType: ["SPXW", "SPX"].includes(String(monitor.chain_symbol)) ? "index" : "equity", refId,
    });
    await createAlert({
      userId, eventKey: `tg-sell-${refId}`, severity: "info",
      title: `Telegram sell: ${quantity}× ${occTicker.replace("O:", "")}`,
      body: `You sold ${quantity} of ${held} ${occTicker.replace("O:", "")} at a $${bid.toFixed(2)} limit from the Telegram bot.`,
      metadata: { kind: "tg_sell", refId, occTicker, quantity, limitPrice: bid, order },
    }).catch(() => undefined);
    const remainder = held - quantity;
    await finish("executed", { refId, quantity, limitPrice: bid, priceSource }, "");
    return `✅ SELL submitted: ${quantity}× ${occTicker.replace("O:", "")} @ $${bid.toFixed(2)} limit${priceSource === "scan" ? " (priced from the live scan — worker quotes were stale)" : ""}.${remainder > 0 ? ` ${remainder} remaining — position is now on manual hold (the worker watches but won't exit); tap "Hand back" in /positions to re-arm its stops.` : ""}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return finish("failed", { reason: message }, `🛑 Robinhood rejected the sell: ${message.slice(0, 250)}. Position is on manual hold — /positions to retry or hand back.`);
  }
}

export async function setHold(occTicker: string, hold: boolean): Promise<string> {
  const from = hold ? "monitoring" : "manual_hold";
  const to = hold ? "manual_hold" : "monitoring";
  const { data } = await admin().from("rh_position_monitors").update({ status: to, updated_at: new Date().toISOString() })
    .eq("occ_ticker", occTicker).eq("status", from).select("occ_ticker");
  if (!data?.length) return `${occTicker.replace("O:", "")} is not in '${from}' — nothing changed.`;
  return hold
    ? `✋ ${occTicker.replace("O:", "")} is yours now: the worker watches but will NOT exit. Sell from /positions, or hand it back anytime.`
    : `🤖 ${occTicker.replace("O:", "")} handed back: the worker's stop/trail/time rules are live again.`;
}

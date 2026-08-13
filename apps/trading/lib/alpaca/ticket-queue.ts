import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAlert } from "@/lib/alerts/server";
import { submitPaperOptionOrder, submitPaperOptionSell } from "./paper";
import type { CommandCenter } from "@/lib/options/types";

// PAPER TICKET QUEUE: programmatic paper orders. Insert a row (contract, quantity,
// strategy tag, exit mode) and the next in-session cron tick places it at the ask
// from the freshest snapshot. Powers the flow-follow ITM/OTM experiment and any
// ad-hoc "buy X on paper and track it" request. PAPER ONLY by construction — this
// module imports the paper client and nothing else.

const etNow = () => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map(part => [part.type, part.value]));
  return { weekday: String(parts.weekday), minutes: Number(parts.hour) * 60 + Number(parts.minute) };
};

async function quoteFromSnapshots(admin: ReturnType<typeof createAdminClient>, contractTicker: string): Promise<{ ask: number; bid: number } | null> {
  const underlying = /^O:([A-Z]+?)\d{6}/.exec(contractTicker)?.[1] ?? "";
  const symbol = underlying === "SPXW" ? "SPX" : underlying;
  const { data } = await admin.from("options_monitor_snapshots").select("payload,updated_at").eq("underlying", symbol).maybeSingle();
  if (!data) return null;
  const ageMs = Date.now() - Date.parse(String(data.updated_at));
  if (ageMs > 10 * 60_000) return null; // snapshot too stale to price against
  const contracts = ((data.payload as CommandCenter | null)?.contracts ?? []) as Array<{ ticker: string; ask: number; bid: number }>;
  const found = contracts.find(contract => contract.ticker === contractTicker);
  return found && found.ask > 0 ? { ask: found.ask, bid: found.bid } : null;
}

export async function runPaperTicketQueue(): Promise<{ placed: number; skipped: number }> {
  const { weekday, minutes } = etNow();
  if (["Sat", "Sun"].includes(weekday) || minutes < 571 || minutes > 955) return { placed: 0, skipped: 0 };
  const admin = createAdminClient();
  const { data: control } = await admin.from("position_manager_control").select("kill_switch").eq("id", true).single();
  if (control?.kill_switch) return { placed: 0, skipped: 0 };
  const { data: owner } = await admin.from("profiles").select("id").limit(1).maybeSingle();
  if (!owner) return { placed: 0, skipped: 0 };
  const { data: tickets } = await admin.from("paper_ticket_queue").select("*").eq("status", "pending").order("created_at").limit(3);
  let placed = 0, skipped = 0;
  for (const ticket of tickets ?? []) {
    try {
      // Stale-ticket guard: a ticket that sat unplaced for 2+ hours (queued overnight,
      // priced off a dead snapshot, thesis gone) expires instead of executing late.
      if (Date.now() - Date.parse(String(ticket.created_at)) > 2 * 3_600_000) {
        await admin.from("paper_ticket_queue").update({ status: "expired", result: { reason: "ticket sat unplaced for over 2 hours" } }).eq("id", ticket.id);
        skipped++; continue;
      }
      const quote = await quoteFromSnapshots(admin, String(ticket.contract_ticker));
      if (quote == null) { skipped++; continue; } // stale/missing quote — retry next tick
      const clientOrderId = `velocity-ticket-${String(ticket.id).slice(0, 8)}-${Date.now() % 1e7}`.slice(0, 48);
      // SELL tickets (manual intervention): place sell-to-close at the bid and mark the
      // ticket done — the worker's close-order escalation adopts the working sell (it
      // chases the bid until filled) and journals the exit like any other close.
      if (ticket.action === "sell") {
        if (!(quote.bid > 0)) { skipped++; continue; }
        const sellOrder = await submitPaperOptionSell({ symbol: String(ticket.contract_ticker), limitPrice: quote.bid, clientOrderId, quantity: Number(ticket.quantity) });
        await admin.from("paper_ticket_queue").update({ status: "placed", result: { orderId: sellOrder.id, limitPrice: quote.bid } }).eq("id", ticket.id);
        await createAlert({
          userId: String(owner.id), eventKey: `paper-ticket-${ticket.id}`, severity: "success",
          title: `Manual sell placed: ${ticket.quantity} × ${String(ticket.contract_ticker).replace("O:", "")}`,
          body: `SELL to close at a $${quote.bid.toFixed(2)} limit${ticket.note ? ` · ${ticket.note}` : ""}. The worker escalates the price until it fills and journals the exit.`,
          metadata: { kind: "paper_ticket_sell", contractTicker: ticket.contract_ticker },
        }).catch(() => undefined);
        placed++; continue;
      }
      const ask = quote.ask;
      const order = await submitPaperOptionOrder({ symbol: String(ticket.contract_ticker), limitPrice: ask, clientOrderId, quantity: Number(ticket.quantity) });
      // Pre-create the monitor row so the worker adopts with the requested exit mode
      // (trend = ride the thesis, no same-day flat; worker preserves stored modes).
      // latest_ask/last_quote_at are NOT NULL — omitting them made this insert fail
      // silently on 2026-08-13 and the worker defaulted 1DTE fills to burst mode.
      const { error: monitorError } = await admin.from("paper_position_monitors").upsert({
        contract_ticker: ticket.contract_ticker, user_id: owner.id, signal_id: null, status: "monitoring",
        entry_price: ask, peak_bid: ask, latest_bid: ask, latest_ask: ask,
        opened_at: new Date().toISOString(), last_quote_at: new Date().toISOString(),
        exit_mode: ticket.exit_mode, updated_at: new Date().toISOString(),
      });
      if (monitorError) console.error("ticket monitor pre-create failed", ticket.contract_ticker, monitorError.message);
      await admin.from("paper_trade_orders").insert({
        user_id: owner.id, signal_id: null, alpaca_order_id: order.id, client_order_id: order.client_order_id,
        action: "buy_to_open", underlying: (/^O:([A-Z]+?)\d{6}/.exec(String(ticket.contract_ticker))?.[1] ?? "").replace(/W$/, ""),
        contract_ticker: ticket.contract_ticker, quantity: ticket.quantity, order_type: "limit",
        limit_price: ask, max_debit: ask * Number(ticket.quantity) * 100, status: order.status,
        risk_snapshot: { strategy: ticket.strategy, queued: true, note: ticket.note ?? null }, broker_response: order,
      });
      await admin.from("paper_ticket_queue").update({ status: "placed", result: { orderId: order.id, limitPrice: ask } }).eq("id", ticket.id);
      await createAlert({
        userId: String(owner.id), eventKey: `paper-ticket-${ticket.id}`, severity: "success",
        title: `Queued paper ticket placed: ${ticket.quantity} × ${String(ticket.contract_ticker).replace("O:", "")}`,
        body: `Bought at a $${ask.toFixed(2)} limit (~$${(ask * Number(ticket.quantity) * 100).toFixed(0)} paper) — strategy "${ticket.strategy}"${ticket.note ? ` · ${ticket.note}` : ""}. Exit mode ${ticket.exit_mode}: ${ticket.exit_mode === "trend" ? "rides with only the 50% disaster floor (plus expiry-day flat)" : "standard stop/trail/time rules"}.`,
        metadata: { kind: "paper_ticket", strategy: ticket.strategy, contractTicker: ticket.contract_ticker },
      }).catch(() => undefined);
      placed++;
    } catch (error) {
      await admin.from("paper_ticket_queue").update({ status: "error", result: { error: error instanceof Error ? error.message : String(error) } }).eq("id", ticket.id);
      skipped++;
    }
  }
  return { placed, skipped };
}

// FLOW-FOLLOW PAIRING: for a large print, queue BOTH expressions of the thesis —
// an ITM contract (~0.65-0.80 delta, stock-like, high win-rate expression) and an
// OTM contract (~0.20-0.35 delta, convex lottery expression) in the flow's
// direction and expiry. The paired records answer "if whales are worth following,
// which moneyness pays?" Max 3 pairs/day; one pair per symbol per day.
export async function queueFlowFollowPair(input: { symbol: string; direction: "bullish" | "bearish"; expirationDate: string; premium: number }): Promise<void> {
  // Session gate: chains keep refreshing overnight with the day's FINAL tape, so
  // recordFlowWatch fires off stale prints at 9 PM/midnight. A follow is only valid
  // while the print is fresh — queue during the session only (9:35-15:30 ET, weekdays).
  // 2026-08-13: overnight queues bought yesterday's flow at the open AND double-queued
  // NVDA when the calendar-day dedupe reset at midnight.
  const clock = etNow();
  if (["Sat", "Sun"].includes(clock.weekday) || clock.minutes < 575 || clock.minutes > 930) return;
  const admin = createAdminClient();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
  const { count: todayPairs } = await admin.from("paper_ticket_queue").select("id", { count: "exact", head: true }).like("strategy", "flow-%").in("status", ["pending", "placed"]).gte("created_at", `${today}T00:00:00-04:00`);
  if ((todayPairs ?? 0) >= 6) return; // 3 pairs/day cap (cancelled/expired don't count)
  // Per-symbol dedupe over a 3-day window (NOT the calendar day — midnight resets re-queued the same print).
  const { data: dupe } = await admin.from("paper_ticket_queue").select("id").like("strategy", "flow-%").ilike("note", `${input.symbol} flow-follow%`).gte("created_at", new Date(Date.now() - 3 * 86_400_000).toISOString()).limit(1).maybeSingle();
  if (dupe) return;
  const { data: snap } = await admin.from("options_monitor_snapshots").select("payload").eq("underlying", input.symbol === "SPXW" ? "SPX" : input.symbol).maybeSingle();
  const side = input.direction === "bullish" ? "call" : "put";
  const contracts = (((snap?.payload as CommandCenter | null)?.contracts ?? []) as Array<{ ticker: string; side: string; expirationDate: string; ask: number; delta: number | null; eligible: boolean }>)
    .filter(contract => contract.eligible && contract.side === side && contract.expirationDate === input.expirationDate && contract.ask > 0 && contract.delta != null);
  const pick = (low: number, high: number) => contracts.filter(contract => Math.abs(contract.delta!) >= low && Math.abs(contract.delta!) <= high)
    .sort((a, b) => Math.abs(Math.abs(a.delta!) - (low + high) / 2) - Math.abs(Math.abs(b.delta!) - (low + high) / 2))[0];
  const itm = pick(0.6, 0.85); const otm = pick(0.18, 0.38);
  const note = `${input.symbol} flow-follow: $${(input.premium / 1e6).toFixed(1)}M ${input.direction} print`;
  const rows = [
    itm ? { contract_ticker: itm.ticker, quantity: 1, strategy: "flow-itm", exit_mode: "trend", note } : null,
    otm ? { contract_ticker: otm.ticker, quantity: 1, strategy: "flow-otm", exit_mode: "trend", note } : null,
  ].filter(Boolean);
  if (rows.length) await admin.from("paper_ticket_queue").insert(rows as Array<Record<string, unknown>>).then(({ error }) => { if (error) console.error("flow follow queue failed", error.message); });
}

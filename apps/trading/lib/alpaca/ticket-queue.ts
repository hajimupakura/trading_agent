import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAlert } from "@/lib/alerts/server";
import { submitPaperOptionOrder } from "./paper";
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

async function askFromSnapshots(admin: ReturnType<typeof createAdminClient>, contractTicker: string): Promise<number | null> {
  const underlying = /^O:([A-Z]+?)\d{6}/.exec(contractTicker)?.[1] ?? "";
  const symbol = underlying === "SPXW" ? "SPX" : underlying;
  const { data } = await admin.from("options_monitor_snapshots").select("payload,updated_at").eq("underlying", symbol).maybeSingle();
  if (!data) return null;
  const ageMs = Date.now() - Date.parse(String(data.updated_at));
  if (ageMs > 10 * 60_000) return null; // snapshot too stale to price against
  const contracts = ((data.payload as CommandCenter | null)?.contracts ?? []) as Array<{ ticker: string; ask: number }>;
  const found = contracts.find(contract => contract.ticker === contractTicker);
  return found && found.ask > 0 ? found.ask : null;
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
      const ask = await askFromSnapshots(admin, String(ticket.contract_ticker));
      if (ask == null) { skipped++; continue; } // stale/missing quote — retry next tick
      const clientOrderId = `velocity-ticket-${String(ticket.id).slice(0, 8)}-${Date.now() % 1e7}`.slice(0, 48);
      const order = await submitPaperOptionOrder({ symbol: String(ticket.contract_ticker), limitPrice: ask, clientOrderId, quantity: Number(ticket.quantity) });
      // Pre-create the monitor row so the worker adopts with the requested exit mode
      // (trend = ride the thesis, no same-day flat; worker preserves stored modes).
      await admin.from("paper_position_monitors").upsert({
        contract_ticker: ticket.contract_ticker, user_id: owner.id, signal_id: null, status: "monitoring",
        entry_price: ask, peak_bid: ask, latest_bid: ask, opened_at: new Date().toISOString(),
        exit_mode: ticket.exit_mode, updated_at: new Date().toISOString(),
      });
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
  const admin = createAdminClient();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
  const { count: todayPairs } = await admin.from("paper_ticket_queue").select("id", { count: "exact", head: true }).like("strategy", "flow-%").gte("created_at", `${today}T00:00:00-04:00`);
  if ((todayPairs ?? 0) >= 6) return; // 3 pairs/day cap
  const { data: dupe } = await admin.from("paper_ticket_queue").select("id").like("strategy", "flow-%").ilike("note", `%${input.symbol}%`).gte("created_at", `${today}T00:00:00-04:00`).limit(1).maybeSingle();
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

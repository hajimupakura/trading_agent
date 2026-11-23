import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadRiskSettings } from "@/lib/settings/risk-settings";
import { sendText, sendWithButtons, type InlineButton } from "./api";
import { rhUserId } from "./execute";
import type { CommandCenter } from "@/lib/options/types";

// Deterministic text-command parser — deliberately NOT an LLM: a money command must
// parse the same way every time, and anything unparseable gets help text instead of a
// guess. Examples it accepts:
//   buy 2 6900p            → 2× SPX 6900 put, nearest expiry, inside the cap
//   buy 1 nvda 135p override → single name, any premium (override = your authorization)
//   buy 6880p @4.50        → explicit limit price
//   sell all / sell 2 6900p / positions / help

const BUY_RE = /^\/?buy\s+(?:(\d{1,2})\s+)?(?:([a-z]{1,5})\s+)?(\d{2,5}(?:\.\d+)?)\s*(c|p|call|put)\b(?:\s*@?\$?(\d+(?:\.\d+)?))?(.*)$/i;
const SELL_RE = /^\/?sell\s+(all|half|\d{1,3})(?:\s+(?:([a-z]{1,5})\s+)?(\d{2,5}(?:\.\d+)?)\s*(c|p))?\s*$/i;

export const HELP_TEXT = [
  "Velocity bot commands:",
  "• buy [qty] [symbol] [strike][c/p] [@limit] [Ndte] [override] — e.g. \"buy 2 6900p\", \"buy 1 spy 700p 2dte\", \"buy 1 nvda 135p override\". Symbol defaults to SPX, qty to 1, expiry to the nearest (add \"1dte\"/\"5dte\" to pick). \"override\" authorizes going past the Robinhood debit cap.",
  "• sell all | sell half | sell 2 [strike][c/p] — sells from your open Robinhood positions.",
  "• positions — every open position with live P&L and sell/hold buttons.",
  "Every buy/sell shows a confirm card first; nothing executes without your tap.",
].join("\n");

export async function handleCommand(text: string): Promise<void> {
  const trimmed = text.trim();
  if (/^\/?(positions|pos)$/i.test(trimmed)) return listPositions();
  if (/^\/?(help|start)$/i.test(trimmed)) return sendText(HELP_TEXT);
  const buy = BUY_RE.exec(trimmed);
  if (buy) {
    // STRICT TAIL: after strike/side, only "override" and "Ndte" may follow. A money
    // parser must never silently drop a word — "buy 1 6900p spy" once parsed as an
    // SPX order with "spy" ignored, which is a confirm card for the wrong underlying.
    const tail = (buy[6] ?? "").replace(/\boverride\b/i, "").replace(/\b\d{1,2}\s*dte\b/i, "").trim();
    if (tail) return sendText(`I read that as ${(buy[2] ?? "SPX").toUpperCase()} ${buy[3]}${buy[4].toUpperCase()} but didn't understand "${tail}". Word order is: buy [qty] [symbol] [strike][c/p] [@limit] [Ndte] [override] — the symbol comes BEFORE the strike, e.g. "buy 1 nvda 169p".`);
    return proposeCommandBuy({ quantity: Number(buy[1] ?? 1), symbol: (buy[2] ?? "SPX").toUpperCase(), strike: Number(buy[3]), side: /^c/i.test(buy[4]) ? "call" : "put", limit: buy[5] ? Number(buy[5]) : null, override: /\boverride\b/i.test(buy[6] ?? ""), dte: /(\d{1,2})\s*dte\b/i.exec(buy[6] ?? "") ? Number(/(\d{1,2})\s*dte\b/i.exec(buy[6] ?? "")![1]) : null });
  }
  const sell = SELL_RE.exec(trimmed);
  if (sell) return proposeCommandSell({ amount: /^(all|half)$/i.test(sell[1]) ? sell[1].toLowerCase() as "all" | "half" : Number(sell[1]), strike: sell[3] ? Number(sell[3]) : null, side: sell[4] ? (/^c/i.test(sell[4]) ? "call" : "put") : null });
  return sendText(`Didn't understand that. ${HELP_TEXT}`);
}

async function proposeCommandBuy(input: { quantity: number; symbol: string; strike: number; side: "call" | "put"; limit: number | null; override: boolean; dte: number | null }): Promise<void> {
  const admin = createAdminClient();
  const { data: snap } = await admin.from("options_monitor_snapshots").select("payload").eq("underlying", input.symbol).maybeSingle();
  const contracts = ((snap?.payload as CommandCenter | null)?.contracts ?? [])
    .filter(contract => contract.side === input.side && Math.abs(contract.strike - input.strike) < 2.5
      && contract.ask > 0 && contract.quoteUpdatedAt != null && Date.now() - contract.quoteUpdatedAt < 10 * 60_000)
    // No dte asked → nearest expiry (0DTE first). "Ndte" asked → the closest listed
    // expiry to it (chains don't list every dte, so 5dte may resolve to 4 or 6 —
    // the confirm card names the real one before anything executes).
    .sort((a, b) => (input.dte == null ? a.dte - b.dte : Math.abs(a.dte - input.dte) - Math.abs(b.dte - input.dte))
      || Math.abs(a.strike - input.strike) - Math.abs(b.strike - input.strike));
  const pick = contracts[0];
  if (!pick) return sendText(`No live ${input.symbol} ${input.strike}${input.side === "call" ? "C" : "P"}${input.dte != null ? ` near ${input.dte}dte` : ""} in the current scan — check the strike, or the chain may be stale right now.`);
  if (input.dte != null && Math.abs(pick.dte - input.dte) > 3) return sendText(`Closest listed expiry to ${input.dte}dte at that strike is ${pick.dte}dte (${pick.expirationDate}) — re-send as "buy ${input.quantity} ${input.symbol === "SPX" ? "" : input.symbol.toLowerCase() + " "}${input.strike}${input.side === "call" ? "c" : "p"} ${pick.dte}dte" if that works for you.`);
  const userId = await rhUserId() ?? (await admin.from("profiles").select("id").limit(1).maybeSingle()).data?.id;
  if (!userId) return sendText("No account on file.");
  const settings = await loadRiskSettings(String(userId));
  const cap = input.symbol === "SPX" ? settings.rhMaxTradeDebitSpx : settings.rhMaxTradeDebit;
  const estDebit = input.quantity * pick.ask * 100;
  if (estDebit > cap && !input.override) return sendText(`That's ~$${estDebit.toFixed(0)}, above the $${cap} Robinhood cap. Add "override" to the command if you want it anyway: buy ${input.quantity} ${input.symbol === "SPX" ? "" : input.symbol.toLowerCase() + " "}${input.strike}${input.side === "call" ? "c" : "p"} override`);
  const { data: ticket, error } = await admin.from("tg_tickets").insert({
    user_id: String(userId), kind: "buy", source: "command",
    payload: { underlying: input.symbol, side: input.side, ticker: pick.ticker, strike: pick.strike, expirationDate: pick.expirationDate, quantity: input.quantity, askAtProposal: pick.ask, override: input.override || estDebit > cap, cap },
  }).select("id").single();
  if (error || !ticket) return sendText(`Could not create the ticket (${error?.message}).`);
  const buttons: InlineButton[][] = [[
    { text: `✅ Confirm ~$${estDebit.toFixed(0)}`, callback_data: `cf:${ticket.id}` },
    { text: "❌ Cancel", callback_data: `cx:${ticket.id}` },
  ]];
  await sendWithButtons(
    `Order check — BUY ${input.quantity}× ${pick.ticker.replace("O:", "")} (dte ${pick.dte})\n`
    + `Ask $${pick.ask.toFixed(2)} · spread ${pick.spreadPct.toFixed(1)}% · ~$${estDebit.toFixed(0)} total${estDebit > cap ? ` — OVER the $${cap} cap (your override)` : ""}.\n`
    + `Worker-guarded exit (30% stop, trail, 3:10 flat); expires ${pick.expirationDate}. "Take over" in /positions anytime for manual control. Confirm?`, buttons);
}

async function proposeCommandSell(input: { amount: number | "all" | "half"; strike: number | null; side: "call" | "put" | null }): Promise<void> {
  const admin = createAdminClient();
  const { data: rows } = await admin.from("rh_position_monitors").select("occ_ticker,option_type,strike,quantity,entry_price,latest_bid,status")
    .in("status", ["monitoring", "manual_hold", "error"]);
  let open = rows ?? [];
  if (input.strike != null) open = open.filter(row => Math.abs(Number(row.strike) - input.strike!) < 2.5);
  if (input.side != null) open = open.filter(row => String(row.option_type) === input.side);
  if (!open.length) return sendText("No matching open position. /positions shows what you hold.");
  if (open.length > 1) return sendText(`That matches ${open.length} positions — name the strike (e.g. "sell ${String(input.amount)} ${Math.round(Number(open[0].strike))}${String(open[0].option_type)[0]}"), or use the buttons in /positions.`);
  const position = open[0];
  const held = Math.floor(Number(position.quantity));
  const quantity = input.amount === "all" ? held : input.amount === "half" ? Math.max(1, Math.floor(held / 2)) : Math.min(held, input.amount);
  const code = input.amount === "all" ? "sa" : input.amount === "half" ? "sh" : `sn${quantity}`;
  const bid = Number(position.latest_bid ?? 0);
  await sendWithButtons(
    `Sell check — ${quantity} of ${held}× ${String(position.occ_ticker).replace("O:", "")}\n`
    + `Entry $${Number(position.entry_price).toFixed(2)} · bid $${bid.toFixed(2)} (${bid && position.entry_price ? `${(((bid / Number(position.entry_price)) - 1) * 100).toFixed(0)}%` : "?"}). Confirm?`,
    [[{ text: `✅ Sell ${quantity}`, callback_data: `${code}:${position.occ_ticker}` }, { text: "❌ Cancel", callback_data: "noop" }]]);
}

export async function listPositions(): Promise<void> {
  const admin = createAdminClient();
  const { data: rows } = await admin.from("rh_position_monitors").select("occ_ticker,option_type,strike,quantity,entry_price,latest_bid,status,opened_at")
    .in("status", ["monitoring", "manual_hold", "closing", "error"]).order("opened_at", { ascending: true });
  if (!rows?.length) return sendText("No open Robinhood positions.");
  for (const row of rows) {
    const occ = String(row.occ_ticker);
    const entry = Number(row.entry_price); const bid = Number(row.latest_bid ?? 0); const qty = Math.floor(Number(row.quantity));
    const pnl = bid && entry ? (bid - entry) * 100 * qty : null;
    const pnlPct = bid && entry ? ((bid / entry - 1) * 100).toFixed(0) : "?";
    const mode = row.status === "manual_hold" ? "✋ manual hold (worker will NOT exit)" : row.status === "closing" ? "⏳ worker is closing it" : row.status === "error" ? "⚠️ monitor error" : "🤖 worker-guarded";
    const buttons: InlineButton[][] = row.status === "closing" ? [] : [
      [{ text: "💰 Sell all", callback_data: `sa:${occ}` }, { text: "Sell 1", callback_data: `sn1:${occ}` }, { text: "Sell half", callback_data: `sh:${occ}` }],
      [row.status === "manual_hold" ? { text: "🤖 Hand back to worker", callback_data: `hb:${occ}` } : { text: "✋ Take over (no auto-exit)", callback_data: `hd:${occ}` }],
    ];
    const text = `${occ.replace("O:", "")} — ${qty}× ${String(row.option_type)}\nEntry $${entry.toFixed(2)} · bid $${bid ? bid.toFixed(2) : "?"} · P&L ${pnl == null ? "?" : `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(0)} (${pnlPct}%)`}\n${mode}`;
    if (buttons.length) await sendWithButtons(text, buttons); else await sendText(text);
  }
}

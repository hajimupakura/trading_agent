import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAlert } from "@/lib/alerts/server";
import { getPaperTradingState, submitPaperOptionOrder } from "./paper";
import { loadRiskSettings } from "@/lib/settings/risk-settings";
import { alpacaChainRows } from "@/lib/options/provider";
import type { CommandCenter, Underlying } from "@/lib/options/types";

// CONVEXITY SLEEVE — the third paper sleeve (user-authorized 2026-11-24: "convexity
// with all these tickers. convexity has no cap loss. max investment should be 3k").
// Calibrated on the 22-month swarm study (5,325 real ladder positions): far-OTM
// Friday-expiry contracts bought on strong surges and held ~2 days beat every
// profit-target and trail variant (+$157k at day+2 close vs -$55k at 5x targets),
// with a 29% win rate, 23-loss streaks, and the top 5 positions carrying the whole
// P&L — so the sleeve is sized to survive the droughts: $3,000 premium per position,
// ONE new position per day, TWO concurrent max. The worker's 'convexity' exit mode
// (no stop, no trail, day+2 close / expiry-day 14:00) owns the other side.
// SPX is excluded: the index PAIR's convex kicker already covers index convexity.
const RULES = {
  maxPremium: 3_000, maxPerDay: 1, maxConcurrent: 2,
  minLegPct: 1.5,        // 30-minute directional move that qualifies the fire
  otmTargetPct: 8,       // the study's best depth
  otmFallbackPct: 4,     // second-best total when the +8% book has no market
  maxContracts: 250,     // sanity cap on swarm size
  // USER EXTRA SWARM (user call 2026-11-25: "I want another swarm that will be less
  // than 20c ... it should meet all the conditions for a swarm"). A one-off slot the
  // user arms on position_manager_control.convexity_extra = {day, maxPrice}: ONE swarm
  // beyond the daily and concurrent caps on that ET day. Every entry condition still
  // applies (fresh engine fire, 30-min leg, Friday expiry, live two-sided book); the
  // contract must cost at most maxPrice and sit inside the depth band the swarm and
  // lottery studies actually measured, and never on a name that already has a swarm
  // open. No qualifying fire = no trade; the slot expires with the day.
  extraMinOtmPct: 4, extraMaxOtmPct: 15,
} as const;

function etNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" }).formatToParts(new Date()).map(part => [part.type, part.value]));
  return { dateKey: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute), weekday: String(parts.weekday) };
}

// Nearest Friday at least 3 calendar days out (the study's 3-7 DTE window: Mon->4,
// Tue->3; Wed/Thu/Fri roll to next week's Friday so a day+2 hold never collides
// with expiry morning).
function pickExpiry(dateKey: string): { expiration: string; dte: number } {
  const base = new Date(`${dateKey}T12:00:00Z`);
  for (let ahead = 3; ahead <= 10; ahead++) {
    const candidate = new Date(base.getTime() + ahead * 86_400_000);
    if (candidate.getUTCDay() === 5) return { expiration: candidate.toISOString().slice(0, 10), dte: ahead };
  }
  throw new Error("no Friday found within 10 days"); // unreachable
}

export async function runConvexityEntry(snapshot: CommandCenter | null, underlying: string): Promise<{ entered: string | null; skipped?: string }> {
  try {
    return await evaluate(snapshot, underlying);
  } catch (error) {
    // Fail loud (silent-failure doctrine): an exception while a qualified fire is
    // live is an incident, not a quiet miss.
    const message = error instanceof Error ? error.message : String(error);
    const signal = snapshot?.signal;
    if (signal && ["enter_call", "enter_put"].includes(signal.action)) {
      const { data: owner } = await createAdminClient().from("profiles").select("id").limit(1).maybeSingle();
      if (owner) await createAlert({
        userId: owner.id, eventKey: `convexity-entry-error-${signal.id}`, severity: "critical",
        title: `Convexity sleeve hit an unexpected error on a live ${underlying} fire`,
        body: `The convexity lane could not process a qualified ${underlying} fire: ${message.slice(0, 250)}. No order was placed.`,
        metadata: { kind: "convexity_entry_error", underlying, signalId: signal.id, error: message },
      }).catch(() => undefined);
    }
    return { entered: null, skipped: `error: ${message.slice(0, 160)}` };
  }
}

async function evaluate(snapshot: CommandCenter | null, underlying: string): Promise<{ entered: string | null; skipped?: string }> {
  const signal = snapshot?.signal;
  if (!signal || !["enter_call", "enter_put"].includes(signal.action)) return { entered: null };
  if (Date.now() - signal.generatedAt > 120_000) return { entered: null, skipped: "stale signal" };
  if (underlying === "SPX") return { entered: null, skipped: "SPX convexity rides the PAIR kicker" };
  const admin = createAdminClient();
  const { data: owner } = await admin.from("profiles").select("id").limit(1).maybeSingle();
  if (!owner) return { entered: null };
  const settings = await loadRiskSettings(owner.id);
  if (!settings.autoEntriesEnabled || !settings.paperTradingEnabled) return { entered: null, skipped: "autonomy off" };
  const { data: control } = await admin.from("position_manager_control").select("kill_switch,convexity_extra").eq("id", true).single();
  if (control?.kill_switch) return { entered: null, skipped: "kill switch" };
  // One convexity order per signal, ever.
  const { data: existing } = await admin.from("paper_trade_orders").select("id").eq("client_order_id", convClientId(signal.id)).limit(1).maybeSingle();
  if (existing) return { entered: null, skipped: "signal already swarmed" };
  // Surge strength: the 30-minute directional leg must clear the study's floor.
  const bars = snapshot?.market?.bars ?? [];
  const dir = signal.action === "enter_call" ? 1 : -1;
  if (bars.length < 31) return { entered: null, skipped: "not enough bars for the 30-min leg check" };
  const legPct = (bars[bars.length - 1].close / bars[bars.length - 31].close - 1) * 100 * dir;
  if (legPct < RULES.minLegPct) return { entered: null, skipped: `30-min leg ${legPct.toFixed(2)}% below the ${RULES.minLegPct}% floor` };
  // Budget: one new swarm per day, two concurrent max (classified by strategy, so
  // the equity/index sleeves never share slots with this lane).
  const et = etNow();
  const [{ data: todayRows }, { data: recentRows }, { data: dayStamp }, trading] = await Promise.all([
    admin.from("paper_trade_orders").select("id,risk_snapshot").eq("action", "buy_to_open").eq("risk_snapshot->>strategy", "convexity-swarm").gte("created_at", `${et.dateKey}T00:00:00-05:00`).neq("status", "rejected"),
    admin.from("paper_trade_orders").select("contract_ticker").eq("action", "buy_to_open").eq("risk_snapshot->>strategy", "convexity-swarm").gte("created_at", new Date(Date.now() - 14 * 86_400_000).toISOString()),
    admin.from("lottery_day_stamps").select("armed,prob").eq("day", et.dateKey).maybeSingle(),
    getPaperTradingState(),
  ]);
  // Lottery-armed days widen the daily budget to 2 swarms (user call 2026-11-24: the
  // detector acts automatically on paper). Rationale: monsters arrive in litters —
  // 11/19 alone birthed ten 10x+ contracts — and the armed top-20% of unseen 2026
  // days carried 59% of all penny-swarm profit.
  const armedDay = Boolean(dayStamp?.armed);
  const maxToday = armedDay ? 2 : RULES.maxPerDay;
  const openSymbols = new Set(trading.positions.map(position => `O:${position.symbol}`));
  const concurrent = new Set((recentRows ?? []).map(row => String(row.contract_ticker)).filter(ticker => openSymbols.has(ticker)));
  const overDaily = (todayRows?.length ?? 0) >= maxToday;
  const overConcurrent = concurrent.size >= RULES.maxConcurrent;
  const extraOrder = (control as { convexity_extra?: { day?: string; maxPrice?: number } | null } | null)?.convexity_extra ?? null;
  const extraSpent = (todayRows ?? []).some(row => (row.risk_snapshot as { userExtra?: boolean } | null)?.userExtra === true);
  const extraMaxPrice = extraOrder?.day === et.dateKey && !extraSpent && Number(extraOrder?.maxPrice) > 0 ? Number(extraOrder.maxPrice) : null;
  const usingExtra = (overDaily || overConcurrent) && extraMaxPrice != null;
  if (overDaily && !usingExtra) return { entered: null, skipped: `convexity budget: ${todayRows?.length} swarm(s) already opened today${armedDay ? " (armed-day cap 2)" : ""}` };
  if (overConcurrent && !usingExtra) return { entered: null, skipped: `convexity budget: ${concurrent.size} swarms already open` };
  // OCC tickers are O:<ROOT><yymmdd><C|P><strike>; a root match followed by a digit is this name.
  if (usingExtra && [...concurrent].some(ticker => ticker.startsWith(`O:${underlying}`) && /\d/.test(ticker.charAt(2 + underlying.length)))) return { entered: null, skipped: `user extra swarm: ${underlying} already has a swarm open — waiting for a different name` };
  // Pick the contract: nearest Friday >= 3 days out, strike nearest the +8% OTM
  // target (fallback +4%) with a real two-sided market. Quality `eligible` screens
  // are deliberately not used — they structurally reject every cheap far-OTM
  // contract (the kicker's lesson); a live two-sided book is the screen here.
  const spot = snapshot?.spotPrice ?? signal.market.price;
  if (!spot || spot <= 0) return { entered: null, skipped: "no spot price" };
  const { expiration, dte } = pickExpiry(et.dateKey);
  const chain = await alpacaChainRows(underlying as Underlying, expiration, dte);
  const side = signal.action === "enter_call" ? "call" : "put";
  const tradeable = chain.filter(row => row.side === side && row.bid > 0 && row.ask > 0
    && row.ask * 100 <= RULES.maxPremium
    && (row.volume >= 10 || row.openInterest >= 25)
    && (side === "call" ? row.strike > spot : row.strike < spot));
  if (!tradeable.length) return { entered: null, skipped: `no tradeable ${side} book for ${underlying} ${expiration}` };
  const otmPctOf = (strike: number) => Math.abs(strike / spot - 1) * 100;
  // The user's extra slot only buys contracts at or under its price cap, with a real
  // (two-tick) bid, inside the studied depth band.
  const pool = usingExtra
    ? tradeable.filter(row => row.ask <= extraMaxPrice && row.bid >= 0.02 && otmPctOf(row.strike) >= RULES.extraMinOtmPct && otmPctOf(row.strike) <= RULES.extraMaxOtmPct)
    : tradeable;
  if (!pool.length) return { entered: null, skipped: `user extra swarm: no ${underlying} ${side} at or under $${(extraMaxPrice ?? 0).toFixed(2)} between ${RULES.extraMinOtmPct}% and ${RULES.extraMaxOtmPct}% out of the money (${expiration})` };
  const nearest = (targetPct: number) => {
    const target = spot * (1 + dir * targetPct / 100);
    return [...pool].sort((a, b) => Math.abs(a.strike - target) - Math.abs(b.strike - target))[0];
  };
  let contract = nearest(RULES.otmTargetPct);
  // If the +8% pick's book is only barely there (one-tick bid), try the +4% rung.
  if (contract.bid < 0.02) contract = nearest(RULES.otmFallbackPct);
  const mid = Math.max(0.01, Number(((contract.bid + contract.ask) / 2).toFixed(2)));
  const limit = usingExtra && extraMaxPrice != null ? Math.min(mid, extraMaxPrice) : mid;
  const quantity = Math.min(RULES.maxContracts, Math.floor(RULES.maxPremium / (limit * 100)));
  if (quantity < 1) return { entered: null, skipped: `pick ${contract.ticker} costs $${(limit * 100).toFixed(0)} — over the $${RULES.maxPremium} budget` };
  const order = await submitPaperOptionOrder({ symbol: contract.ticker, limitPrice: limit, clientOrderId: convClientId(signal.id), quantity });
  const { error: journalError } = await admin.from("paper_trade_orders").insert({
    user_id: owner.id, signal_id: signal.id, alpaca_order_id: order.id, client_order_id: order.client_order_id,
    action: "buy_to_open", underlying, contract_ticker: contract.ticker,
    quantity, order_type: "limit", limit_price: limit, max_debit: limit * quantity * 100, status: order.status,
    risk_snapshot: { autonomous: true, strategy: "convexity-swarm", legPct: Number(legPct.toFixed(2)), spot, otmPct: Number((Math.abs(contract.strike / spot - 1) * 100).toFixed(1)), expiration, dte, ...(usingExtra ? { userExtra: true, maxPrice: extraMaxPrice } : {}) },
    broker_response: order,
  });
  if (journalError) console.error("convexity journal failed", journalError.message);
  await createAlert({
    userId: owner.id, signalId: signal.id, eventKey: `convexity-entry-${order.id}`, severity: "success",
    title: `${usingExtra ? "EXTRA SWARM (your request)" : "CONVEXITY SWARM"}: ${quantity} × ${underlying} ${contract.strike} ${side} (${expiration})`,
    body: `${usingExtra ? `This is the extra swarm you asked for (contract at or under $${(extraMaxPrice ?? 0).toFixed(2)}), taken beyond the usual ${RULES.maxConcurrent}-open limit. ` : ""}${underlying} ran ${legPct.toFixed(1)}% in 30 minutes, so the convexity sleeve bought ${quantity} × ${contract.ticker.replace("O:", "")} at a $${limit.toFixed(2)} limit — about $${(limit * quantity * 100).toFixed(0)} of premium, ${(Math.abs(contract.strike / spot - 1) * 100).toFixed(1)}% out of the money, ${dte} days to expiry. No stop by design: max loss is the premium, exit at day+2 close or 14:00 on expiry day. The swarm study says ~7 of 10 of these die — the monsters pay for them.`,
    metadata: { kind: "convexity_swarm_entry", orderId: order.id, contractTicker: contract.ticker, limitPrice: limit, quantity, legPct, expiration },
  }).catch(error => console.error("convexity alert failed", error));
  return { entered: contract.ticker };
}

const convClientId = (signalId: string) => `velocity-conv-${signalId}`.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48);

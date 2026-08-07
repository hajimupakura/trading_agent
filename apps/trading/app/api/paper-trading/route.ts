import { z } from "zod";
import { getAuthenticatedUser } from "@/lib/supabase/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPaperTradingState, submitPaperOptionOrder } from "@/lib/alpaca/paper";
import { PAPER_RULES, computePositionSize, entryCooldownActive, validatePaperEntry } from "@/lib/alpaca/risk";
import { refreshCommandCenter } from "@/lib/options/command-center";
import { TRADE_UNDERLYINGS, type TradeUnderlying } from "@/lib/options/types";
import {loadRiskSettings} from "@/lib/settings/risk-settings";
import {createAlert} from "@/lib/alerts/server";
import { activeEconomicGuard } from "@/lib/options/economic-calendar";

export const dynamic = "force-dynamic";
const requestSchema = z.object({
  underlying:z.string().min(2).max(8), contractTicker:z.string().min(10),
  signalId:z.string().min(10).optional(), manual:z.boolean().optional(),
  quantity:z.number().int().min(1).max(10).optional(), limitPrice:z.number().min(0.01).max(500).optional(),
}).refine(value => value.manual === true || typeof value.signalId === "string", { message:"signalId required" });

async function entriesToday(userId:string) {
  const now = new Date();
  const dateParts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone:"America/New_York", year:"numeric", month:"2-digit", day:"2-digit" }).formatToParts(now).map(part => [part.type, part.value]));
  const midnightGuess = Date.UTC(Number(dateParts.year), Number(dateParts.month) - 1, Number(dateParts.day));
  const localAtGuess = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone:"America/New_York", year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", second:"2-digit", hourCycle:"h23" }).formatToParts(new Date(midnightGuess)).map(part => [part.type, part.value]));
  const representedAsUtc = Date.UTC(Number(localAtGuess.year), Number(localAtGuess.month) - 1, Number(localAtGuess.day), Number(localAtGuess.hour), Number(localAtGuess.minute), Number(localAtGuess.second));
  const since = new Date(midnightGuess - (representedAsUtc - midnightGuess)).toISOString();
  const { count, error } = await createAdminClient().from("paper_trade_orders").select("id", { count:"exact", head:true }).eq("user_id",userId).eq("action", "buy_to_open").gte("created_at", since).neq("status", "rejected");
  if (error) throw new Error(`Trade journal unavailable: ${error.message}`);
  return count ?? 0;
}

export async function GET() {
  const user=await getAuthenticatedUser();if (!user) return Response.json({ error:"Unauthorized" }, { status:401 });
  try {
    const [state,rules] = await Promise.all([getPaperTradingState(),loadRiskSettings(user.id)]);
    return Response.json({ configured:true, mode:"paper", rules, ...state }, { headers:{ "Cache-Control":"no-store" } });
  } catch (error) {
    return Response.json({ configured:false, mode:"paper", error:error instanceof Error ? error.message : "Paper account unavailable" }, { status:503 });
  }
}

export async function POST(request:Request) {
  const user = await getAuthenticatedUser();
  if (!user) return Response.json({ error:"Unauthorized" }, { status:401 });
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error:"Invalid order approval" }, { status:400 });
  if (parsed.data.underlying === "SPX") {
    return Response.json({ error:"Alpaca retail accounts do not currently support SPX index-option execution. SPX remains analysis-only; use SPY for paper automation or route SPXW through the Robinhood desk." }, { status:422 });
  }
  if (parsed.data.manual) return manualOrder(user.id, parsed.data);
  if (!(TRADE_UNDERLYINGS as readonly string[]).includes(parsed.data.underlying)) return Response.json({ error:"Signal-based approvals are SPY-only; use the contract detail modal for other tickers." }, { status:422 });
  try {
    const settings=await loadRiskSettings(user.id);
    const [scan, trading, tradesToday, {data:control,error:controlError}] = await Promise.all([refreshCommandCenter(parsed.data.underlying as TradeUnderlying,settings), getPaperTradingState(), entriesToday(user.id), createAdminClient().from("position_manager_control").select("kill_switch").eq("id",true).single()]);
    if (controlError) throw new Error(`Manager control unavailable: ${controlError.message}`);
    if (control.kill_switch) return Response.json({ error:"Emergency stop is active. New entries are disabled until you resume the manager; protective exits keep running." }, { status:422 });
    const signal = scan.signal;
    const contract = signal?.contract;
    if (!signal || !contract || signal.id !== parsed.data.signalId || contract.ticker !== parsed.data.contractTicker) {
      return Response.json({ error:"The signal or selected contract changed. Review the refreshed ticket before approving." }, { status:409 });
    }
    const { data:recentExits, error:exitQueryError } = await createAdminClient().from("paper_trade_orders")
      .select("contract_ticker,risk_snapshot,updated_at").eq("user_id",user.id).eq("action","sell_to_close")
      .gte("updated_at", new Date(Date.now() - PAPER_RULES.cooldownMinutes * 60_000).toISOString());
    if (exitQueryError) throw new Error(`Cooldown check unavailable: ${exitQueryError.message}`);
    const cooldown = entryCooldownActive({ action:signal.action, recentExits:(recentExits ?? []).map(row => ({ contractTicker:String(row.contract_ticker), exitReason:(row.risk_snapshot as {exitReason?:string}|null)?.exitReason ?? null, at:String(row.updated_at) })) });
    if (cooldown) return Response.json({ error:`Cooldown active: a ${signal.action === "enter_call" ? "call" : "put"} was stopped out (${cooldown.exitReason.replaceAll("_"," ")}) less than ${PAPER_RULES.cooldownMinutes} minutes ago. Entries in this direction resume at ${cooldown.until.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",timeZone:"America/New_York"})} ET.` }, { status:422 });
    const quantity = computePositionSize({ ask:contract.ask, equity:Number(trading.account.equity), optionsBuyingPower:Number(trading.account.options_buying_power), settings });
    const risk = validatePaperEntry({ signal, contract, ...trading, tradesToday,settings,quantity });
    if (!risk.allowed) return Response.json({ error:"Order blocked by risk controls", reasons:risk.errors }, { status:422 });
    const clientOrderId = `velocity-${signal.id}`.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48);
    // Submit at the midpoint, not the ask — the position worker escalates the limit toward
    // the ask if unfilled and cancels a stale entry, so we stop paying the full spread.
    const entryLimit = Math.max(.01, Number(contract.midpoint.toFixed(2)));
    const order = await submitPaperOptionOrder({ symbol:contract.ticker, limitPrice:entryLimit, clientOrderId, quantity:risk.quantity });
    await createAlert({userId:user.id,signalId:signal.id,eventKey:`paper-entry-${order.id}`,severity:"success",title:"Paper entry submitted",body:`BUY ${risk.quantity} ${contract.ticker} at a $${entryLimit.toFixed(2)} midpoint limit (ask $${contract.ask.toFixed(2)}) · maximum debit $${risk.debit.toFixed(0)}`,metadata:{orderId:order.id,contractTicker:contract.ticker,limitPrice:entryLimit,maxDebit:risk.debit,quantity:risk.quantity,status:order.status}}).catch(error=>console.error("Entry alert failed",error));
    const { error:journalError } = await createAdminClient().from("paper_trade_orders").insert({
      user_id:user.id, signal_id:signal.id, alpaca_order_id:order.id, client_order_id:order.client_order_id,
      action:"buy_to_open", underlying:parsed.data.underlying, contract_ticker:contract.ticker,
      quantity:risk.quantity, order_type:"limit", limit_price:entryLimit, max_debit:risk.debit, status:order.status,
      risk_snapshot:{ equity:risk.equity, dayPnl:risk.dayPnl, rules:settings,systemCaps:PAPER_RULES }, broker_response:order,
    });
    if (journalError) return Response.json({ ok:true, warning:"Order was submitted, but journal persistence failed", order, detail:journalError.message });
    return Response.json({ ok:true, order });
  } catch (error) {
    return Response.json({ error:error instanceof Error ? error.message : "Paper order failed" }, { status:502 });
  }
}

// Manual leaderboard execution: a contract picked from the monitor snapshot, no signal.
// Gates: kill switch, market hours, paper enabled, debit caps, buying power, daily trade cap.
async function manualOrder(userId:string, input:{ underlying:string; contractTicker:string; quantity?:number; limitPrice?:number }) {
  try {
    const admin = createAdminClient();
    const [settings, trading, tradesToday, {data:control,error:controlError}, {data:snapshot}] = await Promise.all([
      loadRiskSettings(userId), getPaperTradingState(), entriesToday(userId),
      admin.from("position_manager_control").select("kill_switch").eq("id",true).single(),
      admin.from("options_monitor_snapshots").select("payload,updated_at").eq("underlying",input.underlying).maybeSingle(),
    ]);
    if (controlError) throw new Error(`Manager control unavailable: ${controlError.message}`);
    if (control.kill_switch) return Response.json({ error:"Emergency stop is active — new entries are disabled." }, { status:422 });
    if (!settings.paperTradingEnabled) return Response.json({ error:"Paper entries are disabled in risk settings" }, { status:422 });
    const payload = snapshot?.payload as { asOf?:number; contracts?:Array<Record<string, unknown>> } | undefined;
    const contract = payload?.contracts?.find(item => item.ticker === input.contractTicker) as { ticker:string; ask:number; bid:number; midpoint:number; expirationDate:string } | undefined;
    if (!contract || !payload?.asOf || Date.now() - payload.asOf > 10 * 60_000) {
      return Response.json({ error:"Contract not found in a fresh scan — refresh and try again." }, { status:409 });
    }
    const clock = new Intl.DateTimeFormat("en-US",{ timeZone:"America/New_York", hour:"2-digit", minute:"2-digit", weekday:"short", hourCycle:"h23" }).formatToParts(new Date());
    const value = Object.fromEntries(clock.map(part => [part.type, part.value]));
    const minutes = Number(value.hour) * 60 + Number(value.minute);
    if (["Sat","Sun"].includes(String(value.weekday)) || minutes < 570 || minutes >= 960) {
      return Response.json({ error:"Manual orders are limited to regular market hours (09:30-16:00 ET)." }, { status:422 });
    }
    if (settings.economicGuardEnabled) {
      const guard = activeEconomicGuard();
      if (guard) return Response.json({ error:`Economic event guard: ${guard.name} (${guard.releaseLabel}) — entries resume ${guard.resumesAt}. Disable the guard in Settings to override.` }, { status:422 });
    }
    const quantity = Math.max(1, Math.floor(input.quantity ?? 1));
    const limitPrice = Number((input.limitPrice ?? contract.midpoint ?? contract.ask).toFixed(2));
    if (!(limitPrice > 0)) return Response.json({ error:"A positive limit price is required." }, { status:422 });
    const debit = quantity * limitPrice * 100;
    const equity = Number(trading.account.equity);
    const errors:string[] = [];
    if (debit > settings.maxTradeDebit) errors.push(`Total debit $${debit.toFixed(0)} exceeds the $${settings.maxTradeDebit.toFixed(0)} per-trade limit`);
    if (Number.isFinite(equity) && debit > equity * (settings.maxEquityDebitPct / 100)) errors.push(`Total debit exceeds ${settings.maxEquityDebitPct}% of account equity`);
    if (debit > Number(trading.account.options_buying_power)) errors.push("Insufficient options buying power");
    if (tradesToday >= settings.maxTradesPerDay) errors.push(`Maximum ${settings.maxTradesPerDay} entries per day reached`);
    if (errors.length) return Response.json({ error:"Order blocked by risk controls", reasons:errors }, { status:422 });
    const clientOrderId = `velocity-manual-${Date.now()}`.slice(0, 48);
    const order = await submitPaperOptionOrder({ symbol:contract.ticker, limitPrice, clientOrderId, quantity });
    await createAlert({ userId, eventKey:`paper-entry-${order.id}`, severity:"success", title:"Manual paper entry submitted", body:`BUY ${quantity} ${contract.ticker} at a $${limitPrice.toFixed(2)} limit · maximum debit $${debit.toFixed(0)} · picked from the leaderboard`, metadata:{ orderId:order.id, contractTicker:contract.ticker, limitPrice, quantity, manual:true } }).catch(error => console.error("Manual entry alert failed", error));
    const { error:journalError } = await createAdminClient().from("paper_trade_orders").insert({
      user_id:userId, signal_id:null, alpaca_order_id:order.id, client_order_id:order.client_order_id,
      action:"buy_to_open", underlying:input.underlying, contract_ticker:contract.ticker,
      quantity, order_type:"limit", limit_price:limitPrice, max_debit:debit, status:order.status,
      risk_snapshot:{ manual:true, equity, rules:settings }, broker_response:order,
    });
    if (journalError) return Response.json({ ok:true, warning:"Order was submitted, but journal persistence failed", order, detail:journalError.message });
    return Response.json({ ok:true, order });
  } catch (error) {
    return Response.json({ error:error instanceof Error ? error.message : "Manual paper order failed" }, { status:502 });
  }
}

import { z } from "zod";
import { getAuthenticatedUser } from "@/lib/supabase/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPaperTradingState, submitPaperOptionOrder } from "@/lib/alpaca/paper";
import { PAPER_RULES, validatePaperEntry } from "@/lib/alpaca/risk";
import { refreshCommandCenter } from "@/lib/options/command-center";
import {loadRiskSettings} from "@/lib/settings/risk-settings";

export const dynamic = "force-dynamic";
const requestSchema = z.object({ underlying:z.enum(["SPY","SPX"]), contractTicker:z.string().min(10), signalId:z.string().min(10) });

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
    return Response.json({ error:"Alpaca retail accounts do not currently support SPX index-option execution. SPX remains analysis-only; use SPY for paper automation." }, { status:422 });
  }
  try {
    const settings=await loadRiskSettings(user.id);
    const [scan, trading, tradesToday] = await Promise.all([refreshCommandCenter(parsed.data.underlying,settings), getPaperTradingState(), entriesToday(user.id)]);
    const signal = scan.signal;
    const contract = signal?.contract;
    if (!signal || !contract || signal.id !== parsed.data.signalId || contract.ticker !== parsed.data.contractTicker) {
      return Response.json({ error:"The signal or selected contract changed. Review the refreshed ticket before approving." }, { status:409 });
    }
    const risk = validatePaperEntry({ signal, contract, ...trading, tradesToday,settings });
    if (!risk.allowed) return Response.json({ error:"Order blocked by risk controls", reasons:risk.errors }, { status:422 });
    const clientOrderId = `velocity-${signal.id}`.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48);
    const order = await submitPaperOptionOrder({ symbol:contract.ticker, limitPrice:contract.ask, clientOrderId });
    const { error:journalError } = await createAdminClient().from("paper_trade_orders").insert({
      user_id:user.id, signal_id:signal.id, alpaca_order_id:order.id, client_order_id:order.client_order_id,
      action:"buy_to_open", underlying:parsed.data.underlying, contract_ticker:contract.ticker,
      quantity:1, order_type:"limit", limit_price:contract.ask, max_debit:risk.debit, status:order.status,
      risk_snapshot:{ equity:risk.equity, dayPnl:risk.dayPnl, rules:settings,systemCaps:PAPER_RULES }, broker_response:order,
    });
    if (journalError) return Response.json({ ok:true, warning:"Order was submitted, but journal persistence failed", order, detail:journalError.message });
    return Response.json({ ok:true, order });
  } catch (error) {
    return Response.json({ error:error instanceof Error ? error.message : "Paper order failed" }, { status:502 });
  }
}

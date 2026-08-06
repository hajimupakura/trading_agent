import { createClient } from "@supabase/supabase-js";
import { config } from "./config.js";
import type { AlpacaOrder, ManagedPosition, SignalMarket } from "./types.js";

const db = createClient(config.supabaseUrl,config.SUPABASE_SECRET_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
export async function getControl() {
  const { data,error } = await db.from("position_manager_control").select("auto_exits_enabled,kill_switch").eq("id",true).single();
  if (error) throw error; return data;
}
export async function getManagedPosition(alpacaSymbol:string,entryPrice:number,orders:AlpacaOrder[]):Promise<ManagedPosition|null> {
  const ticker = `O:${alpacaSymbol}`;
  const { data:entry, error } = await db.from("paper_trade_orders").select("user_id,signal_id,alpaca_order_id,created_at").eq("contract_ticker",ticker).eq("action","buy_to_open").order("created_at",{ascending:false}).limit(1).maybeSingle();
  if (error) throw error; if (!entry) return null;
  const [{data:signal,error:signalError},{data:state,error:stateError}] = await Promise.all([
    db.from("option_signals").select("action,market_snapshot").eq("signal_id",entry.signal_id).single(),
    db.from("paper_position_monitors").select("peak_bid,opened_at,close_order_id,close_order_submitted_at").eq("contract_ticker",ticker).maybeSingle(),
  ]);
  if (signalError) throw signalError; if (stateError) throw stateError;
  const brokerEntry = orders.find(order => order.id === entry.alpaca_order_id);
  return { ticker,alpacaSymbol,side:signal.action === "enter_put" ? "put":"call",quantity:1,entryPrice,
    peakBid:Number(state?.peak_bid ?? entryPrice),openedAt:Date.parse(state?.opened_at ?? brokerEntry?.filled_at ?? entry.created_at),signalId:entry.signal_id,userId:entry.user_id,
    market:signal.market_snapshot as SignalMarket,closeOrderId:state?.close_order_id ?? null,closeOrderSubmittedAt:state?.close_order_submitted_at ? Date.parse(state.close_order_submitted_at):null };
}
export async function saveMonitor(position:ManagedPosition,input:{bid:number;ask:number;quoteAt:number;status:string;exitReason?:string|null;closeOrderId?:string|null;error?:string|null}) {
  const { error } = await db.from("paper_position_monitors").upsert({ contract_ticker:position.ticker,user_id:position.userId,signal_id:position.signalId,status:input.status,entry_price:position.entryPrice,peak_bid:position.peakBid,latest_bid:input.bid,latest_ask:input.ask,opened_at:new Date(position.openedAt).toISOString(),last_quote_at:new Date(input.quoteAt).toISOString(),exit_reason:input.exitReason ?? null,close_order_id:input.closeOrderId ?? position.closeOrderId,last_error:input.error ?? null,updated_at:new Date().toISOString() });
  if (error) throw error;
}
export async function markMissingPositions(openTickers:string[]) {
  const { data,error } = await db.from("paper_position_monitors").select("contract_ticker").in("status",["monitoring","closing","error"]);
  if (error) throw error; const missing = (data ?? []).map(row=>row.contract_ticker).filter(ticker=>!openTickers.includes(ticker));
  if (missing.length) { const {error:updateError}=await db.from("paper_position_monitors").update({status:"closed",updated_at:new Date().toISOString()}).in("contract_ticker",missing); if(updateError) throw updateError; }
}
export async function journalExit(position:ManagedPosition,order:AlpacaOrder,limitPrice:number,reason:string) {
  const { error } = await db.from("paper_trade_orders").upsert({ user_id:position.userId,signal_id:position.signalId,alpaca_order_id:order.id,client_order_id:order.client_order_id,action:"sell_to_close",underlying:position.ticker.startsWith("O:SPX")?"SPX":"SPY",contract_ticker:position.ticker,quantity:position.quantity,order_type:"limit",limit_price:limitPrice,max_debit:null,status:order.status,risk_snapshot:{exitReason:reason,entryPrice:position.entryPrice,peakBid:position.peakBid},broker_response:order },{onConflict:"alpaca_order_id"});
  if (error) throw error;
}
export async function heartbeat(input:{healthy:boolean;positions:number;lastError:string|null}) {
  const { error } = await db.from("position_manager_status").upsert({ id:config.MANAGER_INSTANCE_ID,enabled:config.exitsEnabled,healthy:input.healthy,managed_positions:input.positions,last_error:input.lastError,last_heartbeat:new Date().toISOString(),updated_at:new Date().toISOString() });
  if (error) throw error;
}

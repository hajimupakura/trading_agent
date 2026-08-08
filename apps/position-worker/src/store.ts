import { createClient } from "@supabase/supabase-js";
import { config } from "./config.js";
import { dteFromOcc } from "./exit-engine.js";
import type { AlpacaOrder, ManagedPosition, SignalMarket } from "./types.js";

const db = createClient(config.supabaseUrl,config.SUPABASE_SECRET_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
export async function getControl() {
  const { data,error } = await db.from("position_manager_control").select("auto_exits_enabled,kill_switch,auto_adopt_unmanaged").eq("id",true).single();
  if (error) throw new Error(`db error: ${error.message}`); return data;
}
// Adopt a broker position that has no journal entry (bought directly in Alpaca):
// synthesize the buy_to_open row so getManagedPosition picks it up with the broker's
// average fill as the entry price. Standard stop/trail rules apply from there.
export async function adoptBrokerPosition(alpacaSymbol:string,entryPrice:number,quantity:number):Promise<string|null> {
  const { data:owner,error:ownerError } = await db.from("profiles").select("id").limit(1).maybeSingle();
  if (ownerError) throw ownerError; if (!owner) return null;
  const root = alpacaSymbol.replace(/\d{6}[CP]\d{8}$/,"");
  const { error } = await db.from("paper_trade_orders").insert({
    user_id:owner.id, signal_id:null, alpaca_order_id:`adopted-${alpacaSymbol}-${Date.now()}`,
    client_order_id:`velocity-adopted-${Date.now()}`.slice(0,48), action:"buy_to_open",
    underlying:root === "SPXW" ? "SPX" : root, contract_ticker:`O:${alpacaSymbol}`,
    quantity, order_type:"limit", limit_price:entryPrice, max_debit:entryPrice*quantity*100,
    status:"filled", risk_snapshot:{ adopted:true }, broker_response:{ adopted:true },
  });
  // Postgrest errors are plain objects — wrap them so cycle logs carry the message.
  if (error) throw new Error(`adoption insert failed: ${error.message ?? JSON.stringify(error)}`);
  return owner.id;
}
export async function getManagedPosition(alpacaSymbol:string,entryPrice:number,orders:AlpacaOrder[]):Promise<ManagedPosition|null> {
  const ticker = `O:${alpacaSymbol}`;
  const { data:entry, error } = await db.from("paper_trade_orders").select("user_id,signal_id,alpaca_order_id,created_at").eq("contract_ticker",ticker).eq("action","buy_to_open").order("created_at",{ascending:false}).limit(1).maybeSingle();
  if (error) throw new Error(`db error: ${error.message}`); if (!entry) return null;
  const [{data:signal,error:signalError},{data:state,error:stateError}] = await Promise.all([
    entry.signal_id ? db.from("option_signals").select("action,market_snapshot").eq("signal_id",entry.signal_id).maybeSingle() : Promise.resolve({data:null,error:null} as {data:null,error:null}),
    db.from("paper_position_monitors").select("peak_bid,opened_at,close_order_id,close_order_submitted_at,exit_mode").eq("contract_ticker",ticker).maybeSingle(),
  ]);
  if (signalError) throw signalError; if (stateError) throw stateError;
  const brokerEntry = orders.find(order => order.id === entry.alpaca_order_id);
  const occSide = /\d{6}P\d{8}$/.test(alpacaSymbol) ? "put" : "call";
  // Manual entries have no signal row: side comes from the OCC symbol and the market
  // context is neutral (infinite range) so invalidation can never trigger.
  const market = (signal?.market_snapshot as SignalMarket|undefined) ?? { openingRangeHigh:Number.NEGATIVE_INFINITY, openingRangeLow:Number.POSITIVE_INFINITY, referencePrice:0, chartSymbol:alpacaSymbol.replace(/\d{6}[CP]\d{8}$/,"") };
  return { ticker,alpacaSymbol,side:signal ? (signal.action === "enter_put" ? "put":"call") : occSide,quantity:1,entryPrice,
    peakBid:Number(state?.peak_bid ?? entryPrice),openedAt:Date.parse(state?.opened_at ?? brokerEntry?.filled_at ?? entry.created_at),signalId:entry.signal_id,userId:entry.user_id,
    market,closeOrderId:state?.close_order_id ?? null,closeOrderSubmittedAt:state?.close_order_submitted_at ? Date.parse(state.close_order_submitted_at):null,
    // First sighting (no monitor row yet): 3+ day contracts are swings, not scalps —
    // they default to trend (RIDE) automatically. Existing rows keep their stored mode.
    exitMode:state ? (state.exit_mode === "trend" ? "trend" : "burst") : ((dteFromOcc(alpacaSymbol) ?? 0) >= 3 ? "trend" : "burst") };
}
export async function saveMonitor(position:ManagedPosition,input:{bid:number;ask:number;quoteAt:number;status:string;exitReason?:string|null;closeOrderId?:string|null;error?:string|null}) {
  const { error } = await db.from("paper_position_monitors").upsert({ contract_ticker:position.ticker,user_id:position.userId,signal_id:position.signalId,status:input.status,entry_price:position.entryPrice,peak_bid:position.peakBid,latest_bid:input.bid,latest_ask:input.ask,opened_at:new Date(position.openedAt).toISOString(),last_quote_at:new Date(input.quoteAt).toISOString(),exit_reason:input.exitReason ?? null,close_order_id:input.closeOrderId ?? position.closeOrderId,last_error:input.error ?? null,exit_mode:position.exitMode,updated_at:new Date().toISOString() });
  if (error) throw new Error(`monitor save failed for ${position.ticker}: ${error.message}`);
}
export async function markMissingPositions(openTickers:string[],orders:AlpacaOrder[]) {
  const { data,error } = await db.from("paper_position_monitors").select("contract_ticker,user_id,signal_id,close_order_id,entry_price").in("status",["monitoring","closing","error"]);
  if (error) throw new Error(`db error: ${error.message}`); const missing = (data ?? []).filter(row=>!openTickers.includes(row.contract_ticker));
  if (missing.length) { const tickers=missing.map(row=>row.contract_ticker);const {error:updateError}=await db.from("paper_position_monitors").update({status:"closed",updated_at:new Date().toISOString()}).in("contract_ticker",tickers); if(updateError) throw updateError;
    for(const row of missing){const symbol=String(row.contract_ticker).replace(/^O:/,"");const filled=orders.find(order=>order.symbol===symbol&&order.side==="sell"&&order.status==="filled");if(!filled)continue;const fill=Number(filled.filled_avg_price??filled.limit_price??0);const {error:orderError}=await db.from("paper_trade_orders").update({status:filled.status,limit_price:fill||Number(filled.limit_price),broker_response:filled,updated_at:new Date().toISOString()}).eq("alpaca_order_id",filled.id);if(orderError)throw orderError;await createWorkerAlert({userId:row.user_id,signalId:row.signal_id,eventKey:`paper-exit-filled-${filled.id}`,severity:"success",title:"Paper exit filled",body:`SELL ${filled.qty} ${symbol} filled near $${fill.toFixed(2)}. The position is closed.`,metadata:{orderId:filled.id,contractTicker:row.contract_ticker,fillPrice:fill,entryPrice:Number(row.entry_price)}});}
  }
}
export async function journalExit(position:ManagedPosition,order:AlpacaOrder,limitPrice:number,reason:string) {
  const exitRoot = position.alpacaSymbol.replace(/\d{6}[CP]\d{8}$/,"");
  const { error } = await db.from("paper_trade_orders").upsert({ user_id:position.userId,signal_id:position.signalId,alpaca_order_id:order.id,client_order_id:order.client_order_id,action:"sell_to_close",underlying:exitRoot==="SPXW"?"SPX":exitRoot,contract_ticker:position.ticker,quantity:position.quantity,order_type:"limit",limit_price:limitPrice,max_debit:null,status:order.status,risk_snapshot:{exitReason:reason,entryPrice:position.entryPrice,peakBid:position.peakBid},broker_response:order },{onConflict:"alpaca_order_id"});
  if (error) throw new Error(`db error: ${error.message}`);
}
export async function updateEntryJournal(alpacaOrderId:string,fields:{status?:string;limit_price?:number;alpaca_order_id?:string}) {
  const { error } = await db.from("paper_trade_orders").update({ ...fields, updated_at:new Date().toISOString() }).eq("alpaca_order_id",alpacaOrderId);
  if (error) throw new Error(`db error: ${error.message}`);
}
export async function getEntryJournal(alpacaOrderId:string):Promise<{user_id:string;signal_id:string;created_at:string}|null> {
  const { data, error } = await db.from("paper_trade_orders").select("user_id,signal_id,created_at").eq("alpaca_order_id",alpacaOrderId).eq("action","buy_to_open").maybeSingle();
  if (error) throw new Error(`db error: ${error.message}`); return data;
}
export async function heartbeat(input:{healthy:boolean;positions:number;lastError:string|null}) {
  const { error } = await db.from("position_manager_status").upsert({ id:config.MANAGER_INSTANCE_ID,enabled:config.exitsEnabled,healthy:input.healthy,managed_positions:input.positions,last_error:input.lastError,last_heartbeat:new Date().toISOString(),updated_at:new Date().toISOString() });
  if (error) throw new Error(`db error: ${error.message}`);
}
export async function createWorkerAlert(input:{userId:string;signalId?:string|null;eventKey:string;severity:"info"|"success"|"warning"|"critical";title:string;body:string;metadata?:Record<string,unknown>}) {
  const {error}=await db.from("alerts").insert({user_id:input.userId,signal_id:input.signalId??null,channel:"in_app",event_key:input.eventKey,severity:input.severity,title:input.title,body:input.body,metadata:input.metadata??{}});
  if(error&&error.code!=="23505")throw new Error(`db error: ${error.message}`);
}

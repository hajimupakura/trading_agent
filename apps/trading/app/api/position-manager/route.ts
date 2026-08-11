import { z } from "zod";
import { getAuthenticatedUser } from "@/lib/supabase/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import {createAlert} from "@/lib/alerts/server";
import {getPaperTradingState,getRecentPaperOrders} from "@/lib/alpaca/paper";

export const dynamic = "force-dynamic";
async function state(userId:string) {
  const admin = createAdminClient();
  const [{data:control,error:controlError},{data:statuses,error:statusError},{data:monitors,error:monitorError},{data:recentBuys},paper] = await Promise.all([
    admin.from("position_manager_control").select("auto_exits_enabled,kill_switch,auto_adopt_unmanaged,updated_at").eq("id",true).single(),
    admin.from("position_manager_status").select("enabled,healthy,managed_positions,last_error,last_heartbeat").order("last_heartbeat",{ascending:false}).limit(1),
    admin.from("paper_position_monitors").select("contract_ticker,status,exit_mode").eq("user_id",userId).in("status",["monitoring","closing","error"]),
    // App-opened positions awaiting their first worker check-in must not trip the
    // "not protected" alarm — a fresh fill is unmanaged for only a few seconds.
    admin.from("paper_trade_orders").select("contract_ticker").eq("user_id",userId).eq("action","buy_to_open").gte("created_at",new Date(Date.now()-30*60_000).toISOString()),
    getPaperTradingState(),
  ]);
  if (controlError) throw controlError; if (statusError) throw statusError; if (monitorError) throw monitorError;
  const status = statuses?.[0] ?? null; const heartbeatAge = status ? Date.now()-Date.parse(status.last_heartbeat):Infinity;
  const appOpened = new Set((recentBuys??[]).map(row=>String(row.contract_ticker).replace(/^O:/,"")));
  const managed = new Set([...(monitors??[]).map(row=>String(row.contract_ticker).replace(/^O:/,"")),...appOpened]);
  const exitModes = new Map((monitors??[]).map(row=>[String(row.contract_ticker).replace(/^O:/,""),String(row.exit_mode ?? "burst")]));
  const brokerPositions=paper.positions.map(position=>({symbol:position.symbol,quantity:Number(position.qty),managed:managed.has(position.symbol),exitMode:exitModes.get(position.symbol)??null}));
  return { control,status,online:Boolean(status?.healthy && heartbeatAge<30_000),heartbeatAgeMs:Number.isFinite(heartbeatAge)?heartbeatAge:null,brokerPositions,unmanagedPositions:brokerPositions.filter(position=>!position.managed) };
}
async function reconcileExitAlerts(userId:string){const admin=createAdminClient();const [{data:monitors,error:monitorError},{data:journals,error:journalError},orders]=await Promise.all([admin.from("paper_position_monitors").select("contract_ticker,signal_id,status,last_error,close_order_id,exit_reason,latest_bid,updated_at").eq("user_id",userId).in("status",["closing","error"]),admin.from("paper_trade_orders").select("alpaca_order_id,signal_id,contract_ticker,status,limit_price").eq("user_id",userId).eq("action","sell_to_close").order("created_at",{ascending:false}).limit(50),getRecentPaperOrders()]);if(monitorError)throw monitorError;if(journalError)throw journalError;for(const monitor of monitors??[]){if(monitor.status==="error")await createAlert({userId,signalId:monitor.signal_id,eventKey:`monitor-error-${userId}-${monitor.contract_ticker}-${String(monitor.updated_at).slice(0,13)}`,severity:"critical",title:"Automatic exit monitoring error",body:`${monitor.contract_ticker}: ${monitor.last_error??"unknown monitoring failure"}. Check Alpaca immediately.`,metadata:monitor});}
  for(const journal of journals??[]){const order=orders.find(item=>item.id===journal.alpaca_order_id);const status=order?.status??journal.status;const fill=Number(order?.filled_avg_price??order?.limit_price??journal.limit_price);const failed=["rejected","canceled","expired","suspended"].includes(status);const filled=status==="filled";await createAlert({userId,signalId:journal.signal_id,eventKey:`paper-exit-${status}-${journal.alpaca_order_id}`,severity:failed?"critical":filled?"success":"warning",title:failed?"Paper exit needs attention":filled?"Paper exit filled":"Paper exit working",body:failed?`SELL ${journal.contract_ticker} is ${status}. Check Alpaca immediately.`:filled?`SELL ${journal.contract_ticker} filled near $${fill.toFixed(2)}. The position is closed.`:`SELL ${journal.contract_ticker} is ${status} near $${fill.toFixed(2)}.`,metadata:{orderId:journal.alpaca_order_id,contractTicker:journal.contract_ticker,status,fillPrice:Number.isFinite(fill)?fill:null}});if(order&&order.status!==journal.status){const {error}=await admin.from("paper_trade_orders").update({status:order.status,limit_price:Number.isFinite(fill)&&fill>0?fill:journal.limit_price,broker_response:order,updated_at:new Date().toISOString()}).eq("alpaca_order_id",journal.alpaca_order_id);if(error)throw error;}}
}
export async function GET() {
  const user=await getAuthenticatedUser();if (!user) return Response.json({error:"Unauthorized"},{status:401});
  try { const result=await state(user.id);if(!result.online)await createAlert({userId:user.id,eventKey:`manager-offline-${user.id}-${new Date().toISOString().slice(0,10)}`,severity:"critical",title:"Automatic exit manager offline",body:`Railway is not reporting a healthy heartbeat${result.status?.last_error?`: ${result.status.last_error}`:". Manage any open Alpaca positions manually."}`,metadata:{heartbeatAgeMs:result.heartbeatAgeMs,lastHeartbeat:result.status?.last_heartbeat??null,lastError:result.status?.last_error??null}});for(const position of result.unmanagedPositions)await createAlert({userId:user.id,eventKey:`unmanaged-paper-position-${user.id}-${position.symbol}`,severity:"critical",title:"Paper position is not protected",body:`${position.quantity} × ${position.symbol} was not opened through this app. Automatic exit rules do not cover it; manage it directly in Alpaca.`,metadata:{contractTicker:`O:${position.symbol}`,quantity:position.quantity}});await reconcileExitAlerts(user.id);return Response.json(result,{headers:{"Cache-Control":"no-store"}}); }
  catch(error){ return Response.json({error:error instanceof Error?error.message:"Manager unavailable"},{status:503}); }
}
export async function POST(request:Request) {
  const user=await getAuthenticatedUser();
  if (!user) return Response.json({error:"Unauthorized"},{status:401});
  const parsed=z.object({killSwitch:z.boolean().optional(),autoAdopt:z.boolean().optional(),exitMode:z.object({symbol:z.string().min(6),mode:z.enum(["burst","trend"])}).optional()}).refine(value=>value.killSwitch!==undefined||value.autoAdopt!==undefined||value.exitMode!==undefined,{message:"No control field provided"}).safeParse(await request.json().catch(()=>null));
  if(!parsed.success) return Response.json({error:"Invalid control request"},{status:400});
  const admin=createAdminClient();
  if(parsed.data.exitMode){
    const ticker=parsed.data.exitMode.symbol.startsWith("O:")?parsed.data.exitMode.symbol:`O:${parsed.data.exitMode.symbol}`;
    const {error}=await admin.from("paper_position_monitors").update({exit_mode:parsed.data.exitMode.mode,updated_at:new Date().toISOString()}).eq("contract_ticker",ticker).eq("user_id",user.id);
    if(error) return Response.json({error:error.message},{status:500});
  }
  if(parsed.data.killSwitch!==undefined||parsed.data.autoAdopt!==undefined){
    const patch:Record<string,unknown>={updated_at:new Date().toISOString()};
    if(parsed.data.killSwitch!==undefined)patch.kill_switch=parsed.data.killSwitch;
    if(parsed.data.autoAdopt!==undefined)patch.auto_adopt_unmanaged=parsed.data.autoAdopt;
    const {error}=await admin.from("position_manager_control").update(patch).eq("id",true);
    if(error) return Response.json({error:error.message},{status:500});
  }
  return Response.json(await state(user.id));
}

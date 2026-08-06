import {redirect} from "next/navigation";
import {getAuthenticatedUser} from "@/lib/supabase/auth";
import {createClient} from "@/lib/supabase/server";
import {buildAnalytics,type AnalyticsTrade} from "@/lib/analytics/metrics";
import {AnalyticsView} from "./strategy-analytics";

interface RunRow{id:string;underlying:"SPY"|"SPX";configuration:unknown}
interface TradeRow{entry_at:string;entry_ask:number|string;exit_bid:number|string|null;result:Record<string,unknown>|null;replay_run_id:string}
export default async function AnalyticsPage(){
  const user=await getAuthenticatedUser();if(!user)redirect("/login");const supabase=await createClient();
  const {data:runs,error:runError}=await supabase.from("replay_runs").select("id,underlying,configuration").eq("user_id",user.id).eq("status","complete").order("created_at",{ascending:false}).limit(500);
  if(runError)throw new Error(`Analytics runs: ${runError.message}`);const runRows=(runs??[]) as RunRow[];const runMap=new Map(runRows.map(run=>[run.id,run]));
  let tradeRows:TradeRow[]=[];if(runRows.length){const {data,error}=await supabase.from("replay_trades").select("entry_at,entry_ask,exit_bid,result,replay_run_id").in("replay_run_id",runRows.map(run=>run.id)).order("entry_at",{ascending:true}).limit(5000);if(error)throw new Error(`Analytics trades: ${error.message}`);tradeRows=(data??[]) as TradeRow[];}
  const values:AnalyticsTrade[]=tradeRows.flatMap(row=>{const run=runMap.get(row.replay_run_id);if(!run||row.exit_bid==null)return[];const result=row.result??{};const configuration=(run.configuration??{}) as Record<string,unknown>;const entryAsk=Number(row.entry_ask);const exitBid=Number(row.exit_bid);return [{entryAt:row.entry_at,entryAsk,exitBid,pnlDollars:typeof result.pnlDollars==="number"?result.pnlDollars:(exitBid-entryAsk)*100,underlying:run.underlying,dte:typeof configuration.dte==="number"?configuration.dte:0,side:result.side==="put"?"put":"call",spreadPct:typeof result.spreadPct==="number"?result.spreadPct:null}];});
  return <AnalyticsView userEmail={user.email} analytics={buildAnalytics(values)}/>;
}

import {createAdminClient} from "@/lib/supabase/admin";
import {listRobinhoodTools,robinhoodConnectionStatus} from "@/lib/brokers/robinhood";

export const dynamic="force-dynamic";
export const maxDuration=60;

export async function GET(request:Request){
  if(!process.env.CRON_SECRET||request.headers.get("authorization")!==`Bearer ${process.env.CRON_SECRET}`)return new Response("Unauthorized",{status:401});
  const {data,error}=await createAdminClient().from("broker_connections").select("user_id").eq("broker","robinhood").limit(1).maybeSingle();
  if(error)return Response.json({connected:false,error:error.message},{status:500});
  if(!data)return Response.json({connected:false,reason:"no_connection"});
  const status=await robinhoodConnectionStatus(data.user_id);
  if(!status.connected)return Response.json({connected:false,reason:status.status??"disconnected"});
  try{
    const tools=await listRobinhoodTools(data.user_id);
    return Response.json({connected:true,tools:tools.length,expiresAt:status.expiresAt??null,checkedAt:new Date().toISOString()});
  }catch(cause){
    return Response.json({connected:false,reason:cause instanceof Error?cause.message:"mcp_check_failed"});
  }
}

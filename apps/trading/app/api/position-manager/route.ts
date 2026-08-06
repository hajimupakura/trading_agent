import { z } from "zod";
import { getAuthenticatedUser } from "@/lib/supabase/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
async function state() {
  const admin = createAdminClient();
  const [{data:control,error:controlError},{data:statuses,error:statusError}] = await Promise.all([
    admin.from("position_manager_control").select("auto_exits_enabled,kill_switch,updated_at").eq("id",true).single(),
    admin.from("position_manager_status").select("enabled,healthy,managed_positions,last_error,last_heartbeat").order("last_heartbeat",{ascending:false}).limit(1),
  ]);
  if (controlError) throw controlError; if (statusError) throw statusError;
  const status = statuses?.[0] ?? null; const heartbeatAge = status ? Date.now()-Date.parse(status.last_heartbeat):Infinity;
  return { control,status,online:Boolean(status?.healthy && heartbeatAge<30_000),heartbeatAgeMs:Number.isFinite(heartbeatAge)?heartbeatAge:null };
}
export async function GET() {
  if (!await getAuthenticatedUser()) return Response.json({error:"Unauthorized"},{status:401});
  try { return Response.json(await state(),{headers:{"Cache-Control":"no-store"}}); }
  catch(error){ return Response.json({error:error instanceof Error?error.message:"Manager unavailable"},{status:503}); }
}
export async function POST(request:Request) {
  if (!await getAuthenticatedUser()) return Response.json({error:"Unauthorized"},{status:401});
  const parsed=z.object({killSwitch:z.boolean()}).safeParse(await request.json().catch(()=>null));
  if(!parsed.success) return Response.json({error:"Invalid control request"},{status:400});
  const {error}=await createAdminClient().from("position_manager_control").update({kill_switch:parsed.data.killSwitch,updated_at:new Date().toISOString()}).eq("id",true);
  if(error) return Response.json({error:error.message},{status:500});
  return Response.json(await state());
}

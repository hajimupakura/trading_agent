import {getAuthenticatedUser} from "@/lib/supabase/auth";
import {createClient} from "@/lib/supabase/server";
import {riskSettingsSchema,settingsToRow} from "@/lib/settings/config";

export async function PUT(request:Request){const user=await getAuthenticatedUser();if(!user)return Response.json({error:"Unauthorized"},{status:401});const parsed=riskSettingsSchema.safeParse(await request.json().catch(()=>null));if(!parsed.success)return Response.json({error:parsed.error.issues[0]?.message??"Invalid risk settings"},{status:400});const supabase=await createClient();const {error}=await supabase.from("user_settings").update(settingsToRow(parsed.data)).eq("user_id",user.id);if(error)return Response.json({error:error.message},{status:400});return Response.json({ok:true,settings:parsed.data});}

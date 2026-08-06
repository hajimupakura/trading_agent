import "server-only";
import {createAdminClient} from "@/lib/supabase/admin";
import {DEFAULT_RISK_SETTINGS,settingsFromRow,type RiskSettings} from "./config";
export * from "./config";
export async function loadRiskSettings(userId?:string):Promise<RiskSettings>{if(!userId)return DEFAULT_RISK_SETTINGS;const {data,error}=await createAdminClient().from("user_settings").select("*").eq("user_id",userId).maybeSingle();if(error)throw new Error(`Risk settings unavailable: ${error.message}`);return settingsFromRow(data);}

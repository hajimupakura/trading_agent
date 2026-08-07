import "server-only";
import {createAdminClient} from "@/lib/supabase/admin";
import {sendTelegram} from "@/lib/notify/telegram";

export type AlertSeverity="info"|"success"|"warning"|"critical";
const SEVERITY_ICON:Record<AlertSeverity,string>={info:"ℹ️",success:"✅",warning:"⚠️",critical:"🚨"};

export async function createAlert(input:{userId:string;signalId?:string|null;eventKey:string;severity:AlertSeverity;title:string;body:string;metadata?:Record<string,unknown>}){
  const {error}=await createAdminClient().from("alerts").insert({user_id:input.userId,signal_id:input.signalId??null,channel:"in_app",event_key:input.eventKey,severity:input.severity,title:input.title,body:input.body,metadata:input.metadata??{}});
  if(error){
    if(error.code!=="23505")throw error;
    return; // duplicate event key — already alerted, don't re-send to Telegram
  }
  // Mirror every fresh alert to Telegram; delivery failure never fails the alert itself.
  await sendTelegram(`${SEVERITY_ICON[input.severity]} ${input.title}\n\n${input.body}`).catch(err=>console.error("Telegram mirror failed",err));
}

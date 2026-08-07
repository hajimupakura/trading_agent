import "server-only";
import {createAdminClient} from "@/lib/supabase/admin";

export type AlertSeverity="info"|"success"|"warning"|"critical";

// Alerts are insert-only here. Telegram delivery is handled by the cron dispatcher
// (lib/notify/dispatch.ts): instant tier within a minute, noisy tier batched into
// the half-hour LLM digest — so a burst of flow alerts can't flood the phone.
export async function createAlert(input:{userId:string;signalId?:string|null;eventKey:string;severity:AlertSeverity;title:string;body:string;metadata?:Record<string,unknown>}){
  const {error}=await createAdminClient().from("alerts").insert({user_id:input.userId,signal_id:input.signalId??null,channel:"in_app",event_key:input.eventKey,severity:input.severity,title:input.title,body:input.body,metadata:input.metadata??{}});
  if(error&&error.code!=="23505")throw error;
}

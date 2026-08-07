import { createAdminClient } from "@/lib/supabase/admin";
import { runHistoricalReplay } from "@/lib/replay/service";

// CRON_SECRET-guarded single-session replay runner for batch studies.
// Loop over dates externally; each call replays one session and persists to replay_runs/_trades.
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) return new Response("Unauthorized", { status:401 });
  const params = new URL(request.url).searchParams;
  const date = params.get("date") ?? "";
  const dte = Number(params.get("dte") ?? 0);
  if (!DATE.test(date) || ![0,1,2].includes(dte)) return Response.json({ error:"bad params" }, { status:400 });
  const { data:profile, error } = await createAdminClient().from("profiles").select("id").limit(1).maybeSingle();
  if (error || !profile) return Response.json({ error:error?.message ?? "no profile" }, { status:500 });
  try {
    const result = await runHistoricalReplay({ ownerId:profile.id, underlying:"SPY", sessionDate:date, dte:dte as 0|1|2 });
    return Response.json({ date, dte, status:result.status, summary:result.summary, noTradeReasons:result.noTradeReasons.slice(0,3) });
  } catch (cause) {
    return Response.json({ date, dte, error:cause instanceof Error ? cause.message : "replay failed" }, { status:502 });
  }
}

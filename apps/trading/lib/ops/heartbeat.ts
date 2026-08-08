import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAlert } from "@/lib/alerts/server";

// Ops heartbeat: cron job failures must page the user, not die in a JSON response.
// Each cron tick reports its per-job error strings here; consecutive failures of the
// same job across ticks trigger ONE throttled Telegram alert per job per 2 hours.
// State lives in a tiny ops_job_state table (job, consecutive_errors, last_error).

const ALERT_AFTER_CONSECUTIVE = 3;

export async function reportJobHealth(jobs: Record<string, string[] | null>): Promise<void> {
  const admin = createAdminClient();
  const now = new Date().toISOString();
  for (const [job, errors] of Object.entries(jobs)) {
    if (errors == null) continue; // job did not run this tick — not a failure
    try {
      if (!errors.length) {
        await admin.from("ops_job_state").upsert({ job, consecutive_errors: 0, last_error: null, updated_at: now });
        continue;
      }
      const { data: state } = await admin.from("ops_job_state").select("consecutive_errors").eq("job", job).maybeSingle();
      const consecutive = (Number(state?.consecutive_errors) || 0) + 1;
      await admin.from("ops_job_state").upsert({ job, consecutive_errors: consecutive, last_error: errors.join(" | ").slice(0, 500), updated_at: now });
      if (consecutive === ALERT_AFTER_CONSECUTIVE || (consecutive > ALERT_AFTER_CONSECUTIVE && consecutive % 24 === 0)) {
        const { data: owner } = await admin.from("profiles").select("id").limit(1).maybeSingle();
        if (!owner) continue;
        const hourBucket = new Date().toISOString().slice(0, 13);
        await createAlert({
          userId: owner.id, eventKey: `radar-ops-${job}-${hourBucket}`, severity: "critical",
          title: `System health: the "${job}" job keeps failing`,
          body: `The ${job} background job has failed ${consecutive} runs in a row. Latest error: ${errors[0].slice(0, 200)}. The rest of the system keeps running; this one function is sick. If this persists, open a session and say "check the ${job} job".`,
          metadata: { kind: "ops_heartbeat", job, consecutive },
        }).catch(() => undefined);
      }
    } catch (error) {
      console.error("heartbeat reporting failed", job, error);
    }
  }
}

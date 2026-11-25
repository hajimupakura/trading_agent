import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAlert } from "@/lib/alerts/server";
import { evaluateTickStart, parseWatchdogState, type WatchdogState } from "./tick-budget";

// TICK-TIMEOUT WATCHDOG. A monitor tick that Vercel kills at 60s cannot report its own
// death: the heartbeat and the blind-spot checks live at the tail it never reached, so
// a killed tick looks exactly like a quiet one (the silent-failure doctrine's textbook
// case — 46 kills on 2026-11-24/25 and not one page). The fix is to make the NEXT tick
// the witness: every tick stamps "open" before doing anything else and "closed" as its
// last act. A tick that starts and finds the previous one still open — and older than
// the 60s ceiling allows — knows it was killed. Three in a row, or five inside thirty
// minutes, pages critical (at most once an hour). The page is created before the
// Telegram dispatcher runs, so it goes out in the same tick that detected it.
//
// State is one ops_job_state row: consecutive_errors = killed ticks in a row,
// updated_at = the in-flight tick's start (its identity — a late-finishing tick can
// only close its OWN marker), last_error = small JSON (open flag, recent kill times,
// and the step the tick was in at the 45s warning mark).

const JOB = "tick-watchdog";

export type TickWatchdog = {
  /** Called when the tick crosses the warning mark: remember where it was. */
  noteSlow(step: string): Promise<void>;
  /** Last act of a tick that reached its end: clear the open marker and the streak. */
  close(): Promise<void>;
};

const NOOP: TickWatchdog = { noteSlow: async () => undefined, close: async () => undefined };

export async function openTickWatchdog(tickStartedAt: number): Promise<TickWatchdog> {
  // The watchdog guards the tick; it must never be the thing that breaks it.
  try {
    const admin = createAdminClient();
    const openedAt = new Date(tickStartedAt).toISOString();
    const { data: row, error: readError } = await admin.from("ops_job_state").select("consecutive_errors,last_error,updated_at").eq("job", JOB).maybeSingle();
    if (readError) throw new Error(readError.message);
    const verdict = evaluateTickStart({
      consecutive: Number(row?.consecutive_errors) || 0,
      state: parseWatchdogState(row?.last_error),
      openedAtMs: row?.updated_at ? Date.parse(String(row.updated_at)) : null,
    }, tickStartedAt);
    let state: WatchdogState = { open: true, recent: verdict.recent };
    const { error: writeError } = await admin.from("ops_job_state").upsert({ job: JOB, consecutive_errors: verdict.consecutive, last_error: JSON.stringify(state), updated_at: openedAt });
    if (writeError) throw new Error(writeError.message);

    if (verdict.timedOut) console.error(JSON.stringify({ tag: "monitor_tick_timeout_detected", consecutive: verdict.consecutive, recent: verdict.recent.length, stuckIn: verdict.stuckIn }));
    if (verdict.shouldPage) {
      const { data: owner } = await admin.from("profiles").select("id").limit(1).maybeSingle();
      if (owner) await createAlert({
        userId: String(owner.id), eventKey: `ops-tick-timeout-${openedAt.slice(0, 13)}`, severity: "critical",
        title: "System health: the every-minute monitor keeps getting killed at 60 seconds",
        body: `The monitor run was cut off at Vercel's 60-second limit ${verdict.consecutive} time${verdict.consecutive === 1 ? "" : "s"} in a row (${verdict.recent.length} in the last 30 minutes). A killed run skips everything after the slow step — including the blind-spot checks and the job heartbeat, so OTHER ALARMS MAY BE SILENT right now. ${verdict.stuckIn ? `The last killed run was inside "${verdict.stuckIn}" at the 45-second mark.` : "It died before the 45-second mark could record where."} Signals and entries from the part of the run that finished still happened. If this persists, open a session and say "check the monitor tick timeouts".`,
        metadata: { kind: "ops_tick_timeout", consecutive: verdict.consecutive, recentCount: verdict.recent.length, recent: verdict.recent, stuckIn: verdict.stuckIn },
      }).catch(error => console.error("tick watchdog page failed", error));
    }

    // Both writes below match on updated_at = this tick's start: if a newer tick has
    // already taken over the marker, a straggler must not clear or relabel it.
    // close() waits for an in-flight slow note, so the two writes can never land out
    // of order and leave a finished tick looking open.
    let slowNote: Promise<void> = Promise.resolve();
    return {
      noteSlow(step: string) {
        state = { ...state, slowStep: step };
        slowNote = (async () => {
          const { error } = await admin.from("ops_job_state").update({ last_error: JSON.stringify(state) }).eq("job", JOB).eq("updated_at", openedAt);
          if (error) console.error("tick watchdog slow note failed", error.message);
        })().catch(error => console.error("tick watchdog slow note failed", error));
        return slowNote;
      },
      async close() {
        await slowNote;
        const closed = verdict.recent.length ? JSON.stringify({ open: false, recent: verdict.recent } satisfies WatchdogState) : null;
        const { error } = await admin.from("ops_job_state").update({ consecutive_errors: 0, last_error: closed }).eq("job", JOB).eq("updated_at", openedAt);
        if (error) console.error("tick watchdog close failed", error.message);
      },
    };
  } catch (error) {
    console.error("tick watchdog open failed", error);
    return NOOP;
  }
}

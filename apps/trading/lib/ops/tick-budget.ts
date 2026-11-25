// TICK BUDGET. The every-minute monitor route has a hard 60s ceiling and ~40 serial
// steps; when one runs long, Vercel kills the invocation and everything after the slow
// step silently never happens — including the blind-spot checks and the job heartbeat,
// the system's own alarms (113 such kills between 2026-08-25 and 2026-11-25, 46 of them
// in one day). This module gives the route three things:
//   1. per-step timings, so a slow tick names its slow step instead of just dying;
//   2. a budget for OPTIONAL steps (research, reports, LLM reviews): none starts once
//      the tick is past the soft budget, and none is waited on past the hard deadline,
//      so the alarms at the tail always get their turn;
//   3. the pure decision logic for the "ticks keep timing out" page (tick-watchdog.ts
//      holds the database half).
// Pure on purpose (no server-only, no I/O) so the rules are unit-tested.

/** Past this, a tick is logged as a warning and the in-flight step is recorded. */
export const TICK_WARN_MS = 45_000;
/** Optional steps do not START once the tick has used this much. */
export const TICK_SOFT_BUDGET_MS = 48_000;
/** Optional steps are not WAITED ON past this; leaves ~7s for the alarms. */
export const TICK_HARD_DEADLINE_MS = 53_000;

export type TickReport = {
  totalMs: number;
  /** step -> wall-clock ms (a step that ran twice is summed). */
  steps: Record<string, number>;
  /** Optional steps never started: the tick was already past the soft budget. */
  skipped: string[];
  /** Optional steps abandoned at the hard deadline (their work may still finish). */
  capped: string[];
  /** The step running right now — what a killed tick was stuck in. */
  inFlight: string | null;
};

const CAPPED = Symbol("capped");

export function createTickTimer(startedAt: number, options?: { softBudgetMs?: number; hardDeadlineMs?: number; now?: () => number }) {
  const now = options?.now ?? Date.now;
  const softBudgetMs = options?.softBudgetMs ?? TICK_SOFT_BUDGET_MS;
  const hardDeadlineMs = options?.hardDeadlineMs ?? TICK_HARD_DEADLINE_MS;
  const steps: Record<string, number> = {};
  const skipped: string[] = [];
  const capped: string[] = [];
  let inFlight: string | null = null;

  /** A step that always runs to completion; only timed. */
  async function run<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const began = now();
    inFlight = name;
    try {
      return await fn();
    } finally {
      steps[name] = (steps[name] ?? 0) + (now() - began);
      if (inFlight === name) inFlight = null;
    }
  }

  /**
   * A step the tick can live without for one minute. Returns null when it was skipped
   * (tick already past the soft budget) or capped (still running at the hard deadline)
   * — callers report null as "did not run", never as a failure or a success.
   */
  async function optional<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
    const elapsed = now() - startedAt;
    if (elapsed >= softBudgetMs) { skipped.push(name); return null; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cap = new Promise<typeof CAPPED>(resolve => { timer = setTimeout(() => resolve(CAPPED), Math.max(0, hardDeadlineMs - elapsed)); });
    const work = Promise.resolve().then(fn);
    // Abandoned work keeps running in the background; if it later rejects, that must
    // not surface as an unhandled rejection in a function that has moved on.
    work.catch(() => undefined);
    try {
      const outcome = await run(name, () => Promise.race([work, cap]));
      if (outcome === CAPPED) { capped.push(name); return null; }
      return outcome as T;
    } finally {
      clearTimeout(timer);
    }
  }

  function report(): TickReport {
    return { totalMs: now() - startedAt, steps: { ...steps }, skipped: [...skipped], capped: [...capped], inFlight };
  }

  return { run, optional, report, elapsedMs: () => now() - startedAt };
}

/** One-line health verdict for the heartbeat: [] when the tick stayed inside budget. */
export function tickBudgetProblems(report: TickReport, warnMs: number = TICK_WARN_MS): string[] {
  const overBudget = report.totalMs > warnMs;
  if (!overBudget && !report.skipped.length && !report.capped.length) return [];
  const slowest = Object.entries(report.steps).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, ms]) => `${name} ${(ms / 1000).toFixed(1)}s`).join(", ");
  const parts = [`tick at ${(report.totalMs / 1000).toFixed(1)}s of 60s`];
  if (slowest) parts.push(`slowest: ${slowest}`);
  if (report.capped.length) parts.push(`cut off: ${report.capped.join(",")}`);
  if (report.skipped.length) parts.push(`skipped: ${report.skipped.join(",")}`);
  return [parts.join(" — ")];
}

// ------------------------------------------------------------ timeout watchdog rules

/** A tick whose start marker is this old and still open was killed (ceiling is 60s). */
export const TICK_DEAD_AFTER_MS = 55_000;
/** Page after this many killed ticks in a row… */
export const TIMEOUT_PAGE_CONSECUTIVE = 3;
/** …or this many inside the rolling window (catches every-other-tick patterns). */
export const TIMEOUT_PAGE_RECENT = 5;
export const TIMEOUT_RECENT_WINDOW_MS = 30 * 60_000;

export type WatchdogState = {
  /** true while a tick is in flight; a tick that finishes sets it back to false. */
  open: boolean;
  /** Start times (ISO) of recently killed ticks, oldest first. */
  recent: string[];
  /** Where the in-flight tick was when it crossed the warning mark, if it did. */
  slowStep?: string;
};

export function parseWatchdogState(raw: unknown): WatchdogState {
  if (typeof raw !== "string" || !raw) return { open: false, recent: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<WatchdogState>;
    return {
      open: parsed.open === true,
      recent: Array.isArray(parsed.recent) ? parsed.recent.filter((value): value is string => typeof value === "string") : [],
      ...(typeof parsed.slowStep === "string" ? { slowStep: parsed.slowStep } : {}),
    };
  } catch {
    return { open: false, recent: [] };
  }
}

/**
 * Called at the START of a tick with what the previous tick left behind. A previous
 * tick that opened and never closed was killed mid-run — the only way a tick fails to
 * close, because every step failure is caught and the close runs last.
 */
export function evaluateTickStart(previous: { consecutive: number; state: WatchdogState; openedAtMs: number | null }, nowMs: number): {
  timedOut: boolean; consecutive: number; recent: string[]; shouldPage: boolean; stuckIn: string | null;
} {
  const inWindow = (iso: string) => nowMs - Date.parse(iso) <= TIMEOUT_RECENT_WINDOW_MS;
  const recent = previous.state.recent.filter(inWindow);
  const openAgeMs = previous.state.open && previous.openedAtMs != null ? nowMs - previous.openedAtMs : null;
  // Open but young = an overlapping invocation that is still running (manual call,
  // cron jitter): not a timeout, and not evidence the streak ended either.
  if (openAgeMs != null && openAgeMs < TICK_DEAD_AFTER_MS) return { timedOut: false, consecutive: previous.consecutive, recent, shouldPage: false, stuckIn: null };
  if (openAgeMs == null) return { timedOut: false, consecutive: 0, recent, shouldPage: false, stuckIn: null };
  const consecutive = previous.consecutive + 1;
  const withThis = [...recent, new Date(previous.openedAtMs as number).toISOString()].slice(-12);
  return {
    timedOut: true, consecutive, recent: withThis,
    shouldPage: consecutive >= TIMEOUT_PAGE_CONSECUTIVE || withThis.length >= TIMEOUT_PAGE_RECENT,
    stuckIn: previous.state.slowStep ?? null,
  };
}

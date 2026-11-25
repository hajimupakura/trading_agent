import { describe, expect, it } from "vitest";
import { createTickTimer, evaluateTickStart, parseWatchdogState, tickBudgetProblems, TICK_DEAD_AFTER_MS } from "./tick-budget";

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

describe("tick timer", () => {
  it("times every step and names the one in flight", async () => {
    const tick = createTickTimer(Date.now());
    let seenInFlight: string | null = null;
    await tick.run("refresh", async () => { await sleep(20); seenInFlight = tick.report().inFlight; });
    const report = tick.report();
    expect(seenInFlight).toBe("refresh");
    expect(report.inFlight).toBeNull();
    expect(report.steps.refresh).toBeGreaterThanOrEqual(15);
    expect(report.skipped).toEqual([]);
  });

  it("still records the step's time when it throws", async () => {
    const tick = createTickTimer(Date.now());
    await expect(tick.run("boom", async () => { throw new Error("x"); })).rejects.toThrow("x");
    expect(tick.report().steps).toHaveProperty("boom");
  });

  it("does not START an optional step once the tick is past the soft budget", async () => {
    // Tick "started" 50s ago: past the 48s soft budget.
    const tick = createTickTimer(Date.now() - 50_000);
    let ran = false;
    const result = await tick.optional("research", async () => { ran = true; return 1; });
    expect(result).toBeNull();
    expect(ran).toBe(false);
    expect(tick.report().skipped).toEqual(["research"]);
  });

  it("stops WAITING on an optional step at the hard deadline, and the tick moves on", async () => {
    const tick = createTickTimer(Date.now(), { softBudgetMs: 1_000, hardDeadlineMs: 40 });
    const began = Date.now();
    const result = await tick.optional("llm", async () => { await sleep(400); return "late"; });
    expect(result).toBeNull();
    expect(Date.now() - began).toBeLessThan(300);
    expect(tick.report().capped).toEqual(["llm"]);
    // The alarms at the tail still get their turn.
    expect(await tick.run("heartbeat", async () => "ok")).toBe("ok");
  });

  it("returns an optional step's value when it finishes inside the budget", async () => {
    const tick = createTickTimer(Date.now());
    expect(await tick.optional("radar", async () => ({ errors: [] as string[] }))).toEqual({ errors: [] });
    expect(tick.report().capped).toEqual([]);
  });

  it("an abandoned step that later rejects does not crash the process", async () => {
    const tick = createTickTimer(Date.now(), { softBudgetMs: 1_000, hardDeadlineMs: 20 });
    expect(await tick.optional("flaky", async () => { await sleep(60); throw new Error("late failure"); })).toBeNull();
    await sleep(80); // an unhandled rejection here would fail the test run
  });
});

describe("tick budget verdict for the heartbeat", () => {
  it("is clean for a fast tick", () => {
    expect(tickBudgetProblems({ totalMs: 12_000, steps: { refresh: 8_000 }, skipped: [], capped: [], inFlight: null })).toEqual([]);
  });
  it("names the slowest steps and what was dropped", () => {
    const [line] = tickBudgetProblems({ totalMs: 51_200, steps: { "refresh-watch": 31_000, "refresh-index": 14_000, radar: 900, news: 300 }, skipped: ["research-queue"], capped: ["ai-reviews"], inFlight: null });
    expect(line).toContain("51.2s of 60s");
    expect(line).toContain("refresh-watch 31.0s");
    expect(line).toContain("cut off: ai-reviews");
    expect(line).toContain("skipped: research-queue");
  });
});

describe("timeout watchdog rules", () => {
  const now = Date.parse("2026-11-25T16:05:28.000Z");
  const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

  it("a previous tick that closed is healthy and resets the streak", () => {
    const verdict = evaluateTickStart({ consecutive: 2, state: { open: false, recent: [] }, openedAtMs: now - 60_000 }, now);
    expect(verdict).toMatchObject({ timedOut: false, consecutive: 0, shouldPage: false });
  });

  it("a previous tick still open after the ceiling was killed", () => {
    const verdict = evaluateTickStart({ consecutive: 0, state: { open: true, recent: [], slowStep: "refresh-watch" }, openedAtMs: now - 60_000 }, now);
    expect(verdict).toMatchObject({ timedOut: true, consecutive: 1, shouldPage: false, stuckIn: "refresh-watch" });
    expect(verdict.recent).toEqual([minutesAgo(1)]);
  });

  it("pages on the third kill in a row", () => {
    const verdict = evaluateTickStart({ consecutive: 2, state: { open: true, recent: [minutesAgo(3), minutesAgo(2)] }, openedAtMs: now - 60_000 }, now);
    expect(verdict).toMatchObject({ timedOut: true, consecutive: 3, shouldPage: true });
  });

  it("pages on five scattered kills inside thirty minutes even with no streak", () => {
    const verdict = evaluateTickStart({ consecutive: 0, state: { open: true, recent: [minutesAgo(25), minutesAgo(19), minutesAgo(12), minutesAgo(6)] }, openedAtMs: now - 60_000 }, now);
    expect(verdict).toMatchObject({ timedOut: true, consecutive: 1, shouldPage: true });
  });

  it("forgets kills older than the window", () => {
    const verdict = evaluateTickStart({ consecutive: 0, state: { open: true, recent: [minutesAgo(90), minutesAgo(45), minutesAgo(40), minutesAgo(35)] }, openedAtMs: now - 60_000 }, now);
    expect(verdict.recent).toHaveLength(1);
    expect(verdict.shouldPage).toBe(false);
  });

  it("an overlapping tick that is still young is not a timeout and keeps the streak", () => {
    const verdict = evaluateTickStart({ consecutive: 2, state: { open: true, recent: [] }, openedAtMs: now - (TICK_DEAD_AFTER_MS - 5_000) }, now);
    expect(verdict).toMatchObject({ timedOut: false, consecutive: 2, shouldPage: false });
  });

  it("reads state defensively", () => {
    expect(parseWatchdogState(null)).toEqual({ open: false, recent: [] });
    expect(parseWatchdogState("some old error text")).toEqual({ open: false, recent: [] });
    expect(parseWatchdogState(JSON.stringify({ open: true, recent: ["a", 5], slowStep: "news" }))).toEqual({ open: true, recent: ["a"], slowStep: "news" });
  });
});

import { refreshCommandCenter } from "@/lib/options/command-center";
import { refreshWatchSnapshot } from "@/lib/options/watchlist";
import { WATCH_UNDERLYINGS } from "@/lib/options/types";
import { runMarketRadar } from "@/lib/options/market-radar";
import { maybeRunScheduledReviews } from "@/lib/ai/review";
import { dispatchInstantAlerts } from "@/lib/notify/dispatch";
import { runConvexityCapture } from "@/lib/options/convexity";
import { runConvexityReplays } from "@/lib/options/convexity-replay";
import { runSectorFlow } from "@/lib/options/sector-flow";
import { runResearchFetches } from "@/lib/options/research-fetch";
import { runTradeReviews } from "@/lib/options/trade-review";
import { reportJobHealth } from "@/lib/ops/heartbeat";
import { runBlindspotChecks } from "@/lib/ops/blindspot";
import { createTickTimer, tickBudgetProblems, TICK_WARN_MS } from "@/lib/ops/tick-budget";
import { openTickWatchdog } from "@/lib/ops/tick-watchdog";
import { runSurgeRadar } from "@/lib/options/surge-radar";
import { runMetalTriggers } from "@/lib/options/metals-triggers";
import { runEarningsCalendarCheck } from "@/lib/options/earnings-guard";
import { runFlowWatchScoring } from "@/lib/options/flow-watch";
import { runAutoEntry } from "@/lib/alpaca/auto-entry";
import { markShadowLedger } from "@/lib/options/shadow-ledger";
import { runPaperTicketQueue } from "@/lib/alpaca/ticket-queue";
import { runPaperEquitySnapshot } from "@/lib/alpaca/equity-snapshot";
import { runSetupWatches } from "@/lib/options/setup-watch";
import { runSpxMorningCard } from "@/lib/options/morning-card";
import { runOvernightWatch } from "@/lib/options/overnight-watch";
import { runFastTriggers } from "@/lib/options/fast-triggers";
import { runRobinhoodAutoEntry } from "@/lib/brokers/robinhood-auto-entry";
import type { CommandCenter } from "@/lib/options/types";

export const maxDuration = 60;
export async function GET(request: Request) {
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) return new Response("Unauthorized", { status:401 });
  const tickStartedAt = Date.now();
  // TICK BUDGET (2026-11-25). Every step below runs through `tick`, which times it;
  // steps wrapped in tick.optional() are the ones the system can live without for a
  // minute (reports, research, LLM reviews) — they are not started once the tick is
  // past its soft budget and not waited on past the hard deadline, so a slow one can
  // no longer starve the blind-spot checks and the heartbeat at the tail. Trading
  // steps (refresh, entries, position notifications) use tick.run(): timed, never cut.
  const tick = createTickTimer(tickStartedAt);
  // Timeout watchdog opens BEFORE everything else: a tick Vercel kills cannot report
  // its own death, so this tick checks whether the previous one ever finished — and
  // pages when kills repeat. It runs ahead of the dispatcher so that page goes out now.
  const watchdog = await tick.run("watchdog-open", () => openTickWatchdog(tickStartedAt));
  // If the tick is still running at the warning mark, say where it is — for a tick
  // that then gets killed, this line (and the watchdog note) is the only testimony.
  const slowWarning = setTimeout(() => {
    const report = tick.report();
    console.warn(JSON.stringify({ tag: "monitor_tick_slow", ...report }));
    void watchdog.noteSlow(report.inFlight ?? "between-steps").catch(() => undefined);
  }, TICK_WARN_MS);
  // Telegram dispatch runs FIRST: on heavy ticks the refreshes below can exhaust the
  // 60s budget, and instant alerts must never be the step that gets cut.
  const notify = await tick.run("dispatch", () => dispatchInstantAlerts().catch(error => { console.error("alert dispatch failed", error); return { sent:0, digestPending:0 }; }));
  const minute = new Date().getMinutes();
  // SPY/SPX every minute; long-dated (3M-1Y) chains refresh on the quarter-hour.
  // Watch names: ALL of them every minute (2026-11-23 — the paid Alpaca plan lifted
  // the 200/min rate limit that forced the old 2-per-minute rotation). Guarded by a
  // wall-clock deadline because this route has a 60s budget and ~20 jobs after this
  // block: refreshes run in batches, and when the deadline hits, the remaining names
  // are SKIPPED LOUDLY (scan-coverage heartbeat → 3 consecutive ticks page) and
  // simply catch the next minute's tick. Degraded = slower cadence, never a dead route.
  const includeLongHorizons = minute % 15 === 0;
  const tickStart = Date.now();
  const REFRESH_DEADLINE_MS = 35_000;
  const indexResults = await tick.run("refresh-index", () => Promise.allSettled([
    refreshCommandCenter("SPY", undefined, { includeLongHorizons }),
    refreshCommandCenter("SPX", undefined, { includeLongHorizons }),
  ]));
  const watchGroup: (typeof WATCH_UNDERLYINGS)[number][] = [];
  const skippedWatch: string[] = [];
  const watchResults: PromiseSettledResult<CommandCenter>[] = [];
  const watchQueue = [...WATCH_UNDERLYINGS];
  await tick.run("refresh-watch", async () => {
    while (watchQueue.length) {
      if (Date.now() - tickStart > REFRESH_DEADLINE_MS) { skippedWatch.push(...watchQueue.splice(0)); break; }
      const batch = watchQueue.splice(0, 6);
      watchResults.push(...await Promise.allSettled(batch.map(symbol => refreshWatchSnapshot(symbol, { includeLongHorizons }))));
      watchGroup.push(...batch);
    }
  });
  const results = [...indexResults, ...watchResults];
  // Autonomous paper entries — SPY plus this tick's refreshed watch tickers. Global
  // gates (one position, trades/day, daily loss, cooldown, kill switch) bound the
  // whole fleet; sequential with early exit so one tick can never open two positions.
  // Fast-name 1-minute triggers: bar-only checks for NVDA/TSLA/SPCX/QQQ between their
  // rotation slots; a structural hit pays for the full refresh and joins this tick's
  // entry candidates like any rotation refresh.
  const fastHits = await tick.run("fast-triggers", () => runFastTriggers([...watchGroup]).catch(error => { console.error("fast triggers failed", error); return []; }));
  const autoCandidates: Array<{ underlying: string; snapshot: CommandCenter | null }> = [
    // SPX first and alone in practice — the paper lane is SPX-only (2026-11-19);
    // the rest stay listed so their skips remain visible in the cycle result.
    { underlying: "SPX", snapshot: results[1]?.status === "fulfilled" ? (results[1].value as CommandCenter) : null },
    { underlying: "SPY", snapshot: results[0]?.status === "fulfilled" ? (results[0].value as CommandCenter) : null },
    ...watchGroup.map((symbol, index) => { const result = results[index + 2]; return { underlying: symbol, snapshot: result?.status === "fulfilled" ? (result.value as CommandCenter) : null }; }),
    ...fastHits,
  ];
  let autoEntry: { entered: string | null; skipped?: string } = { entered: null };
  await tick.run("auto-entry", async () => {
    for (const candidate of autoCandidates) {
      autoEntry = await runAutoEntry(candidate.snapshot, candidate.underlying).catch(error => { console.error("auto entry failed", candidate.underlying, error); return { entered:null, skipped:String(error) }; });
      if (autoEntry.entered) break;
    }
  });
  // Convexity sleeve (third sleeve, 2026-11-24): an independent pass over the same
  // fires — a fire the main lanes traded or skipped can still qualify for a swarm.
  // Its own budget (1/day, 2 concurrent) caps it; break on the first entry.
  await tick.run("convexity-entry", async () => {
    const { runConvexityEntry } = await import("@/lib/alpaca/convexity-sleeve");
    for (const candidate of autoCandidates) {
      const convexityEntry = await runConvexityEntry(candidate.snapshot, candidate.underlying).catch(error => { console.error("convexity entry failed", candidate.underlying, error); return { entered:null as string | null, skipped:String(error) }; });
      if (convexityEntry.entered) break;
    }
  });
  // Shadow ledger live-mark: open skipped-signal rows pick up fresh quotes (last
  // bid, peak bid) so the dashboard's Signal Feed shows what each veto cost.
  const shadowMark = await tick.run("shadow-mark", () => markShadowLedger(autoCandidates[0]?.snapshot ?? null).catch(error => { console.error("shadow ledger mark failed", error); return { marked: 0, closed: 0, quoteError: error instanceof Error ? error.message : String(error) }; }));
  // Violent-day shadow trackers (gap_fade + cascade): audition on SPX, never trade.
  await tick.run("violent-shadow", async () => {
    const { runViolentDayShadow } = await import("@/lib/options/violent-shadow");
    await runViolentDayShadow(autoCandidates[0]?.snapshot ?? null).catch(error => console.error("violent shadow failed", error));
  });
  // Goal guard: page once when the day's real P&L banks +20% of the morning baseline.
  await tick.run("goal-guard", async () => {
    const { checkGoalGuard } = await import("@/lib/ops/goal-guard");
    await checkGoalGuard().catch(error => console.error("goal guard failed", error));
  });
  // Telegram fill feedback: 🎯 when a bot buy's position appears, ⏳ after 10 unfilled minutes.
  await tick.run("tg-fills", async () => {
    const { notifyTelegramFills } = await import("@/lib/telegram-bot/fills");
    await notifyTelegramFills().catch(error => console.error("tg fill notify failed", error));
  });
  // Dip companion for manual-exit positions: shouts at 25%/50% off session peak, never sells.
  await tick.run("tg-dips", async () => {
    const { notifyManualHoldDips } = await import("@/lib/telegram-bot/dips");
    await notifyManualHoldDips().catch(error => console.error("tg dip notify failed", error));
  });
  // Benzinga headline ingest (context, never signal): one unfiltered pull per tick.
  // Failures go to the heartbeat (not just console) — a silently dead news feed would
  // otherwise just look like a quiet news day, the classic blind gap.
  const newsErrors: string[] = [];
  await tick.run("news", async () => {
    const { ingestMarketNews } = await import("@/lib/news/market-news");
    await ingestMarketNews().catch(error => { newsErrors.push(error instanceof Error ? error.message : String(error)); console.error("news ingest failed", error); });
  });
  // Real-money entries on the Robinhood agentic account (separate venue, its own caps,
  // OFF unless settings.rhAutoEntriesEnabled). SPX first (user preference, 2026-08-13 —
  // 60/40 tax treatment); when no SPX contract fits the per-trade cap the lane skips and
  // SPY takes the slot, then QQQ/NVDA/TSLA when this tick refreshed them. Correlation-group
  // gates inside the lane cap concurrency (SPX+SPY share one slot).
  const rhCandidates: Array<CommandCenter | null> = [
    results[1]?.status === "fulfilled" ? (results[1].value as CommandCenter) : null,
    results[0]?.status === "fulfilled" ? (results[0].value as CommandCenter) : null,
    ...watchGroup.flatMap((symbol, index) => symbol === "QQQ" && results[index + 2]?.status === "fulfilled" ? [(results[index + 2] as PromiseFulfilledResult<CommandCenter>).value] : []),
    ...fastHits.filter(hit => hit.underlying === "QQQ").map(hit => hit.snapshot),
  ];
  let rhAutoEntry: { entered: string | null; skipped?: string } = { entered: null };
  await tick.run("rh-auto-entry", async () => {
    for (const candidate of rhCandidates) {
      rhAutoEntry = await runRobinhoodAutoEntry(candidate)
        .catch(error => { console.error("rh auto entry failed", error); return { entered:null, skipped:String(error) }; });
      if (rhAutoEntry.entered) break;
    }
  });
  // Paper ticket queue: programmatic paper orders (flow-follow ITM/OTM pairs, ad-hoc
  // tracked buys). Self-gates to market session; prices from the freshest snapshot.
  const tickets = await tick.run("ticket-queue", () => runPaperTicketQueue().catch(error => { console.error("paper ticket queue failed", error); return { placed:0, skipped:0 }; }));
  void tickets;
  // Blind-spot detectors: in-session data invariants (null priorDay, banned chains,
  // stale snapshots page critical) + post-close unexplained-miss audit (>=2% movers
  // with zero entries get a why-not autopsy). Silent failures become loud ones.
  // Runs HERE — straight after the trading steps, ahead of every optional one — since
  // 2026-11-25: at the tail it was the first casualty of any slow tick, which is how
  // 46 killed ticks in a day silently took the system's own alarms down with them.
  const blindspots = await tick.run("blindspot", () => runBlindspotChecks().catch(error => { console.error("blindspot checks failed", error); return { invariantViolations: [] as string[], missAudits: [] as string[] }; }));
  void blindspots;
  // ---- Everything from here to the heartbeat is OPTIONAL for any single minute: a
  // null result means "skipped or cut off for budget this tick" and is reported to the
  // heartbeat as did-not-run (the tick-budget job below is what pages if it repeats).
  const radar = await tick.optional("radar", () => runMarketRadar().catch(error => { console.error("market radar failed", error); return { fired:[] as string[], errors:[String(error)] }; }));
  // Post-close surge sweep (16:02-16:25): the measured breakout trigger on SPY + watchlist.
  const surge = await tick.optional("surge", () => runSurgeRadar().catch(error => { console.error("surge radar failed", error); return { fired:[] as string[], errors:[String(error)] }; }));
  // Metals thesis triggers (SLV>$60 close, GLD weekly MACD cross) — post-close check, fires once each.
  const metals = await tick.optional("metals", () => runMetalTriggers().catch(error => { console.error("metal triggers failed", error); return { checked:false, fired:[] as string[] }; }));
  const earningsCheck = await tick.optional("earnings", () => runEarningsCalendarCheck().catch(error => { console.error("earnings calendar check failed", error); return { checked:false, missing:[] as string[] }; }));
  void earningsCheck;
  // Smart money tracker: post-close scoring of large-print flow watches.
  const flowWatch = await tick.optional("flow-watch-scoring", () => runFlowWatchScoring().catch(error => { console.error("flow watch scoring failed", error); return { checked:false, scored:0 }; }));
  void flowWatch;
  const convexity = await tick.optional("convexity-capture", () => runConvexityCapture().catch(error => { console.error("convexity capture failed", error); return { ran:[] as string[], errors:[String(error)] }; }));
  const aiReviews = await tick.optional("ai-reviews", () => maybeRunScheduledReviews().catch(error => { console.error("ai reviews failed", error); return [] as string[]; }));
  // Historical replay backtest: one queued session per tick, on minutes clear of the
  // heavy refreshes (%15), the digest (:05/:35) and the escalation checks (%5).
  const replay = minute % 5 === 3 ? await tick.optional("replay", () => runConvexityReplays().catch(error => { console.error("convexity replay failed", error); return { processed:null, queued:-1, error:String(error) }; })) : null;
  // Sector money-flow read every 5 minutes, offset from the replay/digest/escalation minutes.
  const sectors = minute % 5 === 1 ? await tick.optional("sectors", () => runSectorFlow().catch(error => { console.error("sector flow failed", error); return { fired:[] as string[], errors:[String(error)] }; })) : null;
  // Ad-hoc research fetch queue: one job per tick on its own light minute.
  const research = minute % 5 === 4 ? await tick.optional("research-fetch", () => runResearchFetches().catch(error => { console.error("research fetch failed", error); return { processed:null, error:String(error) }; })) : null;
  // Ground-truth paper equity snapshot: broker's own equity curve, so P&L audits
  // reconcile against the account instead of our (gap-prone) order journal.
  const equitySnapshot = minute % 5 === 2 ? await tick.optional("equity-snapshot", () => runPaperEquitySnapshot().catch(error => { console.error("paper equity snapshot failed", error); return { ok:false, error:String(error) }; })) : null;
  void equitySnapshot;
  // Afternoon-setup scoreboard: observation-only watchers (earnings-gap continuation,
  // volume ignition) — arm at 9:35, scan every 5 min 9:35-15:50, grade post-close. Trades nothing.
  const setupWatches = await tick.optional("setup-watches", () => runSetupWatches().catch(error => { console.error("setup watches failed", error); return { armed:[] as string[], ignited:[] as string[], graded:[] as string[] }; }));
  void setupWatches;
  // SPX Morning Card: one ~9:25 alert with the measured daily checklist (gap read,
  // drive triggers, levels, econ flags, qualify/stand-down verdict). Trades nothing.
  // Morning news score (9:05-9:25 ET, once/day): overnight tape scored on the
  // news-shock-study rubric; pages when the security/regulatory-on-a-single-name
  // cell lights (the one cell with evidenced puts asymmetry). Context, never signal.
  await tick.optional("morning-news-score", async () => {
    const { runMorningNewsScore } = await import("@/lib/news/morning-score");
    await runMorningNewsScore().catch(error => console.error("morning news score failed", error));
  });
  // Lottery-day detector v2 stamp (11:00-11:15 ET, once/day): day-shape + event
  // calendar scored by the walk-forward model; armed days page. Advisory only.
  await tick.optional("lottery-stamp", async () => {
    const { runLotteryDayStamp } = await import("@/lib/ml/lottery-stamp");
    await runLotteryDayStamp().catch(error => console.error("lottery day stamp failed", error));
  });
  const morningCard = await tick.optional("morning-card", () => runSpxMorningCard().catch(error => { console.error("morning card failed", error); return { sent:false }; }));
  void morningCard;
  // Overnight SPX watch (Cboe GTH, 8:15 PM-9:25 AM): ES-futures sampling + alerts
  // (gap thresholds, ignition, open/early reads). Watch-only — overnight execution
  // is the user's hand on Robinhood; Alpaca can't trade index options off-hours.
  const overnight = await tick.optional("overnight-watch", () => runOvernightWatch().catch(error => { console.error("overnight watch failed", error); return { active:false, fired:[] as string[] }; }));
  // Overnight news sentry: the watch's EAR — macro-shock headlines triaged by LLM
  // during GTH hours, paging (max 3/night) with the live ES read attached.
  await tick.optional("overnight-sentry", async () => {
    const { runOvernightNewsSentry } = await import("@/lib/news/overnight-sentry");
    await runOvernightNewsSentry().catch(error => console.error("overnight news sentry failed", error));
  });
  // DB-queued research fetches: replay/backtest data pulled server-side where the
  // Alpaca keys live (one pending research_requests row per tick, read-only).
  await tick.optional("research-queue", async () => {
    const { runResearchQueue } = await import("@/lib/research/queue");
    await runResearchQueue(tickStartedAt).catch(error => console.error("research queue failed", error));
  });
  // Daily corpus growth (16:20-16:35 ET, once/day): today's fires become ml-corpus/
  // ml-swing/ml-lottery day-requests so the enter-everything research dataset grows
  // every trading day — budgeted sleeves rehearse deployment; the corpus explores.
  await tick.optional("daily-corpus", async () => {
    const { enqueueDailyCorpus } = await import("@/lib/research/daily-corpus");
    await enqueueDailyCorpus().catch(error => console.error("daily corpus enqueue failed", error));
  });
  // Post-close pullback grading: every fire's first pullback gets heldVwap /
  // volumeFading / secondLeg stamped on its shadow row (16:05-16:25 window only).
  const pullbackGrades = await tick.optional("pullback-grades", async () => {
    const { runPullbackGrades } = await import("@/lib/options/pullback-grade");
    return runPullbackGrades().catch(error => ({ graded: 0, errors: [error instanceof Error ? error.message : String(error)] }));
  });
  void overnight;
  // Post-trade autopsies: stage new closed trades and analyze those whose tape arrived.
  const reviews = minute % 15 === 7 ? await tick.optional("trade-reviews", () => runTradeReviews().catch(error => { console.error("trade reviews failed", error); return { staged:0, analyzed:[] as string[] }; })) : null;
  // Heartbeat: consecutive job failures page the user instead of dying in this JSON.
  // Optional steps that were skipped or cut off for budget report null (did not run).
  const beforeHeartbeat = tick.report();
  await tick.run("heartbeat", () => reportJobHealth({
    refresh: results.flatMap(result => result.status === "rejected" ? [String(result.reason)] : []),
    radar: radar === null ? null : (radar.errors ?? []),
    surge: surge === null ? null : (surge.errors ?? []),
    convexity: convexity === null ? null : (convexity.errors ?? []),
    sectors: sectors === null ? null : (sectors.errors ?? []),
    replay: replay === null ? null : (replay.error ? [replay.error] : []),
    research: research === null ? null : (research.error ? [research.error] : []),
    news: newsErrors,
    "shadow-mark": shadowMark.quoteError ? [shadowMark.quoteError] : [],
    // Every-minute scan coverage: a tick that ran out of deadline before reaching all
    // watch names reports here — three consecutive degraded ticks page the user.
    "scan-coverage": skippedWatch.length ? [`deadline hit: ${skippedWatch.length} names skipped (${skippedWatch.join(",")})`] : [],
    "pullback-grade": pullbackGrades === null ? null : pullbackGrades.errors,
    // Tick budget: a tick that ran past the warning mark, or had to skip / cut off
    // optional steps to protect the alarms, reports here — three in a row page. (A
    // tick that is killed outright never gets this far; the watchdog covers that.)
    "tick-budget": tickBudgetProblems(beforeHeartbeat),
  }).catch(error => console.error("heartbeat failed", error)));
  // Last act: tell the watchdog this tick finished, then one structured line of step
  // timings — a warning when the tick ran past the mark, so slow ticks filter by level.
  clearTimeout(slowWarning);
  await tick.run("watchdog-close", () => watchdog.close());
  const tickReport = tick.report();
  const tickLine = JSON.stringify({ tag: "monitor_tick", minute, longHorizons: includeLongHorizons, ...tickReport });
  if (tickReport.totalMs > TICK_WARN_MS || tickReport.skipped.length || tickReport.capped.length) console.warn(tickLine); else console.log(tickLine);
  return Response.json({ ok:results.every(result => result.status === "fulfilled"), refreshed:["SPY","SPX",...watchGroup], skipped:skippedWatch, longHorizons:includeLongHorizons, autoEntry, rhAutoEntry, radar, surge, metals, convexity, replay, sectors, research, reviews, aiReviews, notify, tick:{ totalMs:tickReport.totalMs, skipped:tickReport.skipped, capped:tickReport.capped }, at:new Date().toISOString() });
}

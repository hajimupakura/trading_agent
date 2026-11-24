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
  // Telegram dispatch runs FIRST: on heavy ticks the refreshes below can exhaust the
  // 60s budget, and instant alerts must never be the step that gets cut.
  const notify = await dispatchInstantAlerts().catch(error => { console.error("alert dispatch failed", error); return { sent:0, digestPending:0 }; });
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
  const indexResults = await Promise.allSettled([
    refreshCommandCenter("SPY", undefined, { includeLongHorizons }),
    refreshCommandCenter("SPX", undefined, { includeLongHorizons }),
  ]);
  const watchGroup: (typeof WATCH_UNDERLYINGS)[number][] = [];
  const skippedWatch: string[] = [];
  const watchResults: PromiseSettledResult<CommandCenter>[] = [];
  const watchQueue = [...WATCH_UNDERLYINGS];
  while (watchQueue.length) {
    if (Date.now() - tickStart > REFRESH_DEADLINE_MS) { skippedWatch.push(...watchQueue.splice(0)); break; }
    const batch = watchQueue.splice(0, 6);
    watchResults.push(...await Promise.allSettled(batch.map(symbol => refreshWatchSnapshot(symbol, { includeLongHorizons }))));
    watchGroup.push(...batch);
  }
  const results = [...indexResults, ...watchResults];
  // Autonomous paper entries — SPY plus this tick's refreshed watch tickers. Global
  // gates (one position, trades/day, daily loss, cooldown, kill switch) bound the
  // whole fleet; sequential with early exit so one tick can never open two positions.
  // Fast-name 1-minute triggers: bar-only checks for NVDA/TSLA/SPCX/QQQ between their
  // rotation slots; a structural hit pays for the full refresh and joins this tick's
  // entry candidates like any rotation refresh.
  const fastHits = await runFastTriggers([...watchGroup]).catch(error => { console.error("fast triggers failed", error); return []; });
  const autoCandidates: Array<{ underlying: string; snapshot: CommandCenter | null }> = [
    // SPX first and alone in practice — the paper lane is SPX-only (2026-11-19);
    // the rest stay listed so their skips remain visible in the cycle result.
    { underlying: "SPX", snapshot: results[1]?.status === "fulfilled" ? (results[1].value as CommandCenter) : null },
    { underlying: "SPY", snapshot: results[0]?.status === "fulfilled" ? (results[0].value as CommandCenter) : null },
    ...watchGroup.map((symbol, index) => { const result = results[index + 2]; return { underlying: symbol, snapshot: result?.status === "fulfilled" ? (result.value as CommandCenter) : null }; }),
    ...fastHits,
  ];
  let autoEntry: { entered: string | null; skipped?: string } = { entered: null };
  for (const candidate of autoCandidates) {
    autoEntry = await runAutoEntry(candidate.snapshot, candidate.underlying).catch(error => { console.error("auto entry failed", candidate.underlying, error); return { entered:null, skipped:String(error) }; });
    if (autoEntry.entered) break;
  }
  // Shadow ledger live-mark: open skipped-signal rows pick up fresh quotes (last
  // bid, peak bid) so the dashboard's Signal Feed shows what each veto cost.
  const shadowMark = await markShadowLedger(autoCandidates[0]?.snapshot ?? null).catch(error => { console.error("shadow ledger mark failed", error); return { marked: 0, closed: 0, quoteError: error instanceof Error ? error.message : String(error) }; });
  // Violent-day shadow trackers (gap_fade + cascade): audition on SPX, never trade.
  const { runViolentDayShadow } = await import("@/lib/options/violent-shadow");
  await runViolentDayShadow(autoCandidates[0]?.snapshot ?? null).catch(error => console.error("violent shadow failed", error));
  // Goal guard: page once when the day's real P&L banks +20% of the morning baseline.
  const { checkGoalGuard } = await import("@/lib/ops/goal-guard");
  await checkGoalGuard().catch(error => console.error("goal guard failed", error));
  // Telegram fill feedback: 🎯 when a bot buy's position appears, ⏳ after 10 unfilled minutes.
  const { notifyTelegramFills } = await import("@/lib/telegram-bot/fills");
  await notifyTelegramFills().catch(error => console.error("tg fill notify failed", error));
  // Dip companion for manual-exit positions: shouts at 25%/50% off session peak, never sells.
  const { notifyManualHoldDips } = await import("@/lib/telegram-bot/dips");
  await notifyManualHoldDips().catch(error => console.error("tg dip notify failed", error));
  // Benzinga headline ingest (context, never signal): one unfiltered pull per tick.
  // Failures go to the heartbeat (not just console) — a silently dead news feed would
  // otherwise just look like a quiet news day, the classic blind gap.
  const { ingestMarketNews } = await import("@/lib/news/market-news");
  const newsErrors: string[] = [];
  await ingestMarketNews().catch(error => { newsErrors.push(error instanceof Error ? error.message : String(error)); console.error("news ingest failed", error); });
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
  for (const candidate of rhCandidates) {
    rhAutoEntry = await runRobinhoodAutoEntry(candidate)
      .catch(error => { console.error("rh auto entry failed", error); return { entered:null, skipped:String(error) }; });
    if (rhAutoEntry.entered) break;
  }
  // Paper ticket queue: programmatic paper orders (flow-follow ITM/OTM pairs, ad-hoc
  // tracked buys). Self-gates to market session; prices from the freshest snapshot.
  const tickets = await runPaperTicketQueue().catch(error => { console.error("paper ticket queue failed", error); return { placed:0, skipped:0 }; });
  void tickets;
  const radar = await runMarketRadar().catch(error => { console.error("market radar failed", error); return { fired:[] as string[], errors:[String(error)] }; });
  // Post-close surge sweep (16:02-16:25): the measured breakout trigger on SPY + watchlist.
  const surge = await runSurgeRadar().catch(error => { console.error("surge radar failed", error); return { fired:[] as string[], errors:[String(error)] }; });
  // Metals thesis triggers (SLV>$60 close, GLD weekly MACD cross) — post-close check, fires once each.
  const metals = await runMetalTriggers().catch(error => { console.error("metal triggers failed", error); return { checked:false, fired:[] as string[] }; });
  const earningsCheck = await runEarningsCalendarCheck().catch(error => { console.error("earnings calendar check failed", error); return { checked:false, missing:[] as string[] }; });
  void earningsCheck;
  // Smart money tracker: post-close scoring of large-print flow watches.
  const flowWatch = await runFlowWatchScoring().catch(error => { console.error("flow watch scoring failed", error); return { checked:false, scored:0 }; });
  void flowWatch;
  const convexity = await runConvexityCapture().catch(error => { console.error("convexity capture failed", error); return { ran:[] as string[], errors:[String(error)] }; });
  const aiReviews = await maybeRunScheduledReviews().catch(error => { console.error("ai reviews failed", error); return [] as string[]; });
  // Historical replay backtest: one queued session per tick, on minutes clear of the
  // heavy refreshes (%15), the digest (:05/:35) and the escalation checks (%5).
  const replay = minute % 5 === 3 ? await runConvexityReplays().catch(error => { console.error("convexity replay failed", error); return { processed:null, queued:-1, error:String(error) }; }) : null;
  // Sector money-flow read every 5 minutes, offset from the replay/digest/escalation minutes.
  const sectors = minute % 5 === 1 ? await runSectorFlow().catch(error => { console.error("sector flow failed", error); return { fired:[] as string[], errors:[String(error)] }; }) : null;
  // Ad-hoc research fetch queue: one job per tick on its own light minute.
  const research = minute % 5 === 4 ? await runResearchFetches().catch(error => { console.error("research fetch failed", error); return { processed:null, error:String(error) }; }) : null;
  // Ground-truth paper equity snapshot: broker's own equity curve, so P&L audits
  // reconcile against the account instead of our (gap-prone) order journal.
  const equitySnapshot = minute % 5 === 2 ? await runPaperEquitySnapshot().catch(error => { console.error("paper equity snapshot failed", error); return { ok:false, error:String(error) }; }) : null;
  void equitySnapshot;
  // Afternoon-setup scoreboard: observation-only watchers (earnings-gap continuation,
  // volume ignition) — arm at 9:35, scan every 5 min 9:35-15:50, grade post-close. Trades nothing.
  const setupWatches = await runSetupWatches().catch(error => { console.error("setup watches failed", error); return { armed:[] as string[], ignited:[] as string[], graded:[] as string[] }; });
  void setupWatches;
  // SPX Morning Card: one ~9:25 alert with the measured daily checklist (gap read,
  // drive triggers, levels, econ flags, qualify/stand-down verdict). Trades nothing.
  const morningCard = await runSpxMorningCard().catch(error => { console.error("morning card failed", error); return { sent:false }; });
  void morningCard;
  // Overnight SPX watch (Cboe GTH, 8:15 PM-9:25 AM): ES-futures sampling + alerts
  // (gap thresholds, ignition, open/early reads). Watch-only — overnight execution
  // is the user's hand on Robinhood; Alpaca can't trade index options off-hours.
  const overnight = await runOvernightWatch().catch(error => { console.error("overnight watch failed", error); return { active:false, fired:[] as string[] }; });
  // Overnight news sentry: the watch's EAR — macro-shock headlines triaged by LLM
  // during GTH hours, paging (max 3/night) with the live ES read attached.
  const { runOvernightNewsSentry } = await import("@/lib/news/overnight-sentry");
  await runOvernightNewsSentry().catch(error => console.error("overnight news sentry failed", error));
  // DB-queued research fetches: replay/backtest data pulled server-side where the
  // Alpaca keys live (one pending research_requests row per tick, read-only).
  const { runResearchQueue } = await import("@/lib/research/queue");
  await runResearchQueue().catch(error => console.error("research queue failed", error));
  // Post-close pullback grading: every fire's first pullback gets heldVwap /
  // volumeFading / secondLeg stamped on its shadow row (16:05-16:25 window only).
  const { runPullbackGrades } = await import("@/lib/options/pullback-grade");
  const pullbackGrades = await runPullbackGrades().catch(error => ({ graded: 0, errors: [error instanceof Error ? error.message : String(error)] }));
  void overnight;
  // Post-trade autopsies: stage new closed trades and analyze those whose tape arrived.
  const reviews = minute % 15 === 7 ? await runTradeReviews().catch(error => { console.error("trade reviews failed", error); return { staged:0, analyzed:[] as string[] }; }) : null;
  // Blind-spot detectors: in-session data invariants (null priorDay, banned chains,
  // stale snapshots page critical) + post-close unexplained-miss audit (>=2% movers
  // with zero entries get a why-not autopsy). Silent failures become loud ones.
  const blindspots = await runBlindspotChecks().catch(error => { console.error("blindspot checks failed", error); return { invariantViolations: [] as string[], missAudits: [] as string[] }; });
  void blindspots;
  // Heartbeat: consecutive job failures page the user instead of dying in this JSON.
  await reportJobHealth({
    refresh: results.flatMap(result => result.status === "rejected" ? [String(result.reason)] : []),
    radar: radar.errors ?? [],
    surge: surge.errors ?? [],
    convexity: convexity.errors ?? [],
    sectors: sectors === null ? null : (sectors.errors ?? []),
    replay: replay === null ? null : (replay.error ? [replay.error] : []),
    research: research === null ? null : (research.error ? [research.error] : []),
    news: newsErrors,
    "shadow-mark": shadowMark.quoteError ? [shadowMark.quoteError] : [],
    // Every-minute scan coverage: a tick that ran out of deadline before reaching all
    // watch names reports here — three consecutive degraded ticks page the user.
    "scan-coverage": skippedWatch.length ? [`deadline hit: ${skippedWatch.length} names skipped (${skippedWatch.join(",")})`] : [],
    "pullback-grade": pullbackGrades.errors,
  }).catch(error => console.error("heartbeat failed", error));
  return Response.json({ ok:results.every(result => result.status === "fulfilled"), refreshed:["SPY","SPX",...watchGroup], skipped:skippedWatch, longHorizons:includeLongHorizons, autoEntry, rhAutoEntry, radar, surge, metals, convexity, replay, sectors, research, reviews, aiReviews, notify, at:new Date().toISOString() });
}

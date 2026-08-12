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
import { runSurgeRadar } from "@/lib/options/surge-radar";
import { runMetalTriggers } from "@/lib/options/metals-triggers";
import { runEarningsCalendarCheck } from "@/lib/options/earnings-guard";
import { runAutoEntry } from "@/lib/alpaca/auto-entry";
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
  // SPY/SPX every minute; their long-dated (3M-1Y) chains refresh on the quarter-hour.
  // Watch-list tickers rotate: two per minute, so each refreshes every five minutes.
  const includeLongHorizons = minute % 15 === 0;
  const watchGroup = WATCH_UNDERLYINGS.filter((_, index) => index % 5 === minute % 5);
  const results = await Promise.allSettled([
    refreshCommandCenter("SPY", undefined, { includeLongHorizons }),
    refreshCommandCenter("SPX", undefined, { includeLongHorizons }),
    ...watchGroup.map(symbol => refreshWatchSnapshot(symbol)),
  ]);
  // Autonomous paper entries — SPY plus this tick's refreshed watch tickers. Global
  // gates (one position, trades/day, daily loss, cooldown, kill switch) bound the
  // whole fleet; sequential with early exit so one tick can never open two positions.
  // Fast-name 1-minute triggers: bar-only checks for NVDA/TSLA/SPCX/QQQ between their
  // rotation slots; a structural hit pays for the full refresh and joins this tick's
  // entry candidates like any rotation refresh.
  const fastHits = await runFastTriggers([...watchGroup]).catch(error => { console.error("fast triggers failed", error); return []; });
  const autoCandidates: Array<{ underlying: string; snapshot: CommandCenter | null }> = [
    { underlying: "SPY", snapshot: results[0]?.status === "fulfilled" ? (results[0].value as CommandCenter) : null },
    ...watchGroup.map((symbol, index) => { const result = results[index + 2]; return { underlying: symbol, snapshot: result?.status === "fulfilled" ? (result.value as CommandCenter) : null }; }),
    ...fastHits,
  ];
  let autoEntry: { entered: string | null; skipped?: string } = { entered: null };
  for (const candidate of autoCandidates) {
    autoEntry = await runAutoEntry(candidate.snapshot, candidate.underlying).catch(error => { console.error("auto entry failed", candidate.underlying, error); return { entered:null, skipped:String(error) }; });
    if (autoEntry.entered) break;
  }
  // Real-money entries on the Robinhood agentic account (separate venue, its own caps,
  // OFF unless settings.rhAutoEntriesEnabled). SPY first — at small caps it affords the
  // strong strikes — then SPX, then QQQ/NVDA/TSLA when this tick refreshed them. Correlation-group
  // gates inside the lane cap concurrency at 2 (one S&P slot, one QQQ slot).
  const rhCandidates: Array<CommandCenter | null> = [
    results[0]?.status === "fulfilled" ? (results[0].value as CommandCenter) : null,
    results[1]?.status === "fulfilled" ? (results[1].value as CommandCenter) : null,
    ...watchGroup.flatMap((symbol, index) => ["QQQ", "NVDA", "TSLA", "GOOGL"].includes(symbol) && results[index + 2]?.status === "fulfilled" ? [(results[index + 2] as PromiseFulfilledResult<CommandCenter>).value] : []),
    ...fastHits.filter(hit => ["QQQ", "NVDA", "TSLA", "GOOGL"].includes(hit.underlying)).map(hit => hit.snapshot),
  ];
  let rhAutoEntry: { entered: string | null; skipped?: string } = { entered: null };
  for (const candidate of rhCandidates) {
    rhAutoEntry = await runRobinhoodAutoEntry(candidate)
      .catch(error => { console.error("rh auto entry failed", error); return { entered:null, skipped:String(error) }; });
    if (rhAutoEntry.entered) break;
  }
  const radar = await runMarketRadar().catch(error => { console.error("market radar failed", error); return { fired:[] as string[], errors:[String(error)] }; });
  // Post-close surge sweep (16:02-16:25): the measured breakout trigger on SPY + watchlist.
  const surge = await runSurgeRadar().catch(error => { console.error("surge radar failed", error); return { fired:[] as string[], errors:[String(error)] }; });
  // Metals thesis triggers (SLV>$60 close, GLD weekly MACD cross) — post-close check, fires once each.
  const metals = await runMetalTriggers().catch(error => { console.error("metal triggers failed", error); return { checked:false, fired:[] as string[] }; });
  const earningsCheck = await runEarningsCalendarCheck().catch(error => { console.error("earnings calendar check failed", error); return { checked:false, missing:[] as string[] }; });
  void earningsCheck;
  const convexity = await runConvexityCapture().catch(error => { console.error("convexity capture failed", error); return { ran:[] as string[], errors:[String(error)] }; });
  const aiReviews = await maybeRunScheduledReviews().catch(error => { console.error("ai reviews failed", error); return [] as string[]; });
  // Historical replay backtest: one queued session per tick, on minutes clear of the
  // heavy refreshes (%15), the digest (:05/:35) and the escalation checks (%5).
  const replay = minute % 5 === 3 ? await runConvexityReplays().catch(error => { console.error("convexity replay failed", error); return { processed:null, queued:-1, error:String(error) }; }) : null;
  // Sector money-flow read every 5 minutes, offset from the replay/digest/escalation minutes.
  const sectors = minute % 5 === 1 ? await runSectorFlow().catch(error => { console.error("sector flow failed", error); return { fired:[] as string[], errors:[String(error)] }; }) : null;
  // Ad-hoc research fetch queue: one job per tick on its own light minute.
  const research = minute % 5 === 4 ? await runResearchFetches().catch(error => { console.error("research fetch failed", error); return { processed:null, error:String(error) }; }) : null;
  // Post-trade autopsies: stage new closed trades and analyze those whose tape arrived.
  const reviews = minute % 15 === 7 ? await runTradeReviews().catch(error => { console.error("trade reviews failed", error); return { staged:0, analyzed:[] as string[] }; }) : null;
  // Heartbeat: consecutive job failures page the user instead of dying in this JSON.
  await reportJobHealth({
    refresh: results.flatMap(result => result.status === "rejected" ? [String(result.reason)] : []),
    radar: radar.errors ?? [],
    surge: surge.errors ?? [],
    convexity: convexity.errors ?? [],
    sectors: sectors === null ? null : (sectors.errors ?? []),
    replay: replay === null ? null : (replay.error ? [replay.error] : []),
    research: research === null ? null : (research.error ? [research.error] : []),
  }).catch(error => console.error("heartbeat failed", error));
  return Response.json({ ok:results.every(result => result.status === "fulfilled"), refreshed:["SPY","SPX",...watchGroup], longHorizons:includeLongHorizons, autoEntry, rhAutoEntry, radar, surge, metals, convexity, replay, sectors, research, reviews, aiReviews, notify, at:new Date().toISOString() });
}

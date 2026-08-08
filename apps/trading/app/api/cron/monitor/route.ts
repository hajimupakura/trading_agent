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
  const radar = await runMarketRadar().catch(error => { console.error("market radar failed", error); return { fired:[] as string[], errors:[String(error)] }; });
  // Post-close surge sweep (16:02-16:25): the measured breakout trigger on SPY + watchlist.
  const surge = await runSurgeRadar().catch(error => { console.error("surge radar failed", error); return { fired:[] as string[], errors:[String(error)] }; });
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
  return Response.json({ ok:results.every(result => result.status === "fulfilled"), refreshed:["SPY","SPX",...watchGroup], longHorizons:includeLongHorizons, radar, surge, convexity, replay, sectors, research, reviews, aiReviews, notify, at:new Date().toISOString() });
}

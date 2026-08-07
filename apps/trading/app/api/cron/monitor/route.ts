import { refreshCommandCenter } from "@/lib/options/command-center";
import { refreshWatchSnapshot } from "@/lib/options/watchlist";
import { WATCH_UNDERLYINGS } from "@/lib/options/types";
import { runMarketRadar } from "@/lib/options/market-radar";
import { maybeRunScheduledReviews } from "@/lib/ai/review";
import { dispatchInstantAlerts } from "@/lib/notify/dispatch";
import { runConvexityCapture } from "@/lib/options/convexity";

export const maxDuration = 60;
export async function GET(request: Request) {
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) return new Response("Unauthorized", { status:401 });
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
  const convexity = await runConvexityCapture().catch(error => { console.error("convexity capture failed", error); return { ran:[] as string[], errors:[String(error)] }; });
  const aiReviews = await maybeRunScheduledReviews().catch(error => { console.error("ai reviews failed", error); return [] as string[]; });
  const notify = await dispatchInstantAlerts().catch(error => { console.error("alert dispatch failed", error); return { sent:0, digestPending:0 }; });
  return Response.json({ ok:results.every(result => result.status === "fulfilled"), refreshed:["SPY","SPX",...watchGroup], longHorizons:includeLongHorizons, radar, convexity, aiReviews, notify, at:new Date().toISOString() });
}

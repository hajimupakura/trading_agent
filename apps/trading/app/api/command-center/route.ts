import { refreshCommandCenter } from "@/lib/options/command-center";
import { readWatchSnapshot, refreshWatchSnapshot } from "@/lib/options/watchlist";
import { TRADE_UNDERLYINGS, WATCH_UNDERLYINGS, type TradeUnderlying, type WatchUnderlying } from "@/lib/options/types";
import { getAuthenticatedUser } from "@/lib/supabase/auth";
import {loadRiskSettings} from "@/lib/settings/risk-settings";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const user=await getAuthenticatedUser();if(!user) return Response.json({ error:"Unauthorized" }, { status:401 });
  const symbol = new URL(request.url).searchParams.get("underlying") ?? "SPY";
  // Watch-list tickers: the cron keeps a rotating ~5-min snapshot for background jobs,
  // but an ACTIVELY VIEWED tab deserves fresh quotes — refresh live when the stored
  // snapshot is older than 45s (the 15s UI poll then yields ~45-60s worst-case lag
  // while a tab is open, without any standing per-ticker fan-out cost when it isn't).
  if ((WATCH_UNDERLYINGS as readonly string[]).includes(symbol)) {
    const snapshot = await readWatchSnapshot(symbol as WatchUnderlying);
    if (snapshot.configured && Date.now() - snapshot.asOf > 45_000) {
      const fresh = await refreshWatchSnapshot(symbol as WatchUnderlying).catch(() => null);
      if (fresh) return Response.json(fresh, { headers:{ "Cache-Control":"no-store" } });
    }
    return Response.json(snapshot, { headers:{ "Cache-Control":"no-store" } });
  }
  const underlying: TradeUnderlying = (TRADE_UNDERLYINGS as readonly string[]).includes(symbol) ? symbol as TradeUnderlying : "SPY";
  return Response.json(await refreshCommandCenter(underlying,await loadRiskSettings(user.id)), { headers:{ "Cache-Control":"no-store" } });
}

import { refreshCommandCenter } from "@/lib/options/command-center";
import { readWatchSnapshot } from "@/lib/options/watchlist";
import { TRADE_UNDERLYINGS, WATCH_UNDERLYINGS, type TradeUnderlying, type WatchUnderlying } from "@/lib/options/types";
import { getAuthenticatedUser } from "@/lib/supabase/auth";
import {loadRiskSettings} from "@/lib/settings/risk-settings";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const user=await getAuthenticatedUser();if(!user) return Response.json({ error:"Unauthorized" }, { status:401 });
  const symbol = new URL(request.url).searchParams.get("underlying") ?? "SPY";
  // Watch-list tickers are served from the cron-maintained snapshot (no live fan-out per poll).
  if ((WATCH_UNDERLYINGS as readonly string[]).includes(symbol)) {
    return Response.json(await readWatchSnapshot(symbol as WatchUnderlying), { headers:{ "Cache-Control":"no-store" } });
  }
  const underlying: TradeUnderlying = (TRADE_UNDERLYINGS as readonly string[]).includes(symbol) ? symbol as TradeUnderlying : "SPY";
  return Response.json(await refreshCommandCenter(underlying,await loadRiskSettings(user.id)), { headers:{ "Cache-Control":"no-store" } });
}

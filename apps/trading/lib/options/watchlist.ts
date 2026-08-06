import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getMarketState, getHorizonChains } from "./provider";
import type { CommandCenter, WatchUnderlying } from "./types";

// Watch-list tickers are MONITOR-ONLY: no signals are generated and nothing here can
// reach the trading path (the paper-trading route accepts SPY/SPX only, and the risk
// gate restricts execution further). Refreshed by the cron on a rotating schedule.
export async function refreshWatchSnapshot(symbol: WatchUnderlying): Promise<CommandCenter> {
  if (!process.env.MASSIVE_API_KEY) return { configured:false, asOf:Date.now(), market:null, spotPrice:null, contracts:[], signal:null, errors:["MASSIVE_API_KEY is not configured"] };
  const [marketResult, chainResult] = await Promise.allSettled([
    getMarketState(symbol),
    getHorizonChains(symbol, ["NEAR", "3M", "6M", "9M", "1Y"]),
  ]);
  const market = marketResult.status === "fulfilled" ? marketResult.value : null;
  const contracts = chainResult.status === "fulfilled" ? chainResult.value : [];
  const spotPrice = market?.displayPrice ?? contracts.find(contract => contract.underlyingPrice != null)?.underlyingPrice ?? null;
  const errors = [marketResult, chainResult].flatMap(result => result.status === "rejected" ? [String(result.reason)] : []);
  const snapshot: CommandCenter = { configured:true, asOf:Date.now(), market, spotPrice, contracts:contracts.slice(0, 320), signal:null, errors };
  const { error } = await createAdminClient().from("options_monitor_snapshots").upsert({ underlying:symbol, payload:snapshot, updated_at:new Date(snapshot.asOf).toISOString() });
  if (error) errors.push(`Snapshot persistence: ${error.message}`);
  return snapshot;
}

export async function readWatchSnapshot(symbol: WatchUnderlying): Promise<CommandCenter> {
  const { data, error } = await createAdminClient().from("options_monitor_snapshots").select("payload").eq("underlying", symbol).maybeSingle();
  if (error) return { configured:false, asOf:Date.now(), market:null, spotPrice:null, contracts:[], signal:null, errors:[error.message] };
  if (!data) return { configured:true, asOf:Date.now(), market:null, spotPrice:null, contracts:[], signal:null, errors:["No snapshot yet — the monitor refreshes this ticker every few minutes while the cron runs"] };
  return data.payload as CommandCenter;
}

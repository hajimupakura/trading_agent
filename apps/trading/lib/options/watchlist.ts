import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getMarketState, getOptionChain, getHorizonChains } from "./provider";
import type { CommandCenter, WatchUnderlying } from "./types";

// Watch-list tickers are MONITOR-ONLY: no signals are generated and nothing here can
// reach the trading path (the paper-trading route accepts SPY/SPX only, and the risk
// gate restricts execution further). Refreshed by the cron on a rotating schedule.
export async function refreshWatchSnapshot(symbol: WatchUnderlying): Promise<CommandCenter> {
  if (!process.env.MASSIVE_API_KEY) return { configured:false, asOf:Date.now(), market:null, spotPrice:null, contracts:[], signal:null, errors:["MASSIVE_API_KEY is not configured"] };
  // Same layout as SPY/SPX: a 0-2 DTE chain plus the 1M/3M/6M/9M/1Y horizons.
  const [marketResult, shortResult, longResult] = await Promise.allSettled([
    getMarketState(symbol),
    getOptionChain(symbol, undefined, { monitorOnly:true }),
    getHorizonChains(symbol, ["1M", "3M", "6M", "9M", "1Y"]),
  ]);
  const market = marketResult.status === "fulfilled" ? marketResult.value : null;
  const shortContracts = shortResult.status === "fulfilled" ? shortResult.value : [];
  const longContracts = longResult.status === "fulfilled" ? longResult.value : [];
  const contractsByDte = ([0,1,2] as const).flatMap(dte => shortContracts.filter(contract => contract.dte === dte).slice(0,40));
  const contracts = [...contractsByDte, ...longContracts.slice(0, 400)];
  const spotPrice = market?.displayPrice ?? contracts.find(contract => contract.underlyingPrice != null)?.underlyingPrice ?? null;
  const errors = [marketResult, shortResult, longResult].flatMap(result => result.status === "rejected" ? [String(result.reason)] : []);
  const snapshot: CommandCenter = { configured:true, asOf:Date.now(), market, spotPrice, contracts, signal:null, errors };
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

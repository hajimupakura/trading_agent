import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getMarketState, getOptionChain, getHorizonChains } from "./provider";
import { scanUnusualFlow } from "./flow-scan";
import { generateSignal } from "./signal";
import { rankContracts } from "./ranker";
import { DEFAULT_RISK_SETTINGS } from "@/lib/settings/config";
import type { CommandCenter, WatchUnderlying } from "./types";

// Watch-list tickers now generate ENGINE SIGNALS too (same ORB/trend-day logic as SPY)
// and can be traded autonomously on the PAPER account when autoEntriesEnabled is on.
// The signal path re-screens contracts with the STRICT trading filters (volume, spread,
// freshness, delta band) — the relaxed monitorOnly screening remains display-only and
// can never pick a tradeable contract. Refreshed by the cron on a rotating schedule.
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
  // Cap per expiration session actually present (Fridays fetch Fri/Mon/Tue, dte 0/3/4).
  const shortDtes = [...new Set(shortContracts.map(contract => contract.dte))].sort((a, b) => a - b).slice(0, 3);
  const contractsByDte = shortDtes.flatMap(dte => shortContracts.filter(contract => contract.dte === dte).slice(0,40));
  const contracts = [...contractsByDte, ...longContracts];
  const spotPrice = market?.displayPrice ?? contracts.find(contract => contract.underlyingPrice != null)?.underlyingPrice ?? null;
  const errors = [marketResult, shortResult, longResult].flatMap(result => result.status === "rejected" ? [String(result.reason)] : []);
  await scanUnusualFlow(symbol, shortContracts).catch(error => console.error("flow scan failed", error));
  // Trading-grade signal on strictly re-screened contracts.
  const strictContracts = market ? rankContracts(shortContracts, DEFAULT_RISK_SETTINGS) : [];
  const signal = market ? generateSignal(market, strictContracts, { deltaTarget:DEFAULT_RISK_SETTINGS.deltaTarget, minDte:0, trendDayEnabled:DEFAULT_RISK_SETTINGS.trendDayEntriesEnabled }) : null;
  const snapshot: CommandCenter = { configured:true, asOf:Date.now(), market, spotPrice, contracts, signal, errors };
  const admin = createAdminClient();
  const { error } = await admin.from("options_monitor_snapshots").upsert({ underlying:symbol, payload:snapshot, updated_at:new Date(snapshot.asOf).toISOString() });
  if (error) errors.push(`Snapshot persistence: ${error.message}`);
  if (signal && ["enter_call","enter_put"].includes(signal.action)) {
    const { error: signalError } = await admin.from("option_signals").upsert({ signal_id:signal.id, underlying:symbol, action:signal.action, setup:signal.setup, confidence:signal.confidence, contract_ticker:signal.contract?.ticker, fingerprint:`${signal.action}:${signal.contract?.ticker}:${signal.market.regime}`, market_snapshot:signal.market, contract_snapshot:signal.contract, reasons:signal.reasons, invalidation:signal.invalidation, generated_at:new Date(signal.generatedAt).toISOString() });
    if (signalError) errors.push(`Signal persistence: ${signalError.message}`);
  }
  return snapshot;
}

export async function readWatchSnapshot(symbol: WatchUnderlying): Promise<CommandCenter> {
  const { data, error } = await createAdminClient().from("options_monitor_snapshots").select("payload").eq("underlying", symbol).maybeSingle();
  if (error) return { configured:false, asOf:Date.now(), market:null, spotPrice:null, contracts:[], signal:null, errors:[error.message] };
  if (!data) return { configured:true, asOf:Date.now(), market:null, spotPrice:null, contracts:[], signal:null, errors:["No snapshot yet — the monitor refreshes this ticker every few minutes while the cron runs"] };
  return data.payload as CommandCenter;
}

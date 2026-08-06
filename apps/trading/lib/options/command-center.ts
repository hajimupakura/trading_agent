import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getMarketState, getOptionChain } from "./provider";
import { generateSignal } from "./signal";
import type { CommandCenter, Underlying } from "./types";

export async function refreshCommandCenter(underlying: Underlying): Promise<CommandCenter> {
  if (!process.env.MASSIVE_API_KEY) return { configured:false, asOf:Date.now(), market:null, contracts:[], signal:null, errors:["MASSIVE_API_KEY is not configured"] };
  const [marketResult, chainResult] = await Promise.allSettled([getMarketState(underlying), getOptionChain(underlying)]);
  const market = marketResult.status === "fulfilled" ? marketResult.value : null;
  const contracts = chainResult.status === "fulfilled" ? chainResult.value : [];
  if (market && underlying === "SPX") market.displayPrice = contracts.find(contract => contract.underlyingPrice != null)?.underlyingPrice ?? market.price;
  const errors = [marketResult, chainResult].flatMap(result => result.status === "rejected" ? [String(result.reason)] : []);
  const signal = market ? generateSignal(market, contracts) : null;
  const snapshot = { configured:true, asOf:Date.now(), market, contracts:contracts.slice(0, 40), signal, errors };
  const admin = createAdminClient();
  const { error } = await admin.from("options_monitor_snapshots").upsert({ underlying, payload:snapshot, updated_at:new Date(snapshot.asOf).toISOString() });
  if (error) errors.push(`Snapshot persistence: ${error.message}`);
  if (signal && ["enter_call", "enter_put"].includes(signal.action)) {
    const { error: signalError } = await admin.from("option_signals").upsert({ signal_id:signal.id, underlying, action:signal.action, setup:signal.setup, confidence:signal.confidence, contract_ticker:signal.contract?.ticker, fingerprint:`${signal.action}:${signal.contract?.ticker}:${signal.market.regime}`, market_snapshot:signal.market, contract_snapshot:signal.contract, reasons:signal.reasons, invalidation:signal.invalidation, generated_at:new Date(signal.generatedAt).toISOString() });
    if (signalError) errors.push(`Signal persistence: ${signalError.message}`);
  }
  return snapshot;
}

import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getMarketState, getOptionChain } from "./provider";
import { generateSignal } from "./signal";
import type { CommandCenter, Underlying } from "./types";
import type { RiskSettings } from "@/lib/settings/config";
import { DEFAULT_RISK_SETTINGS } from "@/lib/settings/config";

export async function refreshCommandCenter(underlying: Underlying,settings:RiskSettings=DEFAULT_RISK_SETTINGS): Promise<CommandCenter> {
  if (!process.env.MASSIVE_API_KEY) return { configured:false, asOf:Date.now(), market:null, spotPrice:null, contracts:[], signal:null, errors:["MASSIVE_API_KEY is not configured"] };
  if(!settings.allowedUnderlyings.includes(underlying))return {configured:true,asOf:Date.now(),market:null,spotPrice:null,contracts:[],signal:null,errors:[`${underlying} is disabled in risk settings`]};
  const [marketResult, chainResult] = await Promise.allSettled([getMarketState(underlying), getOptionChain(underlying,settings)]);
  const market = marketResult.status === "fulfilled" ? marketResult.value : null;
  const contracts = chainResult.status === "fulfilled" ? chainResult.value : [];
  const spotPrice=market?.displayPrice??contracts.find(contract=>contract.underlyingPrice!=null)?.underlyingPrice??null;
  const errors = [marketResult, chainResult].flatMap(result => result.status === "rejected" ? [String(result.reason)] : []);
  const signal = market ? generateSignal(market, contracts) : null;
  const contractsByDte = ([0,1,2] as const).flatMap(dte => contracts.filter(contract => contract.dte === dte).slice(0,40));
  const snapshot = { configured:true, asOf:Date.now(), market, spotPrice, contracts:contractsByDte, signal, errors };
  const admin = createAdminClient();
  const { error } = await admin.from("options_monitor_snapshots").upsert({ underlying, payload:snapshot, updated_at:new Date(snapshot.asOf).toISOString() });
  if (error) errors.push(`Snapshot persistence: ${error.message}`);
  if (signal && ["enter_call", "enter_put"].includes(signal.action)) {
    const { error: signalError } = await admin.from("option_signals").upsert({ signal_id:signal.id, underlying, action:signal.action, setup:signal.setup, confidence:signal.confidence, contract_ticker:signal.contract?.ticker, fingerprint:`${signal.action}:${signal.contract?.ticker}:${signal.market.regime}`, market_snapshot:signal.market, contract_snapshot:signal.contract, reasons:signal.reasons, invalidation:signal.invalidation, generated_at:new Date(signal.generatedAt).toISOString() });
    if (signalError) errors.push(`Signal persistence: ${signalError.message}`);
  }
  return snapshot;
}

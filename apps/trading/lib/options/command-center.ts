import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getMarketState, getOptionChain } from "./provider";
import { recordSpxSample } from "./spx-bars";
import { generateSignal } from "./signal";
import type { CommandCenter, Underlying } from "./types";
import type { RiskSettings } from "@/lib/settings/config";
import { DEFAULT_RISK_SETTINGS } from "@/lib/settings/config";

export async function refreshCommandCenter(underlying: Underlying,settings:RiskSettings=DEFAULT_RISK_SETTINGS): Promise<CommandCenter> {
  if (!process.env.MASSIVE_API_KEY) return { configured:false, asOf:Date.now(), market:null, spotPrice:null, contracts:[], signal:null, errors:["MASSIVE_API_KEY is not configured"] };
  if(!settings.allowedUnderlyings.includes(underlying))return {configured:true,asOf:Date.now(),market:null,spotPrice:null,contracts:[],signal:null,errors:[`${underlying} is disabled in risk settings`]};
  // SPX: fetch the chain first and record a spot sample so the market state
  // (which may be built from chain-sampled bars) includes the current minute.
  let marketResult:PromiseSettledResult<Awaited<ReturnType<typeof getMarketState>>>, chainResult:PromiseSettledResult<Awaited<ReturnType<typeof getOptionChain>>>;
  if (underlying === "SPX") {
    [chainResult] = await Promise.allSettled([getOptionChain(underlying,settings)]);
    if (chainResult.status === "fulfilled") await recordSpxSample(chainResult.value).catch(error => console.error("SPX sample failed", error));
    [marketResult] = await Promise.allSettled([getMarketState(underlying)]);
  } else {
    [marketResult, chainResult] = await Promise.allSettled([getMarketState(underlying), getOptionChain(underlying,settings)]);
  }
  const market = marketResult.status === "fulfilled" ? marketResult.value : null;
  const contracts = chainResult.status === "fulfilled" ? chainResult.value : [];
  const spotPrice=market?.displayPrice??contracts.find(contract=>contract.underlyingPrice!=null)?.underlyingPrice??null;
  const errors = [marketResult, chainResult].flatMap(result => result.status === "rejected" ? [String(result.reason)] : []);
  // Inside the late-day swing window, only 1-2 DTE contracts are candidates (0DTE dies at the close).
  const etParts = new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date());
  const etMinutes = Number(etParts.find(part=>part.type==="hour")?.value)*60 + Number(etParts.find(part=>part.type==="minute")?.value);
  const inSwingWindow = settings.swingTradingEnabled && etMinutes >= settings.swingEntryStartMinutes && etMinutes <= settings.swingEntryEndMinutes;
  const signal = market ? generateSignal(market, contracts, { deltaTarget:settings.deltaTarget, minDte:inSwingWindow ? 1 : 0 }) : null;
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

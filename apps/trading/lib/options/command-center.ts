import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getHorizonChains, getMarketState, getOptionChain } from "./provider";
import { recordSpxSample } from "./spx-bars";
import { scanUnusualFlow } from "./flow-scan";
import { generateSignal } from "./signal";
import { generateScalpSignal } from "./scalp";
import type { CommandCenter, Underlying } from "./types";
import type { RiskSettings } from "@/lib/settings/config";
import { DEFAULT_RISK_SETTINGS } from "@/lib/settings/config";

export async function refreshCommandCenter(underlying: Underlying,settings:RiskSettings=DEFAULT_RISK_SETTINGS,options?:{includeLongHorizons?:boolean}): Promise<CommandCenter> {
  if (!process.env.MASSIVE_API_KEY) return { configured:false, asOf:Date.now(), market:null, spotPrice:null, contracts:[], signal:null, errors:["MASSIVE_API_KEY is not configured"] };
  if((settings.allowedUnderlyings as readonly string[]).includes(underlying)===false&&(["SPY","SPX"] as readonly string[]).includes(underlying))return {configured:true,asOf:Date.now(),market:null,spotPrice:null,contracts:[],signal:null,errors:[`${underlying} is disabled in risk settings`]};
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
  let signal = market ? generateSignal(market, contracts, { deltaTarget:settings.deltaTarget, minDte:inSwingWindow ? 1 : 0, trendDayEnabled:settings.trendDayEntriesEnabled }) : null;
  // Scalp lane: when the main engine is only watching, look for a VWAP dip-and-reclaim
  // scalp. SPY scalps trade autonomously on paper; SPX scalps alert instantly (manual
  // Robinhood play) and execute on the agentic account only when rhAutoEntriesEnabled.
  if ((underlying === "SPY" || underlying === "SPX") && settings.scalpEntriesEnabled && market && signal && !signal.action.startsWith("enter")) {
    const scalp = generateScalpSignal(market, contracts, { deltaTarget:settings.deltaTarget });
    if (scalp) signal = scalp;
  }
  // Cap per expiration session actually present — on Fridays the short chain carries
  // Fri/Mon/Tue as dte 0/3/4, not 0/1/2 (weekends have no expirations).
  const shortDtes = [...new Set(contracts.map(contract => contract.dte))].sort((a, b) => a - b).slice(0, 3);
  const contractsByDte = shortDtes.flatMap(dte => contracts.filter(contract => contract.dte === dte).slice(0,40));
  const admin = createAdminClient();
  // Long-dated (3M/6M/9M/1Y) monitoring contracts: fetched only when the cron asks
  // (every ~15 minutes); otherwise carried over from the previous snapshot. They are
  // NEVER passed to generateSignal — the 0-2 DTE strategy stays untouched.
  let longContracts:typeof contracts = [];
  if (options?.includeLongHorizons) {
    const [longResult] = await Promise.allSettled([getHorizonChains(underlying,["1M","3M","6M","9M","1Y"],settings)]);
    if (longResult.status === "fulfilled") longContracts = longResult.value; else errors.push(`Long-horizon chain: ${String(longResult.reason)}`);
  } else {
    const { data:previous } = await admin.from("options_monitor_snapshots").select("payload").eq("underlying",underlying).maybeSingle();
    longContracts = ((previous?.payload as CommandCenter|undefined)?.contracts ?? []).filter(contract => contract.dte > 7);
  }
  await scanUnusualFlow(underlying, contracts).catch(error => console.error("flow scan failed", error));
  const snapshot = { configured:true, asOf:Date.now(), market, spotPrice, contracts:[...contractsByDte, ...longContracts.slice(0,900)], signal, errors };
  const { error } = await admin.from("options_monitor_snapshots").upsert({ underlying, payload:snapshot, updated_at:new Date(snapshot.asOf).toISOString() });
  if (error) errors.push(`Snapshot persistence: ${error.message}`);
  if (signal && ["enter_call", "enter_put"].includes(signal.action)) {
    const { error: signalError } = await admin.from("option_signals").upsert({ signal_id:signal.id, underlying, action:signal.action, setup:signal.setup, confidence:signal.confidence, contract_ticker:signal.contract?.ticker, fingerprint:`${signal.action}:${signal.contract?.ticker}:${signal.market.regime}`, market_snapshot:signal.market, contract_snapshot:signal.contract, reasons:signal.reasons, invalidation:signal.invalidation, generated_at:new Date(signal.generatedAt).toISOString() });
    if (signalError) errors.push(`Signal persistence: ${signalError.message}`);
    // SPX scalps ping Telegram instantly — they are manual Robinhood plays unless the
    // real-money autonomy toggle is on. One alert per side per hour keeps chop quiet.
    if (underlying === "SPX" && signal.setup === "scalp_reclaim" && signal.contract) {
      const { data: owner } = await admin.from("profiles").select("id").limit(1).maybeSingle();
      const hourKey = new Intl.DateTimeFormat("en-CA",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",hourCycle:"h23"}).format(new Date()).replaceAll(", ","-");
      if (owner) {
        const { createAlert } = await import("@/lib/alerts/server");
        await createAlert({
          userId: owner.id, signalId: signal.id, eventKey: `scalp-spx-${signal.action}-${hourKey}`, severity: "warning",
          title: `SPX SCALP setup: ${signal.action === "enter_call" ? "dip reclaimed — call" : "pop failed — put"}`,
          body: `${signal.reasons[0]}. Candidate: ${signal.contract.ticker.replace("O:","")} asking $${signal.contract.ask.toFixed(2)}. The scalp plan: target 2x, cut at -25%, and if it hasn't worked in 30 minutes it's over. Autonomous Robinhood execution only happens if the real-money toggle is ON in Settings — otherwise this is a heads-up for a manual play.`,
          metadata: { kind: "scalp_signal", underlying, contractTicker: signal.contract.ticker, ask: signal.contract.ask },
        }).catch(error => console.error("spx scalp alert failed", error));
      }
    }
  }
  return snapshot;
}

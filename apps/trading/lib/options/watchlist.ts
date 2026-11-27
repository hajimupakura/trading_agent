import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getMarketState, getOptionChain, getHorizonChains } from "./provider";
import { scanUnusualFlow } from "./flow-scan";
import { generateSignal, generateDirectionSignal } from "./signal";
import { rankContracts } from "./ranker";
import { DEFAULT_RISK_SETTINGS } from "@/lib/settings/config";
import type { CommandCenter, WatchUnderlying } from "./types";

// Watch-list tickers now generate ENGINE SIGNALS too (same ORB/trend-day logic as SPY)
// and can be traded autonomously on the PAPER account when autoEntriesEnabled is on.
// The signal path re-screens contracts with the STRICT trading filters (volume, spread,
// freshness, delta band) — the relaxed monitorOnly screening remains display-only and
// can never pick a tradeable contract. Refreshed by the cron on a rotating schedule.
export async function refreshWatchSnapshot(symbol: WatchUnderlying, options?: { includeLongHorizons?: boolean }): Promise<CommandCenter> {
  // Chains ride Alpaca (2026-11-19). This used to gate on MASSIVE_API_KEY, which only
  // kept working because the retired key still sits in Vercel env — deleting that
  // env var would have silently killed every watch-name scan.
  if (!process.env.ALPACA_API_KEY_ID || !process.env.ALPACA_API_SECRET_KEY) return { configured:false, asOf:Date.now(), market:null, spotPrice:null, contracts:[], signal:null, errors:["Alpaca market-data keys are not configured"] };
  // Same layout as SPY/SPX: a 0-2 DTE chain plus the 1M/3M/6M/9M/1Y horizons — but
  // horizons only on the quarter-hour (2026-11-23): refetching five long chains per
  // name per 5-minute rotation was ~80% of the Alpaca call volume for data that
  // barely moves, and on the Huang-reinstatement morning it throttled us into
  // scattered single-expiry 403s. Off the quarter-hour, longs reuse the previous
  // snapshot (the command-center pattern).
  // The long-horizon fetch waits for the spot price: it lets the expiry listing ask for
  // a narrow strike band (one small request per name per day) instead of whole chains.
  const marketPromise = getMarketState(symbol);
  const longPromise = options?.includeLongHorizons !== false
    ? marketPromise.then(state => state.displayPrice ?? state.price, () => null).then(spot => getHorizonChains(symbol, ["1M", "3M", "6M", "9M", "1Y"], undefined, spot))
    : Promise.resolve(null);
  const [marketResult, shortResult, longResult] = await Promise.allSettled([
    marketPromise,
    getOptionChain(symbol, undefined, { monitorOnly:true }),
    longPromise,
  ]);
  const market = marketResult.status === "fulfilled" ? marketResult.value : null;
  const shortContracts = shortResult.status === "fulfilled" ? shortResult.value : [];
  // Long chains: a FRESH fetch stamps longRefreshedAt; anything else carries the
  // previous snapshot's longs AND its stamp forward, so staleness stays measurable.
  // Before 2026-11-27 a failed fetch fell back silently and forever — ANT showed one
  // July-2027 expiry with Tuesday's quotes on Friday, and eleven of seventeen names
  // had starved or days-old long chains with nothing saying so. blindspot.ts pages on
  // the stamp.
  const freshLong = longResult.status === "fulfilled" && longResult.value != null && longResult.value.length > 0;
  let longContracts = freshLong && longResult.status === "fulfilled" ? longResult.value ?? [] : [];
  let longRefreshedAt: number | null = freshLong ? Date.now() : null;
  let longError: string | null = longResult.status === "rejected" ? String(longResult.reason).slice(0, 200) : null;
  if (!freshLong) {
    const { data: previousRow } = await createAdminClient().from("options_monitor_snapshots").select("payload").eq("underlying", symbol).maybeSingle();
    const previous = previousRow?.payload as CommandCenter | undefined;
    const todayEt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
    longContracts = (previous?.contracts ?? []).filter(contract => contract.dte > 7 && contract.expirationDate >= todayEt);
    longRefreshedAt = previous?.longRefreshedAt ?? null;
    longError = longError ?? previous?.longError ?? null;
  }
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
  // Swarm-only trigger: only when the scan SUCCEEDED and found no contract at all in
  // the next three sessions (a failed scan is an outage, not a missing expiry). The
  // day-trade lanes read `signal` and never see this.
  const noNearExpiry = shortResult.status === "fulfilled" && shortContracts.length === 0;
  const direction = market && noNearExpiry ? generateDirectionSignal(market, { trendDayEnabled:DEFAULT_RISK_SETTINGS.trendDayEntriesEnabled }) : null;
  const swarmSignal = direction && ["enter_call","enter_put"].includes(direction.action) ? direction : null;
  const snapshot: CommandCenter = { configured:true, asOf:Date.now(), market, spotPrice, contracts, signal, errors, swarmSignal, longRefreshedAt, longError };
  const admin = createAdminClient();
  const { error } = await admin.from("options_monitor_snapshots").upsert({ underlying:symbol, payload:snapshot, updated_at:new Date(snapshot.asOf).toISOString() });
  if (error) errors.push(`Snapshot persistence: ${error.message}`);
  if (signal && ["enter_call","enter_put"].includes(signal.action)) {
    // Phase 3 stamp: the news state known at fire time rides the signal record.
    const newsContext = await import("@/lib/news/market-news").then(module => module.newsContextFor(symbol)).catch(() => null);
    const { error: signalError } = await admin.from("option_signals").upsert({ signal_id:signal.id, underlying:symbol, action:signal.action, setup:signal.setup, confidence:signal.confidence, contract_ticker:signal.contract?.ticker, fingerprint:`${signal.action}:${signal.contract?.ticker}:${signal.market.regime}`, market_snapshot:signal.market, contract_snapshot:signal.contract, reasons:signal.reasons, invalidation:signal.invalidation, generated_at:new Date(signal.generatedAt).toISOString(), news_context:newsContext });
    // console.error, not errors.push: the snapshot already persisted above, so a push
    // here reaches nobody — which is exactly how the SPY/SPX-only CHECK constraint
    // rejected every equity signal for three months without a trace (found 2026-11-23).
    if (signalError) console.error("Signal persistence failed", symbol, signalError.message);
    // Telegram buy cards (2026-11-23): watch names route through THIS function, not
    // refreshCommandCenter, so the proposal hook must live here too — without it only
    // SPY/SPX fires carded and every equity fire (the feed's 21-for-21 day on 11/20)
    // reached Telegram as text with no buttons. The module dedupes and no-ops when
    // the bot env is absent.
    {
      const { proposeTelegramTrade } = await import("@/lib/telegram-bot/propose");
      await proposeTelegramTrade(signal, snapshot).catch(error => console.error("tg proposal failed", error instanceof Error ? error.message : error));
    }
  }
  return snapshot;
}

export async function readWatchSnapshot(symbol: WatchUnderlying): Promise<CommandCenter> {
  const { data, error } = await createAdminClient().from("options_monitor_snapshots").select("payload").eq("underlying", symbol).maybeSingle();
  if (error) return { configured:false, asOf:Date.now(), market:null, spotPrice:null, contracts:[], signal:null, errors:[error.message] };
  if (!data) return { configured:true, asOf:Date.now(), market:null, spotPrice:null, contracts:[], signal:null, errors:["No snapshot yet — the monitor refreshes this ticker every few minutes while the cron runs"] };
  return data.payload as CommandCenter;
}

import "server-only";
import { getMarketState } from "./provider";
import { refreshWatchSnapshot } from "./watchlist";
import type { CommandCenter, MarketState, WatchUnderlying } from "./types";

// 1-minute trigger checks for the FAST single names. The 5-minute watchlist rotation
// can miss narrow entry windows on quick movers; this path checks JUST the stock bars
// (2 free Alpaca calls per name) every minute, and only when a rough structural
// trigger passes does it pay for the full refresh (option chain + strict signal),
// whose result feeds the same auto-entry lane as everything else.
//
// The rough trigger is a deliberate SUPERSET of the real signal gates (structure only,
// no momentum/volume/contract checks) — false positives cost one chain fetch; the
// strict engine still makes every actual decision. Cost math (2026-08-12): ~8-10
// Alpaca req/min added vs the 200/min free cap; Massive unchanged except on fires.

export const FAST_SYMBOLS: WatchUnderlying[] = ["NVDA", "TSLA", "SPCX", "QQQ", "GOOGL"];

function roughTrigger(market: MarketState): boolean {
  const bars = market.bars;
  if (bars.length < 20) return false;
  const lastTwo = bars.slice(-2);
  const breakoutUp = lastTwo.every(bar => bar.close > market.openingRangeHigh && bar.close > market.referencePrice);
  const breakoutDown = lastTwo.every(bar => bar.close < market.openingRangeLow && bar.close < market.referencePrice);
  const last30 = bars.slice(-30);
  const persistence = last30.length >= 30 && (
    last30.every(bar => bar.close > market.openingRangeHigh) ||
    last30.every(bar => bar.close < market.openingRangeLow)
  );
  return breakoutUp || breakoutDown || persistence;
}

// Returns full snapshots for fast names whose rough trigger fired this minute
// (skipping any already refreshed by this tick's rotation).
export async function runFastTriggers(alreadyRefreshed: string[]): Promise<Array<{ underlying: WatchUnderlying; snapshot: CommandCenter }>> {
  const due = FAST_SYMBOLS.filter(symbol => !alreadyRefreshed.includes(symbol));
  const fired: Array<{ underlying: WatchUnderlying; snapshot: CommandCenter }> = [];
  const checks = await Promise.allSettled(due.map(async symbol => {
    const market = await getMarketState(symbol);
    return { symbol, triggered: roughTrigger(market) };
  }));
  for (const check of checks) {
    if (check.status !== "fulfilled" || !check.value.triggered) continue;
    try {
      const snapshot = await refreshWatchSnapshot(check.value.symbol);
      fired.push({ underlying: check.value.symbol, snapshot });
    } catch (error) {
      console.error("fast trigger refresh failed", check.value.symbol, error);
    }
  }
  return fired;
}

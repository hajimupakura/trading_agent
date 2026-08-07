import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAlert } from "@/lib/alerts/server";
import type { Contract, Underlying } from "./types";

// Unusual options-flow detection over the chains the scanner already pulls.
// Deterministic v1 thresholds (no historical baseline yet):
//   - Contract flow: today's volume >= 1,500 contracts AND >= 3x open interest
//     AND premium traded >= $400k -> "fresh aggressive positioning".
//   - Chain skew: call/put volume ratio beyond 3:1 (or 1:3) on meaningful volume.
// Alerts are deduped per contract/underlying per day via event keys.

const CONTRACT_MIN_VOLUME = 1500;
const CONTRACT_VOL_OI_RATIO = 3;
const CONTRACT_MIN_PREMIUM = 400_000;
const SKEW_RATIO = 3;
const SKEW_MIN_TOTAL_VOLUME: Record<string, number> = { SPY: 100_000, SPX: 20_000 };
const SKEW_DEFAULT_MIN_VOLUME = 5_000;

const etDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());

async function ownerId(): Promise<string | null> {
  const { data } = await createAdminClient().from("profiles").select("id").limit(1).maybeSingle();
  return data?.id ?? null;
}

export async function scanUnusualFlow(underlying: Underlying, contracts: Contract[]): Promise<void> {
  if (!contracts.length) return;
  const userId = await ownerId();
  if (!userId) return;
  const today = etDate();

  // Per-contract aggressive positioning (short-dated book only — long-dated OI is stale by design).
  const shortDated = contracts.filter(contract => contract.dte <= 7);
  for (const contract of shortDated) {
    const premium = contract.volume * contract.midpoint * 100;
    if (contract.volume >= CONTRACT_MIN_VOLUME && contract.volume >= CONTRACT_VOL_OI_RATIO * Math.max(contract.openInterest, 1) && premium >= CONTRACT_MIN_PREMIUM) {
      await createAlert({
        userId, eventKey: `flow-${contract.ticker}-${today}`, severity: "warning",
        title: `Unusual flow: ${underlying} ${contract.strike}${contract.side === "call" ? "C" : "P"} ${contract.expirationDate}`,
        body: `${contract.volume.toLocaleString()} contracts traded vs ${contract.openInterest.toLocaleString()} open interest (${(contract.volume / Math.max(contract.openInterest, 1)).toFixed(1)}x) — roughly $${(premium / 1_000_000).toFixed(1)}M in premium. Heavy fresh positioning in a ${contract.dte}DTE ${contract.side}. Flow is information, not instruction: check it against the engine's read before acting.`,
        metadata: { ticker: contract.ticker, volume: contract.volume, openInterest: contract.openInterest, premium, dte: contract.dte },
      }).catch(() => undefined);
    }
  }

  // Chain-level call/put skew (short-dated volume only).
  const callVolume = shortDated.filter(contract => contract.side === "call").reduce((sum, contract) => sum + contract.volume, 0);
  const putVolume = shortDated.filter(contract => contract.side === "put").reduce((sum, contract) => sum + contract.volume, 0);
  const total = callVolume + putVolume;
  const minTotal = SKEW_MIN_TOTAL_VOLUME[underlying] ?? SKEW_DEFAULT_MIN_VOLUME;
  if (total >= minTotal && putVolume > 0 && callVolume > 0) {
    const ratio = callVolume / putVolume;
    if (ratio >= SKEW_RATIO || ratio <= 1 / SKEW_RATIO) {
      const bullish = ratio >= SKEW_RATIO;
      // Detailed report: the exact contracts driving the skew, by volume.
      const describe = (contract: Contract) => `${contract.expirationDate.slice(5)} ${contract.strike}${contract.side === "call" ? "C" : "P"}: ${contract.volume.toLocaleString()} vol / ${contract.openInterest.toLocaleString()} OI / ~$${((contract.volume * contract.midpoint * 100) / 1_000_000).toFixed(1)}M premium`;
      const topOf = (side: "call" | "put") => shortDated.filter(contract => contract.side === side).sort((a, b) => b.volume - a.volume).slice(0, 3);
      const topCalls = topOf("call"); const topPuts = topOf("put");
      const detail = shortDated.slice().sort((a, b) => b.volume - a.volume).slice(0, 15).map(contract => ({
        ticker: contract.ticker, side: contract.side, strike: contract.strike, expirationDate: contract.expirationDate,
        dte: contract.dte, volume: contract.volume, openInterest: contract.openInterest,
        premiumTraded: Math.round(contract.volume * contract.midpoint * 100),
        midpoint: contract.midpoint, delta: contract.delta, impliedVolatility: contract.impliedVolatility,
      }));
      await createAlert({
        userId, eventKey: `flow-skew-${underlying}-${bullish ? "call" : "put"}-${today}`, severity: "info",
        title: `${underlying} flow skew: ${bullish ? "calls" : "puts"} ${bullish ? ratio.toFixed(1) : (1 / ratio).toFixed(1)}x ${bullish ? "puts" : "calls"}`,
        body: `Short-dated ${underlying}: ${callVolume.toLocaleString()} call vol vs ${putVolume.toLocaleString()} put vol. Top calls — ${topCalls.map(describe).join(" · ") || "none"}. Top puts — ${topPuts.map(describe).join(" · ") || "none"}. Search any strike in the leaderboard and click the row for full detail and a trade ticket.`,
        metadata: { underlying, callVolume, putVolume, ratio, topContracts: detail },
      }).catch(() => undefined);
    }
  }
}

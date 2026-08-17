import type { Contract } from "./types";
import type { RiskSettings } from "@/lib/settings/config";
import { DEFAULT_RISK_SETTINGS } from "@/lib/settings/config";

type RawContract = Omit<Contract, "liquidityScore" | "eligible" | "rejectionReasons">;
const clamp = (value: number, maximum = 100) => Math.min(maximum, Math.max(0, value));
export function rankContracts(contracts: RawContract[], settings:RiskSettings=DEFAULT_RISK_SETTINGS, options?: { monitorOnly?: boolean }): Contract[] {
  const monitorOnly = options?.monitorOnly ?? false;
  const maxVolume = Math.max(1, ...contracts.map(contract => contract.volume));
  const maxOi = Math.max(1, ...contracts.map(contract => contract.openInterest));
  return contracts.map(contract => {
    const rejectionReasons: string[] = [];
    // monitorOnly: relaxed screening for watch-list/long-dated views — these contracts can
    // never reach the trading path (risk gate + SPY-only execution), so intraday execution
    // filters (0-2 DTE, session volume, 30s quote freshness, delta band) do not apply.
    // Single names (Friday-only weeklies like GOOGL/SPCX/MU) may trade their shortest
    // available expiry up to 5 DTE — the intraday lifecycle (stop/trail/15:10 flat) is
    // identical; longer expiry only mutes the leverage. SPY/SPX stay strictly 0-2 DTE
    // per the replay-validated config.
    // <=14 (was <=5, 2026-08-17): SPCX/SNDK carry NO weekly some Mondays — their prior
    // Friday expiry dies and only a ~11-DTE series exists, which the 5-day rule banned
    // outright, freezing the engine out of a +5-7% morning. The picker still prefers
    // the shortest listed expiry, so this only bites when nothing shorter exists.
    const singleNameOk = !["SPY","SPX"].includes(contract.underlying) && contract.dte <= 14;
    if (!monitorOnly && !settings.allowedDte.includes(contract.dte as 0|1|2) && !singleNameOk) rejectionReasons.push(contract.dte > 2 ? "Next-session expiry — the engine trades 0-2 calendar DTE; manual entries only" : "DTE is disabled in risk settings");
    if (contract.bid <= 0 || contract.ask <= 0 || contract.ask < contract.bid) rejectionReasons.push("Invalid market");
    if (contract.spreadPct > (monitorOnly ? 25 : settings.maxSpreadPct)) rejectionReasons.push(`Spread exceeds ${monitorOnly ? 25 : settings.maxSpreadPct}%`);
    if (!monitorOnly && contract.volume < settings.minContractVolume) rejectionReasons.push(`Volume below ${settings.minContractVolume}`);
    if (contract.midpoint < .1) rejectionReasons.push("Premium below $0.10");
    // NO ask ceiling for single names (2026-08-17, third and final iteration): $8 flat
    // banned SNDK's whole chain, 1.1% of spot banned it on gap days, 2% banned its
    // 11-DTE series. The ceiling kept doing position-sizing's job by vetoing contracts
    // instead of sizing them — affordability is enforced where it belongs (per-venue
    // sizing caps decide HOW MANY, never whether the chain exists). SPY/SPX keep the
    // flat replay-validated cap; the blind-spot invariant pages if a liquid chain ever
    // rejects 100% of contracts.
    if (!monitorOnly && ["SPY","SPX"].includes(contract.underlying) && contract.ask > settings.maxOptionAsk) rejectionReasons.push(`Ask exceeds $${settings.maxOptionAsk.toFixed(2)}`);
    if (!monitorOnly && (contract.quoteUpdatedAt == null || Date.now() - contract.quoteUpdatedAt > 30_000)) rejectionReasons.push("Quote is older than 30 seconds");
    if (!monitorOnly && contract.delta != null && (Math.abs(contract.delta) < .25 || Math.abs(contract.delta) > .70)) rejectionReasons.push("Absolute delta outside 0.25–0.70");
    const score = clamp(
      Math.log1p(contract.volume) / Math.log1p(maxVolume) * 40 +
      Math.log1p(contract.openInterest) / Math.log1p(maxOi) * 12 +
      clamp(contract.volumeToOpenInterest * 20, 18) + clamp(20 - contract.spreadPct * 1.5, 20) +
      (contract.delta == null ? 0 : clamp(10 - Math.abs(Math.abs(contract.delta) - .45) * 25, 10)),
    );
    return { ...contract, liquidityScore: Math.round(score), eligible: !rejectionReasons.length, rejectionReasons };
  }).sort((a, b) => b.liquidityScore - a.liquidityScore || b.volume - a.volume);
}

import type { Contract } from "./types";
import type { RiskSettings } from "@/lib/settings/config";
import { DEFAULT_RISK_SETTINGS } from "@/lib/settings/config";

type RawContract = Omit<Contract, "liquidityScore" | "eligible" | "rejectionReasons">;
const clamp = (value: number, maximum = 100) => Math.min(maximum, Math.max(0, value));
export function rankContracts(contracts: RawContract[], settings:RiskSettings=DEFAULT_RISK_SETTINGS): Contract[] {
  const maxVolume = Math.max(1, ...contracts.map(contract => contract.volume));
  const maxOi = Math.max(1, ...contracts.map(contract => contract.openInterest));
  return contracts.map(contract => {
    const rejectionReasons: string[] = [];
    if (!settings.allowedDte.includes(contract.dte as 0|1|2)) rejectionReasons.push("DTE is disabled in risk settings");
    if (contract.bid <= 0 || contract.ask <= 0 || contract.ask < contract.bid) rejectionReasons.push("Invalid market");
    if (contract.spreadPct > settings.maxSpreadPct) rejectionReasons.push(`Spread exceeds ${settings.maxSpreadPct}%`);
    if (contract.volume < settings.minContractVolume) rejectionReasons.push(`Volume below ${settings.minContractVolume}`);
    if (contract.midpoint < .1) rejectionReasons.push("Premium below $0.10");
    if (contract.ask > settings.maxOptionAsk) rejectionReasons.push(`Ask exceeds $${settings.maxOptionAsk.toFixed(2)}`);
    if (contract.quoteUpdatedAt == null || Date.now() - contract.quoteUpdatedAt > 30_000) rejectionReasons.push("Quote is older than 30 seconds");
    if (contract.delta != null && (Math.abs(contract.delta) < .25 || Math.abs(contract.delta) > .70)) rejectionReasons.push("Absolute delta outside 0.25–0.70");
    const score = clamp(
      Math.log1p(contract.volume) / Math.log1p(maxVolume) * 40 +
      Math.log1p(contract.openInterest) / Math.log1p(maxOi) * 12 +
      clamp(contract.volumeToOpenInterest * 20, 18) + clamp(20 - contract.spreadPct * 1.5, 20) +
      (contract.delta == null ? 0 : clamp(10 - Math.abs(Math.abs(contract.delta) - .45) * 25, 10)),
    );
    return { ...contract, liquidityScore: Math.round(score), eligible: !rejectionReasons.length, rejectionReasons };
  }).sort((a, b) => b.liquidityScore - a.liquidityScore || b.volume - a.volume);
}

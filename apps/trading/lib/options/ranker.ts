import type { Contract } from "./types";

type RawContract = Omit<Contract, "liquidityScore" | "eligible" | "rejectionReasons">;
const clamp = (value: number, maximum = 100) => Math.min(maximum, Math.max(0, value));
export function rankContracts(contracts: RawContract[]): Contract[] {
  const maxVolume = Math.max(1, ...contracts.map(contract => contract.volume));
  const maxOi = Math.max(1, ...contracts.map(contract => contract.openInterest));
  return contracts.map(contract => {
    const rejectionReasons: string[] = [];
    if (contract.dte < 0 || contract.dte > 2) rejectionReasons.push("Outside 0–2 DTE");
    if (contract.bid <= 0 || contract.ask <= 0 || contract.ask < contract.bid) rejectionReasons.push("Invalid market");
    if (contract.spreadPct > 12) rejectionReasons.push("Spread exceeds 12%");
    if (contract.volume < 25) rejectionReasons.push("Volume below 25");
    if (contract.midpoint < .1) rejectionReasons.push("Premium below $0.10");
    if (contract.ask > 8) rejectionReasons.push("Ask exceeds $8.00");
    const score = clamp(
      Math.log1p(contract.volume) / Math.log1p(maxVolume) * 40 +
      Math.log1p(contract.openInterest) / Math.log1p(maxOi) * 12 +
      clamp(contract.volumeToOpenInterest * 20, 18) + clamp(20 - contract.spreadPct * 1.5, 20) +
      (contract.delta == null ? 0 : clamp(10 - Math.abs(Math.abs(contract.delta) - .45) * 25, 10)),
    );
    return { ...contract, liquidityScore: Math.round(score), eligible: !rejectionReasons.length, rejectionReasons };
  }).sort((a, b) => b.liquidityScore - a.liquidityScore || b.volume - a.volume);
}

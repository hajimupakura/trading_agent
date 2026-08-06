import type { OptionContractSnapshot } from "./types";

export interface RawOptionContract extends Omit<OptionContractSnapshot, "liquidityScore" | "eligible" | "rejectionReasons"> {}

const clamp = (value: number, min = 0, max = 100) => Math.min(max, Math.max(min, value));

export function rankOptionContracts(contracts: RawOptionContract[]): OptionContractSnapshot[] {
  const maxVolume = Math.max(1, ...contracts.map(contract => contract.volume));
  const maxOpenInterest = Math.max(1, ...contracts.map(contract => contract.openInterest));

  return contracts
    .map(contract => {
      const rejectionReasons: string[] = [];
      if (contract.dte < 0 || contract.dte > 2) rejectionReasons.push("Outside 0-2 DTE window");
      if (contract.bid <= 0 || contract.ask <= 0 || contract.ask < contract.bid) rejectionReasons.push("Invalid or one-sided market");
      if (contract.spreadPct > 12) rejectionReasons.push("Spread exceeds 12%");
      if (contract.volume < 25) rejectionReasons.push("Volume below 25 contracts");
      if (contract.midpoint < 0.1) rejectionReasons.push("Premium below $0.10");
      if (contract.ask > 8) rejectionReasons.push("Ask exceeds $8.00 ($800 standard-contract debit)");

      const volumeScore = Math.log1p(contract.volume) / Math.log1p(maxVolume) * 40;
      const oiScore = Math.log1p(contract.openInterest) / Math.log1p(maxOpenInterest) * 12;
      const flowScore = clamp(contract.volumeToOpenInterest * 20, 0, 18);
      const spreadScore = clamp(20 - contract.spreadPct * 1.5, 0, 20);
      const deltaScore = contract.delta == null
        ? 0
        : clamp(10 - Math.abs(Math.abs(contract.delta) - 0.45) * 25, 0, 10);
      const liquidityScore = Math.round(clamp(volumeScore + oiScore + flowScore + spreadScore + deltaScore));

      return {
        ...contract,
        liquidityScore,
        eligible: rejectionReasons.length === 0,
        rejectionReasons,
      };
    })
    .sort((a, b) => b.liquidityScore - a.liquidityScore || b.volume - a.volume);
}

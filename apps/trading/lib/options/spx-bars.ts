import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Bar, Contract } from "./types";

// SPX index bars self-assembled from the option chain the every-minute cron already fetches.
// Used when the Massive entitlement lacks live index aggregates. Spot preference:
// snapshot underlying price, else ATM put-call parity (SPX ~= strike + call mid - put mid,
// accurate for a cash-settled European index near expiry).

const etMinutes = (date: Date) => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  return Number(parts.find(part => part.type === "hour")?.value) * 60 + Number(parts.find(part => part.type === "minute")?.value);
};
const etDate = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(date);
const median = (values: number[]) => { const sorted = values.slice().sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]!; };

export function deriveSpxSpot(contracts: Contract[]): { price: number; source: "underlying_asset" | "put_call_parity" } | null {
  const direct = contracts.map(contract => contract.underlyingPrice).filter((price): price is number => price != null && Number.isFinite(price) && price > 0);
  if (direct.length) return { price: median(direct), source: "underlying_asset" };
  const nearest = Math.min(...contracts.map(contract => contract.dte));
  const byStrike = new Map<number, { call?: number; put?: number }>();
  for (const contract of contracts) {
    if (contract.dte !== nearest || contract.bid <= 0 || contract.ask <= 0) continue;
    const entry = byStrike.get(contract.strike) ?? {};
    entry[contract.side] = (contract.bid + contract.ask) / 2;
    byStrike.set(contract.strike, entry);
  }
  const estimates = [...byStrike.entries()]
    .filter(([, pair]) => pair.call != null && pair.put != null)
    .map(([strike, pair]) => ({ estimate: strike + pair.call! - pair.put!, atmDistance: Math.abs(pair.call! - pair.put!) }))
    .sort((a, b) => a.atmDistance - b.atmDistance)
    .slice(0, 7)
    .map(item => item.estimate)
    .filter(value => Number.isFinite(value) && value > 0);
  return estimates.length ? { price: median(estimates), source: "put_call_parity" } : null;
}

export async function recordSpxSample(contracts: Contract[], now = new Date()): Promise<void> {
  const minutes = etMinutes(now);
  if (minutes < 570 || minutes >= 960) return; // regular session only
  const spot = deriveSpxSpot(contracts);
  if (!spot) return;
  const barTime = new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString();
  const { error } = await createAdminClient().from("index_bar_samples").upsert(
    { symbol: "SPX", bar_time: barTime, price: spot.price, source: spot.source },
    { onConflict: "symbol,bar_time" },
  );
  if (error) throw new Error(`SPX sample persistence failed: ${error.message}`);
}

export async function getSampledSpxBars(now = new Date()): Promise<Bar[]> {
  const day = etDate(now);
  const { data, error } = await createAdminClient()
    .from("index_bar_samples")
    .select("bar_time,price")
    .eq("symbol", "SPX")
    .gte("bar_time", new Date(now.getTime() - 24 * 60 * 60_000).toISOString())
    .order("bar_time", { ascending: true });
  if (error) throw new Error(`SPX sample read failed: ${error.message}`);
  const rows = (data ?? []).filter(row => etDate(new Date(row.bar_time)) === day);
  return rows.map((row, index) => {
    const close = Number(row.price);
    const open = index > 0 ? Number(rows[index - 1]!.price) : close;
    return { timestamp: Date.parse(row.bar_time), open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 0, vwap: null };
  });
}

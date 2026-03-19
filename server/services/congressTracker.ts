import axios from "axios";

/**
 * Congressional Stock Trading Tracker
 * Uses House Stock Watcher (free, no API key).
 * Data has a ~45-day disclosure delay.
 *
 * Source: https://house-stock-watcher-data.s3-us-west-2.amazonaws.com/data/all_transactions.json
 */

export interface CongressTrade {
  representative: string;
  party: string;
  state: string;
  ticker: string;
  transactionDate: string;
  disclosureDate: string;
  type: string; // "purchase" | "sale_full" | "sale_partial" | etc.
  amount: string; // "$1,001 - $15,000" range format
  description: string;
}

// Cache the full dataset (updates once daily)
let cachedData: CongressTrade[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function fetchAllTrades(): Promise<CongressTrade[]> {
  const now = Date.now();
  if (cachedData && now - cacheTimestamp < CACHE_TTL) return cachedData;

  try {
    const res = await axios.get(
      "https://house-stock-watcher-data.s3-us-west-2.amazonaws.com/data/all_transactions.json",
      { timeout: 30_000 },
    );

    if (!Array.isArray(res.data)) return cachedData || [];

    cachedData = res.data.map((t: any) => ({
      representative: t.representative || "",
      party: t.party || "",
      state: t.state || "",
      ticker: (t.ticker || "").replace("--", "").trim(),
      transactionDate: t.transaction_date || "",
      disclosureDate: t.disclosure_date || "",
      type: t.type || "",
      amount: t.amount || "",
      description: t.description || "",
    }));
    cacheTimestamp = now;
    console.log(`[Congress] Loaded ${cachedData!.length} trades`);
    return cachedData!;
  } catch (error: any) {
    console.error("[Congress] Failed to fetch trades:", error.message);
    return cachedData || [];
  }
}

/**
 * Get recent Congressional trades (last N days).
 */
export async function getRecentCongressTrades(daysBack: number = 30, limit: number = 50): Promise<CongressTrade[]> {
  const trades = await fetchAllTrades();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);
  const cutoffStr = cutoff.toISOString().split("T")[0]!;

  return trades
    .filter(t => t.transactionDate >= cutoffStr && t.ticker.length > 0 && t.ticker !== "N/A")
    .sort((a, b) => b.transactionDate.localeCompare(a.transactionDate))
    .slice(0, limit);
}

/**
 * Get Nancy Pelosi's recent trades specifically.
 */
export async function getPelosiTrades(daysBack: number = 90): Promise<CongressTrade[]> {
  const trades = await fetchAllTrades();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);
  const cutoffStr = cutoff.toISOString().split("T")[0]!;

  return trades
    .filter(t =>
      t.representative.toLowerCase().includes("pelosi") &&
      t.transactionDate >= cutoffStr &&
      t.ticker.length > 0,
    )
    .sort((a, b) => b.transactionDate.localeCompare(a.transactionDate));
}

/**
 * Find stocks that multiple Congress members are buying (cluster buys).
 */
export async function getClusterBuys(daysBack: number = 30, minBuyers: number = 3): Promise<Array<{ ticker: string; buyers: number; representatives: string[] }>> {
  const trades = await getRecentCongressTrades(daysBack, 500);
  const purchases = trades.filter(t => t.type.toLowerCase().includes("purchase"));

  const tickerBuyers = new Map<string, Set<string>>();
  for (const t of purchases) {
    if (!tickerBuyers.has(t.ticker)) tickerBuyers.set(t.ticker, new Set());
    tickerBuyers.get(t.ticker)!.add(t.representative);
  }

  return Array.from(tickerBuyers.entries())
    .filter(([_, buyers]) => buyers.size >= minBuyers)
    .map(([ticker, buyers]) => ({
      ticker,
      buyers: buyers.size,
      representatives: Array.from(buyers),
    }))
    .sort((a, b) => b.buyers - a.buyers);
}

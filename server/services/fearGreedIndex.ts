import axios from "axios";

/**
 * CNN Fear & Greed Index
 * Free, no API key. Cached for 30 minutes.
 *
 * Components: market momentum, stock price strength, stock price breadth,
 * put/call options, junk bond demand, market volatility, safe haven demand.
 */

export interface FearGreedData {
  value: number;           // 0-100
  label: string;           // "Extreme Fear" | "Fear" | "Neutral" | "Greed" | "Extreme Greed"
  previousClose: number;
  oneWeekAgo: number;
  oneMonthAgo: number;
  oneYearAgo: number;
  timestamp: Date;
}

let cached: FearGreedData | null = null;
let cacheTime = 0;
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

export async function getFearGreedIndex(): Promise<FearGreedData | null> {
  const now = Date.now();
  if (cached && now - cacheTime < CACHE_TTL) return cached;

  try {
    const res = await axios.get(
      "https://production.dataviz.cnn.io/index/fearandgreed/graphdata",
      {
        headers: { "User-Agent": "TradingAgent/1.0" },
        timeout: 10_000,
      },
    );

    const data = res.data?.fear_and_greed;
    if (!data) return cached;

    cached = {
      value: Math.round(data.score),
      label: getLabel(data.score),
      previousClose: data.previous_close ?? 0,
      oneWeekAgo: data.previous_1_week ?? 0,
      oneMonthAgo: data.previous_1_month ?? 0,
      oneYearAgo: data.previous_1_year ?? 0,
      timestamp: new Date(),
    };
    cacheTime = now;
    return cached;
  } catch (error: any) {
    console.error("[FearGreed] Failed to fetch:", error.message);
    return cached;
  }
}

function getLabel(score: number): string {
  if (score <= 25) return "Extreme Fear";
  if (score <= 45) return "Fear";
  if (score <= 55) return "Neutral";
  if (score <= 75) return "Greed";
  return "Extreme Greed";
}

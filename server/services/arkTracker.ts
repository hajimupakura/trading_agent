import axios from "axios";
import { InsertArkTrade } from "../../drizzle/schema";

/**
 * ARK Invest trade tracking service
 * Fetches daily trades from ARK's public trade notification files
 */

interface ArkTradeData {
  date: string;
  fund: string;
  ticker: string;
  companyName: string;
  direction: "buy" | "sell";
  shares?: number;
  marketValue?: string;
  percentOfEtf?: string;
}

/**
 * Fetch ARK trade data from third-party tracking services
 * Using CathiesArk.com or ARKTracker as data source
 */
export async function fetchArkTrades(date?: Date): Promise<ArkTradeData[]> {
  try {
    // In production, this would fetch from ARK's official trade notification files
    // or use a third-party API like CathiesArk.com
    
    // For now, return mock data
    return getMockArkTrades();
  } catch (error) {
    console.error("Error fetching ARK trades:", error);
    return [];
  }
}

/**
 * Parse ARK trade CSV data
 * ARK provides daily trade files in CSV format
 */
export function parseArkTradeCSV(csvData: string): ArkTradeData[] {
  const trades: ArkTradeData[] = [];
  
  // Split CSV into lines
  const lines = csvData.trim().split("\n");
  
  // Skip header row
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    
    // Parse CSV line (simplified - production would handle quotes, commas in values, etc.)
    const columns = line.split(",");
    
    if (columns.length >= 6) {
      trades.push({
        date: columns[0] || "",
        fund: columns[1] || "",
        ticker: columns[2] || "",
        companyName: columns[3] || "",
        direction: columns[4]?.toLowerCase() === "buy" ? "buy" : "sell",
        shares: parseInt(columns[5] || "0"),
        marketValue: columns[6] || "",
        percentOfEtf: columns[7] || "",
      });
    }
  }
  
  return trades;
}

/**
 * Convert ARK trade data to database format
 */
export function convertToArkTrade(trade: ArkTradeData): Omit<InsertArkTrade, "id"> {
  return {
    tradeDate: new Date(trade.date),
    fund: trade.fund,
    ticker: trade.ticker,
    companyName: trade.companyName || null,
    direction: trade.direction,
    shares: trade.shares || null,
    marketValue: trade.marketValue || null,
    percentOfEtf: trade.percentOfEtf || null,
    scrapedAt: new Date(),
  };
}

/**
 * Get ARK funds to track
 */
export function getArkFunds(): string[] {
  return ["ARKK", "ARKQ", "ARKW", "ARKG", "ARKF", "ARKX"];
}

/**
 * Mock ARK trade data for development/testing
 */
export function getMockArkTrades(): ArkTradeData[] {
  const today = new Date().toISOString().split("T")[0];
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split("T")[0];

  return [
    {
      date: today,
      fund: "ARKK",
      ticker: "NVDA",
      companyName: "NVIDIA Corporation",
      direction: "buy",
      shares: 50000,
      marketValue: "$45,000,000",
      percentOfEtf: "2.5%",
    },
    {
      date: today,
      fund: "ARKK",
      ticker: "TSLA",
      companyName: "Tesla Inc",
      direction: "sell",
      shares: 25000,
      marketValue: "$20,000,000",
      percentOfEtf: "1.8%",
    },
    {
      date: today,
      fund: "ARKQ",
      ticker: "GOOGL",
      companyName: "Alphabet Inc Class A",
      direction: "buy",
      shares: 30000,
      marketValue: "$35,000,000",
      percentOfEtf: "3.2%",
    },
    {
      date: yesterday,
      fund: "ARKK",
      ticker: "IONQ",
      companyName: "IonQ Inc",
      direction: "buy",
      shares: 100000,
      marketValue: "$12,000,000",
      percentOfEtf: "1.1%",
    },
    {
      date: yesterday,
      fund: "ARKW",
      ticker: "COIN",
      companyName: "Coinbase Global Inc",
      direction: "sell",
      shares: 15000,
      marketValue: "$8,500,000",
      percentOfEtf: "0.9%",
    },
    {
      date: yesterday,
      fund: "ARKG",
      ticker: "CRSP",
      companyName: "CRISPR Therapeutics AG",
      direction: "buy",
      shares: 40000,
      marketValue: "$18,000,000",
      percentOfEtf: "2.1%",
    },
  ];
}

/**
 * Fetch latest ARK trades and return significant ones
 * Filters for trades above a certain threshold
 */
export async function getSignificantArkTrades(minPercentage: number = 1.0): Promise<ArkTradeData[]> {
  const allTrades = await fetchArkTrades();
  
  return allTrades.filter(trade => {
    if (!trade.percentOfEtf) return false;
    const percentage = parseFloat(trade.percentOfEtf.replace("%", ""));
    return percentage >= minPercentage;
  });
}

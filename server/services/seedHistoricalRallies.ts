import { insertRallyEvent } from "../db";
import { InsertRallyEvent } from "../../drizzle/schema";

/**
 * Seed historical rally data based on research
 * This includes the AI, metals, and quantum computing rallies
 */

export async function seedHistoricalRallies() {
  const rallies: Array<Omit<InsertRallyEvent, "id" | "createdAt">> = [
    // AI Stock Rally 2023-2025
    {
      sector: "ai",
      name: "AI Stock Rally 2023-2025 (ChatGPT Era)",
      startDate: new Date("2022-11-30"), // ChatGPT release
      peakDate: new Date("2024-06-30"),
      description: "Massive rally in AI stocks triggered by ChatGPT release and subsequent AI boom. Led by NVIDIA, Microsoft, Google, and other tech giants investing heavily in AI infrastructure.",
      catalysts: JSON.stringify([
        "ChatGPT release (Nov 30, 2022)",
        "Microsoft $10B OpenAI investment (Jan 2023)",
        "Google Bard announcement (Feb 2023)",
        "NVIDIA H100 chip demand surge (Q1 2023)",
        "AI mentioned in 80%+ of earnings calls (Q1 2023)",
      ]),
      keyStocks: JSON.stringify([
        "NVDA", // +979% since ChatGPT
        "MSFT", // Major AI investment
        "GOOGL", // Bard and AI services
        "META", // LLaMA and AI infrastructure
        "AMZN", // AWS AI services
        "SMCI", // +212% in 12 months
      ]),
      performance: JSON.stringify({
        sp500Gain: "64%",
        nvidiaGain: "979%",
        top7TechContribution: "50% of S&P gains",
        timeframe: "Nov 2022 - Nov 2025",
      }),
      status: "ongoing",
    },
    
    // Metals Rally 2024-2025
    {
      sector: "metals",
      name: "Gold & Silver Rally 2024-2025",
      startDate: new Date("2023-10-01"), // Rally began building in late 2023
      peakDate: null, // Still ongoing
      description: "Precious metals rally driven by central bank buying, geopolitical instability, inflation concerns, and weakening dollar. Gold and silver reached multi-year highs.",
      catalysts: JSON.stringify([
        "Central bank gold accumulation (2022-2023)",
        "China record gold buying",
        "Ukraine war and geopolitical tensions",
        "Inflation and currency devaluation fears",
        "Federal Reserve rate cut expectations",
        "Weakening U.S. dollar",
      ]),
      keyStocks: JSON.stringify([
        "GLD", // Gold ETF
        "SLV", // Silver ETF
        "NEM", // Newmont Mining
        "GOLD", // Barrick Gold
        "AEM", // Agnico Eagle
      ]),
      performance: JSON.stringify({
        goldGain: "~25-30%",
        silverGain: "~20-25%",
        timeframe: "Late 2023 - Present",
        rallyDuration: "~15 months",
      }),
      status: "ongoing",
    },
    
    // Quantum Computing Rally 2024-2025
    {
      sector: "quantum",
      name: "Quantum Computing Rally 2024-2025",
      startDate: new Date("2024-11-05"), // Post-election rally start
      peakDate: new Date("2025-10-15"), // Mid-October 2025 peak
      description: "Explosive rally in quantum computing stocks following Trump election, positive earnings guidance, and Google Willow chip breakthrough. Rally corrected sharply after Nvidia CEO comments about 20-year timeline.",
      catalysts: JSON.stringify([
        "Trump election (Nov 5, 2024) - expected government support",
        "Optimistic Q3 2024 earnings from IONQ and QUBT",
        "Google Willow chip announcement (Dec 9, 2024)",
        "Microsoft quantum chip debut (Feb 2025)",
        "NVIDIA quantum hardware announcement",
        "White House investment talks (denied but boosted stocks)",
        "IONQ 99.99% fidelity milestone",
      ]),
      keyStocks: JSON.stringify([
        "RGTI", // +3,100% in 12 months
        "QBTS", // +2,700% in 12 months
        "QUBT", // +1,100% in 12 months
        "IONQ", // +670% by Oct 2025
      ]),
      performance: JSON.stringify({
        rigettiGain: "3100%",
        dWaveGain: "2700%",
        quantumComputingGain: "1100%",
        ionqGain: "670%",
        timeframe: "Nov 2024 - Oct 2025",
        correction: "Rigetti -45% in one day (Jan 8, 2025)",
      }),
      status: "ended",
    },
    
    // Energy/Utilities AI Rally 2024-2025
    {
      sector: "energy",
      name: "AI Data Center Power Rally 2024-2025",
      startDate: new Date("2024-03-01"),
      peakDate: null,
      description: "Unexpected rally in electricity providers driven by massive power demands from AI data centers. Nuclear energy revival as tech giants seek reliable power sources.",
      catalysts: JSON.stringify([
        "AI data center power requirements surge",
        "Big Tech nuclear power partnerships",
        "Three Mile Island restart ($1B government backing)",
        "Microsoft-Constellation Energy deal",
        "Meta exploring Google AI chips",
        "Nuclear startup funding boom",
      ]),
      keyStocks: JSON.stringify([
        "VST", // Vistra +620%
        "NRG", // NRG Energy +250%
        "CEG", // Constellation Energy +250%
        "OKLO", // Oklo (nuclear startup)
        "NNE", // Nano Nuclear Energy
      ]),
      performance: JSON.stringify({
        vistraGain: "620%",
        nrgGain: "250%",
        constellationGain: "250%",
        timeframe: "2024-2025",
      }),
      status: "ongoing",
    },
  ];

  console.log("Seeding historical rally data...");
  
  for (const rally of rallies) {
    try {
      await insertRallyEvent(rally);
      console.log(`✓ Seeded rally: ${rally.name}`);
    } catch (error) {
      console.error(`✗ Failed to seed rally: ${rally.name}`, error);
    }
  }
  
  console.log("Historical rally seeding complete!");
}

/**
 * Get rally insights for a specific sector
 */
export function getRallyInsights(sector: string): string {
  const insights: Record<string, string> = {
    ai: `The AI rally began with ChatGPT's release on Nov 30, 2022. Early signals included: (1) Viral ChatGPT adoption, (2) Tech company earnings calls mentioning AI repeatedly in Q1 2023, (3) NVIDIA GPU shortage reports, (4) Microsoft's $10B OpenAI investment announcement. The rally accelerated throughout 2023 with NVIDIA up 979% and the top 7 tech companies accounting for 50% of S&P 500 gains.`,
    
    metals: `The metals rally started building in late 2023. Early signals included: (1) Reports of record central bank gold buying, especially from China, (2) Geopolitical tensions escalating (Ukraine war), (3) Inflation concerns and dollar weakness, (4) Federal Reserve pivot expectations. The rally gained momentum in early 2024 and continued for over 15 months.`,
    
    quantum: `The quantum rally began in early November 2024 post-election. Early signals included: (1) Trump campaign mentions of quantum support, (2) Optimistic earnings guidance from IONQ and QUBT in late October/early November 2024, (3) Increased Wall Street analyst coverage, (4) Research breakthrough announcements. The rally exploded with Google's Willow chip announcement on Dec 9, 2024, with stocks gaining 1,100% to 3,100% before correcting in January 2025.`,
    
    energy: `The AI-driven energy rally started in early 2024. Early signals included: (1) Reports of data center power shortages, (2) Tech giants announcing nuclear power partnerships, (3) Utility company earnings showing unexpected demand growth, (4) Nuclear startup funding announcements. Vistra gained 620% as the 4th best S&P 500 performer.`,
  };
  
  return insights[sector] || "No specific insights available for this sector.";
}

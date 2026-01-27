import { invokeLLM } from "../_core/llm";
import { NewsArticle } from "../../drizzle/schema";

/**
 * Dynamic sector discovery service
 * Automatically detects emerging sectors from news patterns
 */

export interface DiscoveredSector {
  name: string;
  description: string;
  confidence: number;
  relatedStocks: string[];
  newsCount: number;
  momentum: "very_strong" | "strong" | "moderate" | "weak";
}

/**
 * Analyze news articles to discover emerging sectors
 */
export async function discoverEmergingSectors(articles: NewsArticle[]): Promise<DiscoveredSector[]> {
  try {
    // Prepare article summaries for analysis
    const articleSummaries = articles.map(a => ({
      title: a.title,
      summary: a.aiSummary || a.summary,
      stocks: a.mentionedStocks ? JSON.parse(a.mentionedStocks) : [],
      sentiment: a.sentiment,
    }));

    const response = await invokeLLM({
      messages: [
        {
          role: "system",
          content: `You are a financial market analyst specializing in identifying emerging investment sectors and trends.

Your task is to analyze financial news and identify emerging sectors that show potential for market rallies.

**PRIORITY SECTORS** (Focus heavily on these):
1. **AI Companies** - OpenAI (ChatGPT, GPT-5), Anthropic (Claude), Google/Gemini (GOOGL), Perplexity
2. **Artificial Intelligence (AI)** - All AI applications, models, chips, AGI, AI agents
3. **Semiconductors/Chips** - AI chips, GPUs, TPUs, chip manufacturing, TSMC, NVIDIA (NVDA), AMD, Intel
4. **Quantum Computing** - Quantum processors, quantum algorithms, quantum communications
5. **Unmanned Aerial Vehicles (UAVs)** - Drones, autonomous aircraft, delivery drones
6. **Tesla (TSLA)** - EVs, Full Self-Driving, energy products, robotics, Optimus
7. **SpaceX** - Rockets, Starlink, Starship, space exploration, satellite internet
8. **Metals** - Critical minerals, rare earth elements, copper, lithium, aluminum
9. **Energy** - Renewable energy, nuclear, solar, wind, grid infrastructure
10. **Batteries** - Lithium-ion, solid-state, battery manufacturing, energy storage
11. **AI-Powered Healthcare/Biotech** - AI drug discovery, computational biology, gene editing, CRISPR

Look for specific sub-sectors and trends within these areas:
- AI chips and accelerators (H100, MI300, TPUs)
- Quantum sensing and quantum networking
- Battery energy storage systems (BESS)
- Next-generation nuclear (SMRs, fusion)
- AI-driven drug discovery and protein folding
- Autonomous systems and robotics
- Space commercialization and satellite technology
- Advanced materials and nanotechnology
- EV charging infrastructure
- Green hydrogen production

Return ONLY specific, emerging sectors with clear investment potential.`,
        },
        {
          role: "user",
          content: `Analyze these ${articles.length} recent news articles and identify emerging sectors:\n\n${JSON.stringify(articleSummaries, null, 2)}`,
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "sector_discovery",
          strict: true,
          schema: {
            type: "object",
            properties: {
              sectors: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: {
                      type: "string",
                      description: "Specific sector name (e.g., 'Computational Drug Design', 'Rare Earth Metals')",
                    },
                    description: {
                      type: "string",
                      description: "Brief description of the sector and why it's emerging",
                    },
                    confidence: {
                      type: "number",
                      description: "Confidence score 0-100 that this is a real emerging trend",
                    },
                    relatedStocks: {
                      type: "array",
                      items: { type: "string" },
                      description: "Stock tickers related to this sector",
                    },
                    newsCount: {
                      type: "number",
                      description: "Number of news articles mentioning this sector",
                    },
                    momentum: {
                      type: "string",
                      enum: ["very_strong", "strong", "moderate", "weak"],
                      description: "Current momentum level",
                    },
                  },
                  required: ["name", "description", "confidence", "relatedStocks", "newsCount", "momentum"],
                  additionalProperties: false,
                },
              },
            },
            required: ["sectors"],
            additionalProperties: false,
          },
        },
      },
    });

    const content = response.choices[0]?.message?.content;
    if (!content || typeof content !== "string") {
      return [];
    }

    const result = JSON.parse(content) as { sectors: DiscoveredSector[] };
    
    // Filter for high-confidence sectors only
    return result.sectors.filter(s => s.confidence >= 60);
  } catch (error) {
    console.error("Error discovering sectors:", error);
    return [];
  }
}

/**
 * Get all unique sectors from recent news
 */
export function extractSectorsFromNews(articles: NewsArticle[]): Map<string, number> {
  const sectorCounts = new Map<string, number>();

  for (const article of articles) {
    if (!article.sectors) continue;

    try {
      const sectors = JSON.parse(article.sectors) as string[];
      for (const sector of sectors) {
        sectorCounts.set(sector, (sectorCounts.get(sector) || 0) + 1);
      }
    } catch (error) {
      console.error("Error parsing sectors:", error);
    }
  }

  return sectorCounts;
}

/**
 * Classify sector momentum based on news patterns
 */
export function calculateSectorMomentum(
  newsCount: number,
  bullishCount: number,
  timeWindow: number = 7 // days
): "very_strong" | "strong" | "moderate" | "weak" | "declining" {
  const avgPerDay = newsCount / timeWindow;
  const bullishRatio = bullishCount / newsCount;

  if (avgPerDay >= 5 && bullishRatio >= 0.7) return "very_strong";
  if (avgPerDay >= 3 && bullishRatio >= 0.6) return "strong";
  if (avgPerDay >= 2 && bullishRatio >= 0.5) return "moderate";
  if (avgPerDay >= 1 && bullishRatio >= 0.4) return "weak";
  return "declining";
}

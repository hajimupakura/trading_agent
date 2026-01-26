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

Your task is to analyze financial news and identify emerging sectors that show potential for market rallies. Look for:
1. NEW sectors or industries gaining attention (not just established ones like "tech" or "finance")
2. Specific sub-sectors within broader categories (e.g., "computational drug design" within healthcare, "rare earth metals" within materials, "UAVs/drones" within aerospace)
3. Patterns of increasing news coverage and positive sentiment
4. Multiple stocks or companies in the same space being mentioned
5. Early-stage trends that could develop into 2-3 week rallies or longer

Examples of emerging sectors to look for:
- UAVs/Drones and autonomous systems
- Rare earth metals and critical minerals
- Computational drug design and AI-driven healthcare
- Virtual twinning and digital twins
- Space tourism and commercial space
- Quantum sensing and quantum communications
- Green hydrogen and alternative energy storage
- Synthetic biology and gene editing
- Edge computing and decentralized networks
- Carbon capture and climate tech

Return ONLY truly emerging or specific sectors, not generic categories.`,
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

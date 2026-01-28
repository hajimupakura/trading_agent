/**
 * Related Stocks Service
 * 
 * Identifies stocks that may be affected by the movement of a primary stock.
 * Uses both AI analysis of recent news and historical correlation patterns.
 */

import { invokeLLM } from "../_core/llm";
import { getDb } from "../db";
import { stockRelationships, newsArticles } from "../../drizzle/schema";
import { eq, and, desc, gte, sql } from "drizzle-orm";

export interface RelatedStock {
  ticker: string;
  companyName?: string;
  relationshipType: "competitor" | "supplier" | "customer" | "supply_chain" | "complementary" | "sector_peer";
  strengthScore: number; // 0-100
  description: string;
  newsEvidence?: string;
  historicalCorrelation?: string;
}

export interface RelationshipAnalysis {
  primaryTicker: string;
  relatedStocks: RelatedStock[];
  analysisTimestamp: Date;
  totalRelationships: number;
}

/**
 * Analyze a stock and identify all related/affected stocks
 * Uses AI + news analysis + database lookup
 */
export async function analyzeRelatedStocks(
  ticker: string,
  forceRefresh: boolean = false
): Promise<RelationshipAnalysis> {
  console.log(`[Related Stocks] Analyzing relationships for ${ticker}`);
  
  // Check if we have recent analysis in database (within last 24 hours)
  if (!forceRefresh) {
    const cached = await getRelatedStocksFromDB(ticker, 24);
    if (cached.length > 0) {
      console.log(`[Related Stocks] Found ${cached.length} cached relationships`);
      return {
        primaryTicker: ticker,
        relatedStocks: cached,
        analysisTimestamp: new Date(),
        totalRelationships: cached.length,
      };
    }
  }

  // Perform fresh analysis
  console.log(`[Related Stocks] Performing fresh AI analysis for ${ticker}`);
  
  // Get recent news about this ticker for context
  const recentNews = await getRecentNewsForTicker(ticker, 30);
  
  // Use AI to analyze relationships
  const aiAnalysis = await performAIRelationshipAnalysis(ticker, recentNews);
  
  // Store results in database
  await storeRelationships(ticker, aiAnalysis);
  
  // Fetch back from database to ensure consistency
  const storedRelationships = await getRelatedStocksFromDB(ticker, 24);
  
  return {
    primaryTicker: ticker,
    relatedStocks: storedRelationships,
    analysisTimestamp: new Date(),
    totalRelationships: storedRelationships.length,
  };
}

/**
 * Get related stocks from database cache
 */
async function getRelatedStocksFromDB(
  ticker: string,
  maxAgeHours: number
): Promise<RelatedStock[]> {
  const db = await getDb();
  if (!db) return [];
  
  const cutoffTime = new Date();
  cutoffTime.setHours(cutoffTime.getHours() - maxAgeHours);
  
  const relationships = await db
    .select()
    .from(stockRelationships)
    .where(
      and(
        eq(stockRelationships.primaryTicker, ticker.toUpperCase()),
        gte(stockRelationships.lastUpdated, cutoffTime)
      )
    )
    .orderBy(desc(stockRelationships.strengthScore));
  
  return relationships.map(rel => ({
    ticker: rel.relatedTicker,
    relationshipType: rel.relationshipType,
    strengthScore: rel.strengthScore,
    description: rel.description || "",
    newsEvidence: rel.newsBasedEvidence || undefined,
    historicalCorrelation: rel.historicalCorrelation || undefined,
  }));
}

/**
 * Get recent news articles mentioning the ticker
 */
async function getRecentNewsForTicker(
  ticker: string,
  daysBack: number
): Promise<string[]> {
  const db = await getDb();
  if (!db) return [];
  
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysBack);
  
  const articles = await db
    .select({
      title: newsArticles.title,
      summary: newsArticles.aiSummary,
      content: newsArticles.content,
    })
    .from(newsArticles)
    .where(
      and(
        gte(newsArticles.publishedAt, cutoffDate),
        sql`${newsArticles.mentionedStocks} LIKE ${"%" + ticker.toUpperCase() + "%"}`
      )
    )
    .orderBy(desc(newsArticles.publishedAt))
    .limit(20);
  
  return articles.map(a => `${a.title}\n${a.summary || a.content?.substring(0, 500) || ""}`);
}

/**
 * Use AI to analyze relationships between stocks
 */
async function performAIRelationshipAnalysis(
  ticker: string,
  recentNews: string[]
): Promise<RelatedStock[]> {
  const newsContext = recentNews.length > 0
    ? `Recent news about ${ticker}:\n${recentNews.slice(0, 10).join("\n\n")}`
    : `No recent news available for ${ticker}`;
  
  const prompt = `You are a financial analyst expert in identifying stock market relationships and supply chain dependencies.

PRIMARY STOCK: ${ticker}

${newsContext}

TASK: Identify 8-15 stocks that would be significantly affected by a rally/surge in ${ticker}'s stock price.

Consider these relationship types:
1. COMPETITORS - Direct competitors in the same industry who may benefit from the same market trends
2. SUPPLIERS - Companies that supply raw materials, components, or services to ${ticker}
3. CUSTOMERS - Companies that buy products/services from ${ticker}
4. SUPPLY_CHAIN - Broader supply chain partners (logistics, energy, infrastructure)
5. COMPLEMENTARY - Companies whose products complement ${ticker}'s offerings
6. SECTOR_PEER - Similar companies in related sectors that move together

For each related stock, provide:
- Ticker symbol
- Company name (if known)
- Relationship type (one of the above)
- Strength score (0-100, where 100 = extremely strong correlation)
- Description (1-2 sentences explaining WHY this stock is affected)
- News evidence (if applicable from the news context)

IMPORTANT RULES:
- Focus on publicly traded companies with recognizable ticker symbols
- Prioritize relationships with strength scores above 60
- Include a diverse mix of relationship types
- Be specific about the mechanism of impact
- If ${ticker} is in semiconductors, consider: chip equipment makers, materials suppliers, customers (cloud/AI companies), energy providers
- If ${ticker} is in automotive, consider: parts suppliers, battery makers, raw materials, charging infrastructure
- If ${ticker} is in software, consider: complementary software, cloud infrastructure, hardware partners

Return ONLY a valid JSON array with this exact structure:
[
  {
    "ticker": "AAPL",
    "companyName": "Apple Inc.",
    "relationshipType": "customer",
    "strengthScore": 85,
    "description": "Major customer purchasing AI chips for iPhone and data centers",
    "newsEvidence": "Recent news mentions increased chip orders"
  }
]

NO MARKDOWN. NO EXPLANATIONS. JUST THE JSON ARRAY.`;

  try {
    const response = await invokeLLM({
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    });
    
    // Extract text from response
    const responseText = response.choices?.[0]?.message?.content || "";
    
    // Clean response and parse JSON
    let jsonText = responseText.trim();
    
    // Remove markdown code blocks if present
    jsonText = jsonText.replace(/```json\n?/g, "").replace(/```\n?/g, "");
    
    // Parse JSON
    const parsed = JSON.parse(jsonText);
    
    if (!Array.isArray(parsed)) {
      console.error("[Related Stocks] AI response is not an array");
      return [];
    }
    
    // Validate and filter results
    const validRelationships: RelatedStock[] = parsed
      .filter((item: any) => {
        return (
          item.ticker &&
          item.relationshipType &&
          typeof item.strengthScore === "number" &&
          item.strengthScore >= 50 && // Only keep strong relationships
          item.description
        );
      })
      .map((item: any) => ({
        ticker: item.ticker.toUpperCase(),
        companyName: item.companyName,
        relationshipType: item.relationshipType.toLowerCase().replace(/_/g, "_"),
        strengthScore: Math.min(100, Math.max(0, item.strengthScore)),
        description: item.description,
        newsEvidence: item.newsEvidence,
        historicalCorrelation: item.historicalCorrelation,
      }));
    
    console.log(`[Related Stocks] AI identified ${validRelationships.length} relationships`);
    return validRelationships;
    
  } catch (error) {
    console.error("[Related Stocks] Error in AI analysis:", error);
    return [];
  }
}

/**
 * Store relationships in database
 */
async function storeRelationships(
  primaryTicker: string,
  relationships: RelatedStock[]
): Promise<void> {
  console.log(`[Related Stocks] Storing ${relationships.length} relationships for ${primaryTicker}`);
  
  const db = await getDb();
  if (!db) {
    console.error("[Related Stocks] Database not available");
    return;
  }
  
  // Delete old relationships for this ticker
  await db
    .delete(stockRelationships)
    .where(eq(stockRelationships.primaryTicker, primaryTicker.toUpperCase()));
  
  // Insert new relationships
  for (const rel of relationships) {
    await db.insert(stockRelationships).values({
      primaryTicker: primaryTicker.toUpperCase(),
      relatedTicker: rel.ticker.toUpperCase(),
      relationshipType: rel.relationshipType,
      strengthScore: rel.strengthScore,
      description: rel.description,
      analysisSource: "ai_analysis",
      newsBasedEvidence: rel.newsEvidence,
      historicalCorrelation: rel.historicalCorrelation,
      lastUpdated: new Date(),
      createdAt: new Date(),
    });
  }
  
  console.log(`[Related Stocks] Successfully stored relationships`);
}

/**
 * Automatically analyze related stocks when a rally prediction is created
 * This is called during the prediction generation process
 */
export async function analyzeRelatedStocksForPrediction(
  primaryTickers: string[]
): Promise<Map<string, RelatedStock[]>> {
  console.log(`[Related Stocks] Analyzing relationships for prediction with tickers: ${primaryTickers.join(", ")}`);
  
  const results = new Map<string, RelatedStock[]>();
  
  for (const ticker of primaryTickers) {
    try {
      const analysis = await analyzeRelatedStocks(ticker, false);
      results.set(ticker, analysis.relatedStocks);
    } catch (error) {
      console.error(`[Related Stocks] Error analyzing ${ticker}:`, error);
      results.set(ticker, []);
    }
  }
  
  return results;
}

/**
 * Calculate aggregate strength score for a related stock across multiple primary stocks
 */
export function calculateAggregateStrength(
  relatedTicker: string,
  primaryStocksMap: Map<string, RelatedStock[]>
): number {
  let totalStrength = 0;
  let count = 0;
  
  for (const [, relatedStocks] of primaryStocksMap) {
    const match = relatedStocks.find(rs => rs.ticker === relatedTicker);
    if (match) {
      totalStrength += match.strengthScore;
      count++;
    }
  }
  
  return count > 0 ? Math.round(totalStrength / count) : 0;
}

/**
 * Get unique related stocks from multiple primary stocks
 * Useful when a prediction involves multiple tickers
 */
export function getUniqueRelatedStocks(
  primaryStocksMap: Map<string, RelatedStock[]>
): RelatedStock[] {
  const uniqueMap = new Map<string, RelatedStock>();
  
  for (const [, relatedStocks] of primaryStocksMap) {
    for (const stock of relatedStocks) {
      const existing = uniqueMap.get(stock.ticker);
      
      // Keep the relationship with the highest strength score
      if (!existing || stock.strengthScore > existing.strengthScore) {
        uniqueMap.set(stock.ticker, stock);
      }
    }
  }
  
  // Sort by strength score descending
  return Array.from(uniqueMap.values())
    .sort((a, b) => b.strengthScore - a.strengthScore);
}

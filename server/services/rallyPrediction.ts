import { invokeLLM } from "../_core/llm";
import { NewsArticle, RallyEvent } from "../../drizzle/schema";

/**
 * Predictive rally detection engine
 * Learns from historical rally patterns to predict future rallies 2-3 weeks early
 */

export interface RallyPrediction {
  sector: string;
  opportunityType: "call" | "put"; // call for upside, put for downside
  direction: "up" | "down"; // market direction
  confidence: number; // 0-100
  timeframe: "2-3 weeks" | "1-2 months" | "3-6 months";
  earlySignals: string[];
  recommendedStocks: string[];
  reasoning: string;
  entryTiming: string;
  exitStrategy: string;
}

export interface HistoricalPattern {
  sector: string;
  earlySignals: string[];
  timeToRally: number; // days from first signal to rally start
  catalysts: string[];
  avgGain: string;
}

/**
 * Extract patterns from historical rallies for learning
 */
export function extractHistoricalPatterns(historicalRallies: RallyEvent[]): HistoricalPattern[] {
  return historicalRallies
    .filter(r => r.isHistorical === 1)
    .map(rally => {
      const catalysts = rally.catalysts ? JSON.parse(rally.catalysts) : [];
      const earlySignals = rally.earlySignals ? JSON.parse(rally.earlySignals) : [];
      const performance = rally.performance ? JSON.parse(rally.performance) : {};

      return {
        sector: rally.sector,
        earlySignals,
        timeToRally: 21, // Default 3 weeks, could be calculated from data
        catalysts,
        avgGain: performance.avgGain || "unknown",
      };
    });
}

/**
 * Predict upcoming rallies based on current news and historical patterns
 */
export async function predictUpcomingRallies(
  recentNews: NewsArticle[],
  historicalPatterns: HistoricalPattern[]
): Promise<RallyPrediction[]> {
  try {
    console.log("[Rally Predictions] Starting with", recentNews.length, "news articles");
    
    // Filter only articles with AI analysis and sentiment
    const analyzedNews = recentNews.filter(n => 
      n.sentiment !== null && 
      n.sentiment !== undefined &&
      (n.aiSummary || n.summary)
    );
    
    console.log("[Rally Predictions] Filtered to", analyzedNews.length, "analyzed articles");
    
    if (analyzedNews.length < 10) {
      console.log("[Rally Predictions] Not enough analyzed articles for predictions");
      return [];
    }
    
    // Prepare clean data for LLM (limit to most recent 40 articles)
    const newsData = analyzedNews.slice(0, 40).map(n => {
      let sectors = [];
      let stocks = [];
      
      try {
        if (n.sectors) {
          sectors = typeof n.sectors === 'string' ? JSON.parse(n.sectors) : n.sectors;
        }
      } catch (e) {
        sectors = [];
      }
      
      try {
        if (n.mentionedStocks) {
          stocks = typeof n.mentionedStocks === 'string' ? JSON.parse(n.mentionedStocks) : n.mentionedStocks;
        }
      } catch (e) {
        stocks = [];
      }
      
      return {
        title: n.title,
        summary: (n.aiSummary || n.summary || '').substring(0, 200),
        sentiment: n.sentiment,
        sectors: sectors,
        stocks: stocks,
      };
    });

    console.log("[Rally Predictions] Prepared", newsData.length, "articles for AI");
    
    // Use early signal detection for each sector
    const sectorSignals = new Map<string, string[]>();
    analyzedNews.forEach(n => {
      let sectors = [];
      try {
        if (n.sectors) {
          sectors = typeof n.sectors === 'string' ? JSON.parse(n.sectors) : n.sectors;
        }
      } catch (e) {
        sectors = [];
      }
      
      sectors.forEach((sector: string) => {
        if (!sectorSignals.has(sector)) {
          sectorSignals.set(sector, detectEarlySignals(sector, analyzedNews));
        }
      });
    });

    const response = await invokeLLM({
      messages: [
        {
          role: "system",
          content: `You are an expert market analyst specializing in predicting MONEY-MAKING OPPORTUNITIES 2-3 weeks early.

Your task: Analyze current news patterns and historical data to predict upcoming opportunities for BOTH calls (upside) and puts (downside).

**PRIORITY SECTORS** (Focus extra attention on these):
- AI Companies: OpenAI (ChatGPT), Anthropic (Claude), Google/Gemini (GOOGL), Perplexity
- Artificial Intelligence: AI chips, models, AGI, AI agents, AI applications
- Semiconductors: NVIDIA (NVDA), AMD, Intel, TSMC, AI accelerators
- Quantum Computing: Quantum processors, quantum networking
- UAVs/Drones: Autonomous aircraft, delivery drones
- Tesla (TSLA): EVs, Full Self-Driving, robotics, energy
- SpaceX: Rockets, Starlink, Starship, satellites
- Metals: Rare earths, lithium, copper, critical minerals
- Energy: Renewables, nuclear, solar, wind, grid
- Batteries: Lithium-ion, solid-state, energy storage
- AI Healthcare/Biotech: Drug discovery, gene editing, CRISPR

CRITICAL RULES FOR PREDICTIONS:
1. Focus on EARLY SIGNALS - indicators that appear 2-3 weeks BEFORE major moves
2. Detect BOTH upward rallies (call opportunities) AND downward moves (put opportunities)
3. Give EXTRA WEIGHT to news about the priority sectors above
4. Identify NEW emerging sectors automatically
5. Prioritize short-term opportunities (2-3 weeks to 2 months)
6. Be specific about entry timing and exit strategy

EARLY WARNING SIGNALS FOR UPSIDE (CALLS):
- Sudden increase in positive news coverage
- Positive sentiment shift in a sector/stock
- Multiple stocks in same sector showing strength
- Institutional buying (ARK trades, insider buying)
- Breakthrough announcements or regulatory approvals
- Volume surge with price breakout

EARLY WARNING SIGNALS FOR DOWNSIDE (PUTS):
- Negative news accumulation
- Bearish sentiment shift
- Regulatory threats or investigations
- Insider selling or institutional exits
- Earnings warnings or guidance cuts
- Technical breakdown with volume
- Recession indicators or macro headwinds

HISTORICAL RALLY PATTERNS:
${JSON.stringify(historicalPatterns, null, 2)}

These patterns show what early signals preceded major rallies. Use them to identify similar patterns in current news.`,
        },
        {
          role: "user",
          content: `Analyze these ${newsData.length} recent news articles and predict upcoming opportunities:

${JSON.stringify(newsData, null, 2)}

DETECTED EARLY SIGNALS BY SECTOR:
${Array.from(sectorSignals.entries()).map(([sector, signals]) => 
  `${sector}: ${signals.join(', ')}`
).join('\n')}

Identify BOTH:
1. Upside opportunities (calls) - sectors/stocks showing early rally signals
2. Downside opportunities (puts) - sectors/stocks showing early decline signals

Focus on what's MOVING in the market, regardless of sector. Discover new emerging sectors automatically.

Provide predictions in this exact JSON format:
{
  "predictions": [
    {
      "sector": "Sector Name",
      "opportunityType": "call",
      "direction": "up",
      "confidence": 75,
      "timeframe": "2-3 weeks",
      "earlySignals": ["signal1", "signal2"],
      "recommendedStocks": ["STOCK1", "STOCK2"],
      "reasoning": "Why this opportunity exists",
      "entryTiming": "Now or wait",
      "exitStrategy": "When to take profits"
    }
  ]
}`,
        },
      ],
      response_format: {
        type: "json_object"
      },
    });

    console.log("[Rally Predictions] Got response from AI");
    
    const content = response.choices[0]?.message?.content;
    
    if (!content || typeof content !== "string") {
      console.log("[Rally Predictions] No content in response");
      return [];
    }

    console.log("[Rally Predictions] Parsing JSON (length:", content.length, ")");
    const result = JSON.parse(content) as { predictions: RallyPrediction[] };
    
    console.log(`[Rally Predictions] Parsed ${result.predictions?.length || 0} predictions`);
    
    if (!result.predictions || !Array.isArray(result.predictions)) {
      console.log("[Rally Predictions] Invalid predictions format");
      return [];
    }
    
    // Validate and filter predictions
    const validPredictions = result.predictions.filter(p => 
      p.sector && 
      p.opportunityType && 
      p.confidence >= 40 &&
      p.recommendedStocks &&
      p.recommendedStocks.length > 0
    );
    
    console.log(`[Rally Predictions] ${validPredictions.length} valid predictions after filtering`);
    
    return validPredictions;
  } catch (error) {
    console.error("[Rally Predictions] ERROR:", error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.stack) {
      console.error("[Rally Predictions] Stack:", error.stack.substring(0, 500));
    }
    return [];
  }
}

/**
 * Calculate rally probability based on multiple factors
 */
export function calculateRallyProbability(
  newsCount: number,
  bullishRatio: number,
  momentumTrend: "increasing" | "stable" | "decreasing",
  arkActivity: boolean,
  historicalMatch: boolean
): number {
  let probability = 0;

  // News volume (0-30 points)
  if (newsCount >= 10) probability += 30;
  else if (newsCount >= 5) probability += 20;
  else if (newsCount >= 3) probability += 10;

  // Sentiment (0-25 points)
  if (bullishRatio >= 0.8) probability += 25;
  else if (bullishRatio >= 0.6) probability += 15;
  else if (bullishRatio >= 0.5) probability += 5;

  // Momentum trend (0-20 points)
  if (momentumTrend === "increasing") probability += 20;
  else if (momentumTrend === "stable") probability += 10;

  // ARK activity (0-15 points)
  if (arkActivity) probability += 15;

  // Historical pattern match (0-10 points)
  if (historicalMatch) probability += 10;

  return Math.min(100, probability);
}

/**
 * Identify early warning signals from news patterns
 */
export function detectEarlySignals(
  sector: string,
  recentNews: NewsArticle[],
  timeWindow: number = 7
): string[] {
  const signals: string[] = [];
  const sectorNews = recentNews.filter(n => {
    if (!n.sectors) return false;
    const sectors = JSON.parse(n.sectors);
    return sectors.includes(sector);
  });

  // Signal 1: Increasing news volume
  if (sectorNews.length >= 3) {
    signals.push(`${sectorNews.length} news articles in ${timeWindow} days`);
  }

  // Signal 2: High bullish sentiment
  const bullishCount = sectorNews.filter(n => n.sentiment === "bullish").length;
  const bullishRatio = bullishCount / sectorNews.length;
  if (bullishRatio >= 0.6) {
    signals.push(`${Math.round(bullishRatio * 100)}% bullish sentiment`);
  }

  // Signal 3: Rally indicators
  const strongRallyCount = sectorNews.filter(n => 
    n.rallyIndicator === "strong" || n.rallyIndicator === "moderate"
  ).length;
  if (strongRallyCount >= 2) {
    signals.push(`${strongRallyCount} articles showing rally indicators`);
  }

  // Signal 4: Multiple stocks mentioned
  const allStocks = new Set<string>();
  sectorNews.forEach(n => {
    if (n.mentionedStocks) {
      const stocks = JSON.parse(n.mentionedStocks);
      stocks.forEach((s: string) => allStocks.add(s));
    }
  });
  if (allStocks.size >= 3) {
    signals.push(`${allStocks.size} different stocks gaining attention`);
  }

  return signals;
}

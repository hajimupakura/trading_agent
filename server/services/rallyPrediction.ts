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
    // Prepare data for LLM analysis
    const newsData = recentNews.map(n => ({
      title: n.title,
      summary: n.aiSummary || n.summary,
      sentiment: n.sentiment,
      sectors: n.sectors ? JSON.parse(n.sectors) : [],
      stocks: n.mentionedStocks ? JSON.parse(n.mentionedStocks) : [],
      rallyIndicator: n.rallyIndicator,
      publishedAt: n.publishedAt,
    }));

    const response = await invokeLLM({
      messages: [
        {
          role: "system",
          content: `You are an expert market analyst specializing in predicting MONEY-MAKING OPPORTUNITIES 2-3 weeks early.

Your task: Analyze current news patterns and historical data to predict upcoming opportunities for BOTH calls (upside) and puts (downside).

CRITICAL RULES FOR PREDICTIONS:
1. Focus on EARLY SIGNALS - indicators that appear 2-3 weeks BEFORE major moves
2. Detect BOTH upward rallies (call opportunities) AND downward moves (put opportunities)
3. DO NOT limit to specific sectors - look for movement ANYWHERE in the market
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
          content: `Analyze these ${recentNews.length} recent news articles and predict upcoming opportunities:

${JSON.stringify(newsData, null, 2)}

Identify BOTH:
1. Upside opportunities (calls) - sectors/stocks showing early rally signals
2. Downside opportunities (puts) - sectors/stocks showing early decline signals

Focus on what's MOVING in the market, regardless of sector. Discover new emerging sectors automatically.`,
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "rally_predictions",
          strict: true,
          schema: {
            type: "object",
            properties: {
              predictions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    sector: {
                      type: "string",
                      description: "Specific sector or category name (discover new sectors)",
                    },
                    opportunityType: {
                      type: "string",
                      enum: ["call", "put"],
                      description: "Type of opportunity - call for upside, put for downside",
                    },
                    direction: {
                      type: "string",
                      enum: ["up", "down"],
                      description: "Expected market direction - up for rallies, down for declines",
                    },
                    confidence: {
                      type: "number",
                      description: "Confidence score 0-100",
                    },
                    timeframe: {
                      type: "string",
                      enum: ["2-3 weeks", "1-2 months", "3-6 months"],
                      description: "Expected timeframe for rally",
                    },
                    earlySignals: {
                      type: "array",
                      items: { type: "string" },
                      description: "Specific early warning signals detected",
                    },
                    recommendedStocks: {
                      type: "array",
                      items: { type: "string" },
                      description: "Stock tickers to consider",
                    },
                    reasoning: {
                      type: "string",
                      description: "Detailed explanation of why this rally is predicted",
                    },
                    entryTiming: {
                      type: "string",
                      description: "When to enter positions (e.g., 'Now', 'Wait for dip', 'After catalyst X')",
                    },
                    exitStrategy: {
                      type: "string",
                      description: "When to take profits (e.g., '2-3 weeks', 'After 20% gain', 'Before earnings')",
                    },
                  },
                  required: [
                    "sector",
                    "opportunityType",
                    "direction",
                    "confidence",
                    "timeframe",
                    "earlySignals",
                    "recommendedStocks",
                    "reasoning",
                    "entryTiming",
                    "exitStrategy",
                  ],
                  additionalProperties: false,
                },
              },
            },
            required: ["predictions"],
            additionalProperties: false,
          },
        },
      },
    });

    const content = response.choices[0]?.message?.content;
    if (!content || typeof content !== "string") {
      return [];
    }

    const result = JSON.parse(content) as { predictions: RallyPrediction[] };
    
    // Filter for medium to high confidence predictions
    return result.predictions.filter(p => p.confidence >= 55);
  } catch (error) {
    console.error("Error predicting rallies:", error);
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

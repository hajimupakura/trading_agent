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
  // Options trading specific
  optionsStrategy?: string;
  suggestedStrike?: string;
  suggestedExpiration?: string;
  entryStrategy?: string;
  riskAssessment?: string;
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

**CRITICAL: CORRECTLY LABEL OPPORTUNITY TYPE:**
- If news is BULLISH/POSITIVE/UPSIDE → use "opportunityType": "call" and "direction": "up"
- If news is BEARISH/NEGATIVE/DOWNSIDE → use "opportunityType": "put" and "direction": "down"

DO NOT label bearish scenarios (downgrades, shutdowns, weakness, decline, shorting) as "call" - those are "put" opportunities!

Provide predictions in this exact JSON format with BOTH examples:
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
      "reasoning": "Positive catalyst driving upside",
      "entryTiming": "Now or wait",
      "exitStrategy": "When to take profits"
    },
    {
      "sector": "Another Sector",
      "opportunityType": "put",
      "direction": "down",
      "confidence": 80,
      "timeframe": "2-3 weeks",
      "earlySignals": ["negative signal1", "bearish signal2"],
      "recommendedStocks": ["STOCK3", "STOCK4"],
      "reasoning": "Negative catalyst driving downside - government shutdown risk, downgrades, weakness",
      "entryTiming": "Enter puts now",
      "exitStrategy": "Exit when risk subsides"
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

    // Fix mismatched opportunityType - if reasoning is bearish but labeled as "call", fix it
    validPredictions.forEach(p => {
      const reasoningLower = (p.reasoning || '').toLowerCase();
      const signalsText = (p.earlySignals || []).join(' ').toLowerCase();
      const combinedText = reasoningLower + ' ' + signalsText;

      // Bearish keywords that indicate PUT opportunity
      const bearishKeywords = [
        'bearish', 'downside', 'decline', 'downgrade', 'weakness', 'weak',
        'negative', 'shutdown', 'risk-off', 'puts', 'short', 'shorting',
        'falling', 'drop', 'crash', 'sell', 'exits', 'failure', 'worst',
        'headwind', 'threat', 'investigation', 'warning', 'cut', 'breakdown'
      ];

      // Bullish keywords that indicate CALL opportunity
      const bullishKeywords = [
        'bullish', 'upside', 'rally', 'upgrade', 'strength', 'strong',
        'positive', 'breakthrough', 'buying', 'breakout', 'surge', 'gain',
        'approval', 'rising', 'growth', 'opportunity', 'momentum'
      ];

      const bearishCount = bearishKeywords.filter(kw => combinedText.includes(kw)).length;
      const bullishCount = bullishKeywords.filter(kw => combinedText.includes(kw)).length;

      // If predominantly bearish but labeled as call, fix it
      if (bearishCount > bullishCount && p.opportunityType === 'call') {
        console.log(`[Rally Predictions] Auto-correcting: "${p.sector}" was labeled CALL but is bearish (${bearishCount} bearish keywords vs ${bullishCount} bullish)`);
        p.opportunityType = 'put';
        p.direction = 'down';
      }

      // If predominantly bullish but labeled as put, fix it
      if (bullishCount > bearishCount && p.opportunityType === 'put') {
        console.log(`[Rally Predictions] Auto-correcting: "${p.sector}" was labeled PUT but is bullish (${bullishCount} bullish keywords vs ${bearishCount} bearish)`);
        p.opportunityType = 'call';
        p.direction = 'up';
      }
    });

    console.log(`[Rally Predictions] ${validPredictions.length} valid predictions after filtering and correction`);

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

/**
 * Generate specific options trading recommendations for a prediction
 * Includes strike prices, expiration dates, entry/exit strategy, and risk assessment
 */
export async function generateOptionsRecommendation(
  prediction: RallyPrediction
): Promise<{
  optionsStrategy: string;
  suggestedStrike: string;
  suggestedExpiration: string;
  entryStrategy: string;
  exitStrategy: string;
  riskAssessment: string;
}> {
  try {
    const response = await invokeLLM({
      messages: [
        {
          role: "system",
          content: `You are an expert options trader providing specific, actionable options trading recommendations.

DISCLAIMER: This is for a personal trading system. All recommendations are educational and for personal use only.

Your task: Given a market prediction, provide specific options trading recommendations including:
1. Strike price selection (ATM, OTM, ITM with rationale)
2. Expiration date (with reasoning based on catalyst timing)
3. Entry strategy (when to enter, what price points)
4. Exit strategy (profit targets, stop losses, roll strategy)
5. Risk assessment (position sizing, max loss, probability of profit)

Key principles for options recommendations:
- For high-confidence predictions (>75%): Suggest closer to ATM (at-the-money) with longer expiration
- For moderate confidence (50-75%): Suggest OTM (out-of-the-money) with medium expiration
- For lower confidence (<50%): Suggest further OTM with shorter expiration or spreads to limit risk
- Always consider upcoming earnings dates, Fed meetings, economic data releases
- Suggest specific expiration dates based on the predicted timeframe
- Include position sizing as % of portfolio (conservative approach)
- Always provide exit strategy with specific profit targets and stop losses`,
        },
        {
          role: "user",
          content: `Generate specific options trading recommendations for this prediction:

**Prediction Details:**
- Sector: ${prediction.sector}
- Opportunity Type: ${prediction.opportunityType === 'call' ? 'CALL (Bullish/Upside)' : 'PUT (Bearish/Downside)'}
- Direction: ${prediction.direction.toUpperCase()}
- Confidence: ${prediction.confidence}%
- Timeframe: ${prediction.timeframe}
- Key Stocks: ${prediction.recommendedStocks.join(', ')}
- Reasoning: ${prediction.reasoning}
- Early Signals: ${prediction.earlySignals.join('; ')}
- Entry Timing: ${prediction.entryTiming}

Provide recommendations in this exact JSON format:
{
  "optionsStrategy": "BUY CALLS on [TICKER] - detailed strategy with strike/exp reasoning",
  "suggestedStrike": "For [TICKER]: ATM ($XXX), OTM ($XXX), or Spread ($XXX/$XXX) with detailed rationale for each stock",
  "suggestedExpiration": "Suggested expiration: [DATE] (e.g., Feb 21, 2026 or March monthlies). Explain timing based on catalyst timeline and theta decay",
  "entryStrategy": "Enter when: [specific conditions]. If stock is at $XXX, enter. Wait for: [technical levels]. Position size: X% of portfolio. DCA strategy if applicable",
  "exitStrategy": "Take profits at: [specific targets]. Stop loss at: [specific level]. Roll strategy if thesis intact but more time needed. Close by: [specific conditions]",
  "riskAssessment": "Max loss: $XXX per contract or X% of position. Probability of profit: ~XX%. Key risks: [list]. Position sizing: X contracts or X% portfolio. Risk/reward: 1:X"
}

Be specific with dollar amounts, dates, and percentages. This is for personal trading only.`,
        },
      ],
      response_format: {
        type: "json_object"
      },
    });

    const content = response.choices[0]?.message?.content;
    if (!content || typeof content !== "string") {
      throw new Error("No content in options recommendation response");
    }

    const result = JSON.parse(content);
    
    return {
      optionsStrategy: result.optionsStrategy || "No strategy generated",
      suggestedStrike: result.suggestedStrike || "Strike analysis pending",
      suggestedExpiration: result.suggestedExpiration || "Expiration analysis pending",
      entryStrategy: result.entryStrategy || "Entry timing analysis pending",
      exitStrategy: result.exitStrategy || result.exitStrategy || prediction.exitStrategy,
      riskAssessment: result.riskAssessment || "Risk analysis pending",
    };
  } catch (error) {
    console.error("[Options Recommendation] ERROR:", error);
    return {
      optionsStrategy: `${prediction.opportunityType === 'call' ? 'CALL' : 'PUT'} options on ${prediction.recommendedStocks.join(', ')}`,
      suggestedStrike: "Analysis pending - check back soon",
      suggestedExpiration: `${prediction.timeframe} out`,
      entryStrategy: prediction.entryTiming,
      exitStrategy: prediction.exitStrategy,
      riskAssessment: `Confidence: ${prediction.confidence}%. Risk level: ${prediction.confidence > 75 ? 'Low-Moderate' : prediction.confidence > 50 ? 'Moderate' : 'Moderate-High'}`,
    };
  }
}

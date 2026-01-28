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
 * Uses real-time market data from Tradier API
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
  // Live market data
  optionPremium?: string;
  optionGreeks?: string;
  currentStockPrice?: string;
  breakEvenPrice?: string;
  probabilityOfProfit?: number;
  openInterest?: number;
  impliedVolatility?: string;
}> {
  try {
    // Import Tradier service
    const {
      getTradierQuote,
      recommendOption,
      formatOptionDisplay,
      calculateBreakEven,
      calculateProbabilityOfProfit,
    } = await import("./tradierService");

    // Get the primary stock from recommendations
    const primaryStock = prediction.recommendedStocks[0];
    
    if (!primaryStock) {
      throw new Error("No stock ticker provided in prediction");
    }

    console.log(`[Options] Fetching live data for ${primaryStock}...`);

    // Get current stock price
    const quote = await getTradierQuote(primaryStock);
    
    if (!quote) {
      console.warn(`[Options] Could not fetch live data for ${primaryStock}, falling back to AI-only recommendation`);
      return generateFallbackRecommendation(prediction);
    }

    console.log(`[Options] Current price for ${primaryStock}: $${quote.last}`);

    // Get recommended option contract based on confidence and timeframe
    const optionType = prediction.opportunityType === "call" ? "call" : "put";
    const recommendation = await recommendOption(
      primaryStock,
      optionType,
      prediction.confidence,
      prediction.timeframe
    );

    if (!recommendation || !recommendation.contract) {
      console.warn(`[Options] No suitable options found for ${primaryStock}`);
      return generateFallbackRecommendation(prediction);
    }

    const contract = recommendation.contract;
    console.log(`[Options] Found contract: ${contract.symbol} Strike: $${contract.strike}`);

    // Calculate key metrics
    const premium = (contract.bid + contract.ask) / 2 || contract.last;
    const breakEven = calculateBreakEven(contract);
    const probability = calculateProbabilityOfProfit(contract, quote.last);
    const cost = premium * 100; // Cost per contract

    // Format Greeks for storage
    const greeks = {
      delta: contract.delta,
      gamma: contract.gamma,
      theta: contract.theta,
      vega: contract.vega,
      rho: contract.rho,
    };

    // Now use AI to generate detailed strategy with REAL market data
    const response = await invokeLLM({
      messages: [
        {
          role: "system",
          content: `You are an expert options trader providing specific, actionable options trading recommendations based on REAL MARKET DATA.

DISCLAIMER: This is for a personal trading system. All recommendations are educational and for personal use only.

Your task: Given a market prediction and LIVE OPTIONS DATA, provide a detailed trading strategy.

Key principles:
- Use the REAL market data provided (current prices, strikes, premiums, Greeks)
- Explain WHY this specific contract makes sense
- Provide concrete entry/exit conditions
- Calculate real risk/reward based on actual premiums
- Consider the Greeks (Delta, Theta, etc.) in your analysis`,
        },
        {
          role: "user",
          content: `Generate a detailed options trading strategy for this prediction:

**LIVE MARKET DATA (from Tradier API):**
- Stock: ${primaryStock}
- Current Price: $${quote.last.toFixed(2)}
- Change Today: ${quote.changePercent.toFixed(2)}%
- Volume: ${quote.volume.toLocaleString()}

**RECOMMENDED OPTION CONTRACT:**
- Type: ${contract.type.toUpperCase()}
- Strike: $${contract.strike}
- Expiration: ${contract.expiration}
- Premium: $${premium.toFixed(2)} (${cost.toFixed(0)} per contract)
- Break-even: $${breakEven.toFixed(2)}
- Open Interest: ${contract.openInterest.toLocaleString()}
- Volume Today: ${contract.volume}
- Implied Volatility: ${contract.impliedVolatility ? (contract.impliedVolatility * 100).toFixed(1) + "%" : "N/A"}

**GREEKS:**
- Delta: ${contract.delta ? contract.delta.toFixed(3) : "N/A"} (sensitivity to price change)
- Theta: ${contract.theta ? contract.theta.toFixed(3) : "N/A"} (daily time decay)
- Vega: ${contract.vega ? contract.vega.toFixed(3) : "N/A"} (sensitivity to volatility)
- Gamma: ${contract.gamma ? contract.gamma.toFixed(3) : "N/A"}

**PREDICTION DETAILS:**
- Sector: ${prediction.sector}
- Direction: ${prediction.direction.toUpperCase()}
- Confidence: ${prediction.confidence}%
- Timeframe: ${prediction.timeframe}
- Key Signals: ${prediction.earlySignals.join('; ')}
- Reasoning: ${prediction.reasoning}
- Entry Timing: ${prediction.entryTiming}

**ALTERNATIVE STRIKES AVAILABLE:**
${recommendation.alternativeContracts.slice(0, 3).map(alt => 
  `- $${alt.strike} strike: $${((alt.bid + alt.ask) / 2 || alt.last).toFixed(2)} premium, OI: ${alt.openInterest}`
).join('\n')}

Provide recommendations in this exact JSON format:
{
  "optionsStrategy": "Detailed strategy explaining why this specific contract (${contract.type.toUpperCase()} $${contract.strike} exp ${contract.expiration}) is recommended. Explain the logic based on confidence level, Greeks, and premium cost.",
  "suggestedStrike": "Primary: $${contract.strike} (reasoning based on moneyness and confidence). Alternatives: [list 2-3 alternative strikes with brief rationale]",
  "suggestedExpiration": "${contract.expiration} (${Math.ceil((new Date(contract.expiration).getTime() - Date.now()) / (1000 * 60 * 60 * 24))} days out). Explain why this timeframe aligns with the ${prediction.timeframe} prediction and theta decay considerations.",
  "entryStrategy": "Based on current price of $${quote.last.toFixed(2)}: [Provide specific entry conditions]. Consider: current premium of $${premium.toFixed(2)}, break-even at $${breakEven.toFixed(2)}, and delta of ${contract.delta?.toFixed(3) || 'N/A'}. Position sizing: [specific % of portfolio or number of contracts]",
  "exitStrategy": "Profit targets: [specific prices or % gains]. Stop loss: [specific conditions]. Given theta of ${contract.theta?.toFixed(3) || 'N/A'}, explain time-based exits. Roll strategy if needed.",
  "riskAssessment": "Max loss per contract: $${cost.toFixed(0)}. Probability of profit: ~${probability}% (based on delta). Break-even requires stock to reach $${breakEven.toFixed(2)} (${((breakEven - quote.last) / quote.last * 100).toFixed(1)}% move). IV of ${contract.impliedVolatility ? (contract.impliedVolatility * 100).toFixed(1) + '%' : 'N/A'} indicates [high/medium/low] volatility. [Assess overall risk level and position sizing]"
}`,
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
      optionsStrategy: result.optionsStrategy || "Strategy analysis pending",
      suggestedStrike: result.suggestedStrike || `$${contract.strike}`,
      suggestedExpiration: result.suggestedExpiration || contract.expiration,
      entryStrategy: result.entryStrategy || prediction.entryTiming,
      exitStrategy: result.exitStrategy || prediction.exitStrategy,
      riskAssessment: result.riskAssessment || `Max loss: $${cost.toFixed(0)} per contract`,
      // Live market data
      optionPremium: `$${premium.toFixed(2)}`,
      optionGreeks: JSON.stringify(greeks),
      currentStockPrice: `$${quote.last.toFixed(2)}`,
      breakEvenPrice: `$${breakEven.toFixed(2)}`,
      probabilityOfProfit: probability,
      openInterest: contract.openInterest,
      impliedVolatility: contract.impliedVolatility ? `${(contract.impliedVolatility * 100).toFixed(1)}%` : undefined,
    };
  } catch (error) {
    console.error("[Options Recommendation] ERROR:", error);
    return generateFallbackRecommendation(prediction);
  }
}

/**
 * Fallback recommendation when live data is unavailable
 */
function generateFallbackRecommendation(prediction: RallyPrediction): {
  optionsStrategy: string;
  suggestedStrike: string;
  suggestedExpiration: string;
  entryStrategy: string;
  exitStrategy: string;
  riskAssessment: string;
} {
  const optionType = prediction.opportunityType === "call" ? "CALL" : "PUT";
  
  return {
    optionsStrategy: `${optionType} options on ${prediction.recommendedStocks.join(', ')}. Note: Live market data unavailable - verify all details with your broker before trading.`,
    suggestedStrike: "Check current stock price and select strikes based on your risk tolerance: ATM for high confidence, OTM for lower confidence",
    suggestedExpiration: `${prediction.timeframe} out. Suggest adding 2-week buffer to avoid theta decay. Use monthly expirations for better liquidity.`,
    entryStrategy: prediction.entryTiming + ". Verify current option premiums and select liquid contracts (open interest >100).",
    exitStrategy: prediction.exitStrategy + ". Set stop loss if underlying moves against you by 10-15%.",
    riskAssessment: `Confidence: ${prediction.confidence}%. Risk level: ${prediction.confidence > 75 ? 'Low-Moderate' : prediction.confidence > 50 ? 'Moderate' : 'Moderate-High'}. Always verify live data before trading.`,
  };
}

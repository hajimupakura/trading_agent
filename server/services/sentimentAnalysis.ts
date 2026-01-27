import { invokeLLM } from "../_core/llm";
import { NewsArticle } from "../../drizzle/schema";

/**
 * AI-powered sentiment analysis and stock potential classification
 * Uses LLM to analyze financial news and extract insights
 */

export interface SentimentAnalysisResult {
  sentiment: "bullish" | "bearish" | "neutral";
  opportunityType: "call" | "put" | "both" | "none";
  momentumDirection: "up" | "down" | "sideways";
  potentialTerm: "short" | "medium" | "long" | "none";
  aiSummary: string;
  mentionedStocks: string[];
  sectors: string[];
  rallyIndicator: "strong" | "moderate" | "weak" | "none";
  confidence: number;
}

/**
 * Analyze news article sentiment and extract key information
 */
export async function analyzeNewsArticle(article: {
  title: string;
  summary?: string | null;
  content?: string | null;
}): Promise<SentimentAnalysisResult> {
  try {
    const text = `${article.title}\n\n${article.summary || ""}\n\n${article.content || ""}`.trim();

    const response = await invokeLLM({
      messages: [
        {
          role: "system",
          content: `You are a financial market analyst specializing in identifying MONEY-MAKING OPPORTUNITIES.

Your goal: Find opportunities for BOTH calls (upside) and puts (downside) across ALL markets and sectors.

**PRIORITY INTERESTS** (Pay special attention to these):
- **AI Companies**: OpenAI (ChatGPT, GPT-5), Anthropic (Claude), Google (Gemini, GOOGL), Perplexity
- **Artificial Intelligence**: AI models, AGI, AI agents, AI chips, AI applications
- **Semiconductors/Chips**: NVIDIA (NVDA), AMD, Intel, TSMC, AI accelerators, GPUs
- **Quantum Computing**: Quantum processors, quantum networking, quantum algorithms
- **Unmanned Aerial Vehicles (UAVs)**: Drones, autonomous aircraft, delivery systems
- **Tesla (TSLA)**: EVs, Full Self-Driving, energy products, robotics, Optimus
- **SpaceX**: Rockets, Starlink, Starship, space commercialization, satellite internet
- **Metals**: Rare earth elements, lithium, copper, critical minerals, aluminum
- **Energy**: Renewables, nuclear, solar, wind, grid infrastructure, SMRs
- **Batteries**: Lithium-ion, solid-state, energy storage systems
- **AI-Powered Healthcare/Biotech**: Drug discovery, gene editing, CRISPR, computational biology

Your task:
1. Determine sentiment (bullish/bearish/neutral)
2. Identify opportunity type: CALL (upside potential) or PUT (downside risk)
3. Determine momentum direction: UP (rallying/gaining) or DOWN (declining/falling)
4. Identify investment timeframe (short-term: 2-4 weeks, medium-term: 1-3 months, long-term: 3+ months, none: no clear opportunity)
5. Extract mentioned stock tickers (NVDA, GOOGL, TSLA, AMD, TSMC, etc.)
6. Identify sector/category - BE SPECIFIC about the priority sectors above when relevant
7. Assess movement strength (strong/moderate/weak/none) based on volume, price action, and catalysts
8. Provide a concise 2-3 sentence summary highlighting the MONEY-MAKING angle

Focus on: What's moving? Why? Can we profit in 2-3 weeks with calls OR puts?
Give EXTRA WEIGHT to news about the priority interests listed above.`,
        },
        {
          role: "user",
          content: `Analyze this financial news article:\n\n${text}`,
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "sentiment_analysis",
          strict: true,
          schema: {
            type: "object",
            properties: {
              sentiment: {
                type: "string",
                enum: ["bullish", "bearish", "neutral"],
                description: "Overall market sentiment of the article",
              },
              opportunityType: {
                type: "string",
                enum: ["call", "put", "both", "none"],
                description: "Type of trading opportunity - call (upside), put (downside), both, or none",
              },
              momentumDirection: {
                type: "string",
                enum: ["up", "down", "sideways"],
                description: "Current momentum direction - up (rallying), down (declining), sideways (consolidating)",
              },
              potentialTerm: {
                type: "string",
                enum: ["short", "medium", "long", "none"],
                description: "Investment timeframe - short (2-4 weeks), medium (1-3 months), long (3+ months), none (no clear opportunity)",
              },
              aiSummary: {
                type: "string",
                description: "2-3 sentence summary highlighting key investment insights",
              },
              mentionedStocks: {
                type: "array",
                items: { type: "string" },
                description: "Array of stock ticker symbols mentioned (e.g., NVDA, GOOGL, TSLA)",
              },
              sectors: {
                type: "array",
                items: {
                  type: "string",
                },
                description: "Relevant market sectors or categories (be specific, discover new sectors)",
              },
              rallyIndicator: {
                type: "string",
                enum: ["strong", "moderate", "weak", "none"],
                description: "Strength of potential sector rally signal",
              },
              confidence: {
                type: "number",
                description: "Confidence level in the analysis (0-100)",
              },
            },
            required: [
              "sentiment",
              "opportunityType",
              "momentumDirection",
              "potentialTerm",
              "aiSummary",
              "mentionedStocks",
              "sectors",
              "rallyIndicator",
              "confidence",
            ],
            additionalProperties: false,
          },
        },
      },
    });

    const messageContent = response.choices[0]?.message?.content;
    if (!messageContent || typeof messageContent !== "string") {
      throw new Error("No response from LLM");
    }

    const result = JSON.parse(messageContent) as SentimentAnalysisResult;
    return result;
  } catch (error) {
    console.error("Error analyzing news article:", error);
    
    // Return neutral fallback
    return {
      sentiment: "neutral",
      opportunityType: "none",
      momentumDirection: "sideways",
      potentialTerm: "none",
      aiSummary: "Unable to analyze article at this time.",
      mentionedStocks: [],
      sectors: [],
      rallyIndicator: "none",
      confidence: 0,
    };
  }
}

/**
 * Batch analyze multiple articles
 */
export async function batchAnalyzeArticles(
  articles: Array<{ title: string; summary?: string | null; content?: string | null }>
): Promise<SentimentAnalysisResult[]> {
  const results: SentimentAnalysisResult[] = [];

  for (const article of articles) {
    try {
      const result = await analyzeNewsArticle(article);
      results.push(result);
      
      // Add small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (error) {
      console.error("Error in batch analysis:", error);
      results.push({
        sentiment: "neutral",
        opportunityType: "none",
        momentumDirection: "sideways",
        potentialTerm: "none",
        aiSummary: "Analysis failed",
        mentionedStocks: [],
        sectors: [],
        rallyIndicator: "none",
        confidence: 0,
      });
    }
  }

  return results;
}

/**
 * Detect potential market rally from news patterns
 */
export async function detectRallyFromNews(
  articles: NewsArticle[]
): Promise<{
  sector: string;
  strength: "strong" | "moderate" | "weak" | "none";
  confidence: number;
  summary: string;
}> {
  try {
    // Group articles by sector
    const sectorArticles = new Map<string, NewsArticle[]>();
    
    for (const article of articles) {
      if (!article.sectors) continue;
      
      const sectors = JSON.parse(article.sectors) as string[];
      for (const sector of sectors) {
        if (!sectorArticles.has(sector)) {
          sectorArticles.set(sector, []);
        }
        sectorArticles.get(sector)!.push(article);
      }
    }

    // Find sector with strongest rally signals
    let strongestSector = "other";
    let strongestStrength: "strong" | "moderate" | "weak" | "none" = "none";
    let highestConfidence = 0;

    for (const [sector, sectorNews] of Array.from(sectorArticles.entries())) {
      const bullishCount = sectorNews.filter((a: NewsArticle) => a.sentiment === "bullish").length;
      const rallyCount = sectorNews.filter((a: NewsArticle) => a.rallyIndicator !== "none").length;
      
      const strength = rallyCount / sectorNews.length;
      const confidence = (bullishCount / sectorNews.length) * 100;

      if (confidence > highestConfidence) {
        strongestSector = sector;
        highestConfidence = confidence;
        
        if (strength > 0.6) strongestStrength = "strong";
        else if (strength > 0.3) strongestStrength = "moderate";
        else if (strength > 0.1) strongestStrength = "weak";
        else strongestStrength = "none";
      }
    }

    // Generate summary using LLM
    const summaryResponse = await invokeLLM({
      messages: [
        {
          role: "system",
          content: "You are a market analyst. Summarize rally patterns in 2-3 sentences.",
        },
        {
          role: "user",
          content: `Sector: ${strongestSector}, Strength: ${strongestStrength}, Articles: ${articles.length}. Provide a brief rally summary.`,
        },
      ],
    });

    const summaryContent = summaryResponse.choices[0]?.message?.content;
    const summary = typeof summaryContent === "string" ? summaryContent : "Rally pattern detected";

    return {
      sector: strongestSector,
      strength: strongestStrength,
      confidence: highestConfidence,
      summary,
    };
  } catch (error) {
    console.error("Error detecting rally:", error);
    return {
      sector: "other",
      strength: "none",
      confidence: 0,
      summary: "Unable to detect rally pattern",
    };
  }
}

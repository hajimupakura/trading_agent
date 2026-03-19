import { runSpecialist } from "./runAgent";
import type { AgentSummary, AgentContext } from "./types";
import type { Tool } from "../../_core/llm";

const SYSTEM_PROMPT = `You are a Social & Retail Sentiment Analyst. Your ONLY job is to assess retail investor mood and trending stocks.

Report:
1. Overall retail mood: What is the Fear & Greed Index saying? Interpret the number.
2. Trending stocks: Top 5 most-mentioned stocks on Reddit financial subs
3. Sentiment breakdown: For trending stocks, is retail bullish or bearish?
4. Contrarian signals: Is retail euphoria or panic at extremes suggesting a reversal?

RULES:
- Do NOT make trading recommendations.
- Extreme greed (>75) = caution, potential top. Extreme fear (<25) = opportunity, potential bottom.
- Reddit hype without fundamental backing often leads to sharp reversals.
- Be concise. Maximum 400 tokens.`;

const TOOLS: Tool[] = [
  {
    type: "function",
    function: {
      name: "get_reddit_sentiment",
      description: "Scan Reddit financial subs (WSB, r/stocks, etc.) for trending stocks and sentiment.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_fear_greed_index",
      description: "Get the CNN Fear & Greed Index (0-100). Below 25 = Extreme Fear, above 75 = Extreme Greed.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
];

async function executeTool(name: string, _args: Record<string, any>): Promise<string> {
  if (name === "get_reddit_sentiment") {
    const { scanRedditSentiment } = await import("../socialSentiment");
    const result = await scanRedditSentiment();
    return JSON.stringify({ posts: result.rawPosts, trending: result.trendingStocks.slice(0, 10).map(s => ({ ticker: s.ticker, mentions: s.count, sentiment: s.avgSentiment })) });
  }
  if (name === "get_fear_greed_index") {
    const { getFearGreedIndex } = await import("../fearGreedIndex");
    const fg = await getFearGreedIndex();
    return fg ? JSON.stringify(fg) : JSON.stringify({ error: "Unavailable" });
  }
  return JSON.stringify({ error: "Unknown tool" });
}

export async function runSocialAgent(ctx: AgentContext): Promise<AgentSummary> {
  return runSpecialist(
    { name: "social_retail", systemPrompt: SYSTEM_PROMPT, tools: TOOLS, maxToolCalls: 3, maxOutputTokens: 1024, timeoutMs: 30_000 },
    "Analyze current retail investor sentiment using Reddit and the Fear & Greed Index.",
    executeTool,
  );
}

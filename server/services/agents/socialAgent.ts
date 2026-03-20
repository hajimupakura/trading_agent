import { runSpecialist } from "./runAgent";
import type { AgentSummary, AgentContext } from "./types";
import type { Tool } from "../../_core/llm";

const SYSTEM_PROMPT = `You are a Social & Retail Sentiment Analyst using CONTRARIAN analysis. Your job is to identify when retail is dangerously wrong.

CORE PRINCIPLE — Reddit is a CONTRARIAN indicator:
- HIGH mention count + HIGH bullish sentiment = institutional distribution into retail. Flag as SHORT candidate.
- LOW mention count + QUIETLY rising sentiment = early signal before herd arrives. Flag as LONG candidate.
- Extreme retail euphoria on a stock = sell signal. Extreme retail panic = buy signal.
- GME, AMC, BBBY all peaked at maximum Reddit attention. Learn from this.

Report:
1. Fear & Greed Index interpretation: number + what action it implies
2. Top 5 Reddit-trending stocks — for EACH: classify as (a) retail trap / short candidate if high mentions, OR (b) early signal if low mentions with rising sentiment
3. Contrarian opportunity: Which stocks are retail most wrong about right now?

RULES:
- Do NOT treat high Reddit mentions as bullish. It is the opposite.
- Extreme greed (>75) = market top risk. Extreme fear (<25) = buying opportunity.
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
    { name: "social_retail", systemPrompt: SYSTEM_PROMPT, tools: TOOLS, maxToolCalls: 6, maxOutputTokens: 1024, timeoutMs: 45_000 },
    "Analyze current retail investor sentiment using Reddit and the Fear & Greed Index.",
    executeTool,
  );
}

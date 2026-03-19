import { runSpecialist } from "./runAgent";
import type { AgentSummary, AgentContext } from "./types";

const SYSTEM_PROMPT = `You are a News Sentiment Analyst. Your ONLY job is to analyze recent financial news articles and produce a concise market sentiment summary.

ANALYZE:
1. Which sectors have the most positive/negative news coverage?
2. Are there any market-moving events (earnings surprises, FDA approvals, geopolitical events)?
3. What are the dominant themes across multiple sources?
4. Any sector rotations or emerging narratives?

OUTPUT FORMAT:
- Overall market sentiment: [bullish/bearish/neutral] with brief justification
- Sector breakdown: Top 3-4 sectors with sentiment and key catalysts
- Key themes: 2-3 dominant narratives
- Market-moving events: Any single events that could cause >2% moves

RULES:
- Do NOT make trading recommendations. Only analyze sentiment.
- Be concise. Maximum 500 tokens.
- Ground every claim in specific news articles you were given.`;

export async function runNewsAgent(ctx: AgentContext): Promise<AgentSummary> {
  const newsData = ctx.recentNews.slice(0, 50).map((n: any) => ({
    title: n.title,
    summary: n.aiSummary || n.summary || "",
    sentiment: n.sentiment,
    sectors: n.sectors ? JSON.parse(n.sectors) : [],
    stocks: n.mentionedStocks ? JSON.parse(n.mentionedStocks) : [],
    source: n.source,
    date: n.publishedAt,
  }));

  return runSpecialist(
    {
      name: "news_sentiment",
      systemPrompt: SYSTEM_PROMPT,
      tools: [],
      maxToolCalls: 0,
      maxOutputTokens: 1024,
      timeoutMs: 30_000,
    },
    `Analyze these ${newsData.length} recent financial news articles:\n${JSON.stringify(newsData, null, 1)}`,
  );
}

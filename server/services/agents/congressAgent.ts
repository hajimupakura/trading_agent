import { runSpecialist } from "./runAgent";
import type { AgentSummary, AgentContext } from "./types";
import type { Tool } from "../../_core/llm";

const SYSTEM_PROMPT = `You are a Congressional Trading Analyst. Your ONLY job is to analyze stock trades disclosed by US members of Congress.

Report:
1. Recent notable trades: What are Congress members buying and selling?
2. Pelosi tracker: Any recent trades by Nancy Pelosi? She has a documented track record of outperformance.
3. Cluster activity: Are multiple Congress members buying the same stock? This is a strong signal.
4. Sector trends: Which sectors are Congress members moving into/out of?

RULES:
- Do NOT make trading recommendations.
- Congressional trades are disclosed with a ~45-day delay. They are LEADING indicators, not real-time.
- Focus on PURCHASES, especially by members on Finance, Armed Services, Energy, and Technology committees.
- Cluster buys (3+ members buying same stock) are the strongest Congressional signal.
- Be concise. Maximum 400 tokens.`;

const TOOLS: Tool[] = [
  {
    type: "function",
    function: {
      name: "get_congress_trades",
      description: "Get recent stock trades by US Congress members. Returns representative, ticker, date, type (purchase/sale), amount range.",
      parameters: { type: "object", properties: { days_back: { type: "number", description: "How many days back to look (default 30)" } }, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_pelosi_trades",
      description: "Get Nancy Pelosi's recent stock trades specifically.",
      parameters: { type: "object", properties: { days_back: { type: "number", description: "How many days back (default 90)" } }, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_cluster_buys",
      description: "Find stocks that multiple Congress members are buying (cluster buys). Strong institutional signal.",
      parameters: { type: "object", properties: { days_back: { type: "number" }, min_buyers: { type: "number" } }, required: [] },
    },
  },
];

async function executeTool(name: string, args: Record<string, any>): Promise<string> {
  if (name === "get_congress_trades") {
    const { getRecentCongressTrades } = await import("../congressTracker");
    const trades = await getRecentCongressTrades(args.days_back || 30, 30);
    return JSON.stringify(trades.map(t => ({ rep: t.representative, party: t.party, ticker: t.ticker, date: t.transactionDate, type: t.type, amount: t.amount })));
  }
  if (name === "get_pelosi_trades") {
    const { getPelosiTrades } = await import("../congressTracker");
    const trades = await getPelosiTrades(args.days_back || 90);
    return JSON.stringify(trades.map(t => ({ ticker: t.ticker, date: t.transactionDate, type: t.type, amount: t.amount, desc: t.description })));
  }
  if (name === "get_cluster_buys") {
    const { getClusterBuys } = await import("../congressTracker");
    const clusters = await getClusterBuys(args.days_back || 30, args.min_buyers || 3);
    return JSON.stringify(clusters);
  }
  return JSON.stringify({ error: "Unknown tool" });
}

export async function runCongressAgent(ctx: AgentContext): Promise<AgentSummary> {
  return runSpecialist(
    { name: "congress_trading", systemPrompt: SYSTEM_PROMPT, tools: TOOLS, maxToolCalls: 8, maxOutputTokens: 1024, timeoutMs: 45_000 },
    "Analyze recent Congressional stock trading activity. Check Pelosi's trades and look for cluster buys.",
    executeTool,
  );
}

import { runSpecialist } from "./runAgent";
import type { AgentSummary, AgentContext } from "./types";
import type { Tool } from "../../_core/llm";

const SYSTEM_PROMPT = `You are an Insider & Institutional Trading Analyst. Your ONLY job is to analyze smart money activity.

For each stock, report:
1. Insider activity: purchases vs sales in last 90 days, notable names/titles
2. Material events: recent 8-K filings (acquisitions, leadership changes, earnings surprises)
3. Signal strength: is smart money confirming or contradicting the current trend?

RULES:
- Do NOT make trading recommendations. Only report what insiders and institutions are doing.
- Focus on the TOP 5 stocks from the input.
- Insider BUYING is the strongest bullish signal. Multiple insiders = very bullish.
- Heavy insider SELLING during price declines = bearish red flag.
- Be concise. Maximum 500 tokens.`;

const TOOLS: Tool[] = [
  {
    type: "function",
    function: {
      name: "get_insider_trading",
      description: "Get SEC Form 4 insider trading activity (buys/sells by executives and directors).",
      parameters: { type: "object", properties: { ticker: { type: "string" } }, required: ["ticker"] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_sec_filings",
      description: "Get recent SEC filings (8-K material events, 10-K annual, 10-Q quarterly).",
      parameters: { type: "object", properties: { ticker: { type: "string" }, forms: { type: "string" } }, required: ["ticker"] },
    },
  },
];

async function executeTool(name: string, args: Record<string, any>): Promise<string> {
  if (name === "get_insider_trading") {
    const { getInsiderTransactions } = await import("../secEdgar");
    const txns = await getInsiderTransactions(args.ticker, 10);
    const buys = txns.filter(t => t.transactionType === "purchase").length;
    const sells = txns.filter(t => t.transactionType === "sale").length;
    return JSON.stringify({ ticker: args.ticker, totalFilings: txns.length, buys, sells, recent: txns.slice(0, 5).map(t => ({ name: t.ownerName, type: t.transactionType, date: t.transactionDate })) });
  }
  if (name === "get_sec_filings") {
    const { getRecentFilings } = await import("../secEdgar");
    const filings = await getRecentFilings(args.ticker, args.forms || "8-K,10-K,10-Q", 5);
    return JSON.stringify({ ticker: args.ticker, filings: filings.map(f => ({ type: f.type, date: f.filingDate, desc: f.description })) });
  }
  return JSON.stringify({ error: "Unknown tool" });
}

export async function runInsiderAgent(ctx: AgentContext): Promise<AgentSummary> {
  const stocks = getTopStocks(ctx);
  return runSpecialist(
    { name: "insider_institutional", systemPrompt: SYSTEM_PROMPT, tools: TOOLS, maxToolCalls: 5, maxOutputTokens: 1024, timeoutMs: 45_000 },
    `Analyze insider trading and SEC filings for: ${stocks.join(", ")}`,
    executeTool,
  );
}

function getTopStocks(ctx: AgentContext): string[] {
  const stocks = new Set<string>();
  for (const p of ctx.predictions) {
    if (p.recommendedStocks) for (const s of p.recommendedStocks) stocks.add(s);
  }
  return Array.from(stocks).slice(0, 6);
}

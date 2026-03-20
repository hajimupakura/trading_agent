import { runSpecialist } from "./runAgent";
import type { AgentSummary, AgentContext } from "./types";
import type { Tool } from "../../_core/llm";

const SYSTEM_PROMPT = `You are a Technical Analyst. Your ONLY job is to analyze price action and technical indicators.

For each stock you analyze, report:
1. Trend: uptrend/downtrend/consolidation (SMA20/50/200 alignment)
2. Key levels: nearest support and resistance (Bollinger Bands, SMAs)
3. Momentum: RSI reading and MACD signal
4. Active signals: golden cross, BB squeeze, RSI divergence, etc.
5. Short-term outlook: what technicals suggest for next 1-2 weeks

RULES:
- Do NOT make final trading decisions. Only report what the charts say.
- Analyze the TOP 5 most important stocks from the input.
- Use your tools to get real data. Do not guess indicator values.
- Be concise. Maximum 800 tokens total.`;

const TOOLS: Tool[] = [
  {
    type: "function",
    function: {
      name: "get_stock_quote",
      description: "Get current price, change, volume for a stock.",
      parameters: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_technical_indicators",
      description: "Get RSI(14), MACD, SMA(20/50/200), Bollinger Bands for a stock.",
      parameters: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
    },
  },
];

async function executeTool(name: string, args: Record<string, any>): Promise<string> {
  if (name === "get_stock_quote") {
    const { getStockQuote } = await import("../stockPriceService");
    const q = await getStockQuote(args.symbol);
    return q ? JSON.stringify({ symbol: q.symbol, price: q.price, change: q.changePercent, volume: q.volume }) : JSON.stringify({ error: "No data" });
  }
  if (name === "get_technical_indicators") {
    const { computeIndicators } = await import("../technicalAnalysis");
    const ind = await computeIndicators(args.symbol);
    return ind ? JSON.stringify({ symbol: ind.symbol, price: ind.price, rsi14: ind.rsi14, macd: ind.macd, sma20: ind.sma20, sma50: ind.sma50, sma200: ind.sma200, bollingerBands: ind.bollingerBands, signals: ind.signals }) : JSON.stringify({ error: "Insufficient data" });
  }
  return JSON.stringify({ error: "Unknown tool" });
}

export async function runTechnicalAgent(ctx: AgentContext): Promise<AgentSummary> {
  const stocks = getTopStocks(ctx);
  return runSpecialist(
    { name: "technical_analysis", systemPrompt: SYSTEM_PROMPT, tools: TOOLS, maxToolCalls: 10, maxOutputTokens: 1024, timeoutMs: 60_000 },
    `Analyze technical indicators for these stocks (in priority order): ${stocks.join(", ")}`,
    executeTool,
  );
}

function getTopStocks(ctx: AgentContext): string[] {
  const stocks = new Set<string>();
  for (const p of ctx.predictions) {
    if (p.recommendedStocks) {
      for (const s of p.recommendedStocks) stocks.add(s);
    }
  }
  for (const t of ctx.watchlistTickers.slice(0, 5)) stocks.add(t);
  return Array.from(stocks).slice(0, 8);
}

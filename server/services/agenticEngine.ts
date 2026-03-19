import { invokeLLM, type Message, type Tool, type ToolCall, type InvokeResult } from "../_core/llm";

/**
 * Agentic Decision Engine
 *
 * Instead of pre-fetching all data and dumping it into one prompt,
 * the LLM dynamically decides which tools to call during its reasoning.
 *
 * Flow:
 * 1. LLM receives predictions + portfolio state + available tools
 * 2. LLM reasons: "I should check NVDA insider trading before buying"
 * 3. LLM calls tool: get_insider_trading({ ticker: "NVDA" })
 * 4. We execute the tool, return results to LLM
 * 5. LLM continues reasoning with new data
 * 6. Repeat until LLM outputs final trading decisions
 *
 * Max 10 tool calls per cycle to prevent runaway loops.
 */

const MAX_TOOL_CALLS = 10;

// ── Tool Definitions ─────────────────────────────────────────────────────────

const AGENT_TOOLS: Tool[] = [
  {
    type: "function",
    function: {
      name: "get_stock_quote",
      description: "Get the current price, change, and volume for a stock. Use this before deciding position size or checking if a price target has been hit.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Stock ticker symbol (e.g., NVDA, AAPL)" },
        },
        required: ["symbol"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_technical_indicators",
      description: "Get RSI(14), MACD(12,26,9), SMA(20,50,200), and Bollinger Bands for a stock. Use this to validate predictions with price action data before trading.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Stock ticker symbol" },
        },
        required: ["symbol"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_insider_trading",
      description: "Get recent SEC Form 4 insider trading activity for a stock. Insider buying is one of the strongest bullish signals. Multiple insiders buying = very bullish. Heavy selling = bearish.",
      parameters: {
        type: "object",
        properties: {
          ticker: { type: "string", description: "Stock ticker symbol" },
        },
        required: ["ticker"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_sec_filings",
      description: "Get recent SEC filings (8-K material events, 10-K annual, 10-Q quarterly) for a stock. 8-K filings reveal acquisitions, leadership changes, earnings surprises, contract wins.",
      parameters: {
        type: "object",
        properties: {
          ticker: { type: "string", description: "Stock ticker symbol" },
          forms: { type: "string", description: "Comma-separated form types (default: '8-K,10-K,10-Q')" },
        },
        required: ["ticker"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_reddit_sentiment",
      description: "Scan Reddit financial subreddits (WSB, stocks, investing, options, StockMarket) for trending stocks and retail investor sentiment. Returns mention counts, bullish/bearish ratios, and top posts.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_ticker_sentiment",
      description: "Get Reddit sentiment for specific stock tickers. Returns bullish/bearish/neutral for each.",
      parameters: {
        type: "object",
        properties: {
          tickers: {
            type: "array",
            items: { type: "string" },
            description: "Array of ticker symbols to check sentiment for",
          },
        },
        required: ["tickers"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_price_history",
      description: "Get historical price snapshots for a stock from the last 24 hours (5-min intervals). Use for short-term momentum analysis.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Stock ticker symbol" },
        },
        required: ["symbol"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "submit_trading_decisions",
      description: "Submit your final trading decisions. Call this ONCE when you've finished analyzing and are ready to execute. This is required — the cycle doesn't complete until you submit decisions.",
      parameters: {
        type: "object",
        properties: {
          trades_to_execute: {
            type: "array",
            items: {
              type: "object",
              properties: {
                symbol: { type: "string" },
                side: { type: "string", enum: ["buy", "sell"] },
                quantity: { type: "number" },
                reasoning: { type: "string" },
                confidence: { type: "number" },
              },
              required: ["symbol", "side", "quantity", "reasoning", "confidence"],
            },
            description: "Trades to execute this cycle (max 3)",
          },
          positions_to_close: {
            type: "array",
            items: {
              type: "object",
              properties: {
                symbol: { type: "string" },
                reasoning: { type: "string" },
              },
              required: ["symbol", "reasoning"],
            },
            description: "Existing positions to close",
          },
          market_outlook: { type: "string", description: "Brief market outlook" },
          cash_reserve_recommendation: { type: "number", description: "Recommended cash % (0-100)" },
        },
        required: ["trades_to_execute", "positions_to_close", "market_outlook", "cash_reserve_recommendation"],
      },
    },
  },
];

// ── Tool Execution ───────────────────────────────────────────────────────────

async function executeTool(name: string, args: Record<string, any>): Promise<string> {
  try {
    switch (name) {
      case "get_stock_quote": {
        const { getStockQuote } = await import("./stockPriceService");
        const quote = await getStockQuote(args.symbol);
        if (!quote) return JSON.stringify({ error: `No data for ${args.symbol}` });
        return JSON.stringify({
          symbol: quote.symbol,
          price: quote.price,
          change: quote.change,
          changePercent: quote.changePercent,
          volume: quote.volume,
          high: quote.high,
          low: quote.low,
        });
      }

      case "get_technical_indicators": {
        const { computeIndicators } = await import("./technicalAnalysis");
        const indicators = await computeIndicators(args.symbol);
        if (!indicators) return JSON.stringify({ error: `Insufficient data for ${args.symbol}` });
        return JSON.stringify({
          symbol: indicators.symbol,
          price: indicators.price,
          rsi14: indicators.rsi14,
          macd: indicators.macd,
          sma20: indicators.sma20,
          sma50: indicators.sma50,
          sma200: indicators.sma200,
          bollingerBands: indicators.bollingerBands,
          signals: indicators.signals,
        });
      }

      case "get_insider_trading": {
        const { getInsiderTransactions } = await import("./secEdgar");
        const transactions = await getInsiderTransactions(args.ticker, 10);
        return JSON.stringify({
          ticker: args.ticker,
          totalFilings: transactions.length,
          transactions: transactions.slice(0, 5).map(t => ({
            name: t.ownerName,
            type: t.transactionType,
            date: t.transactionDate,
          })),
          summary: summarizeInsider(transactions),
        });
      }

      case "get_sec_filings": {
        const { getRecentFilings } = await import("./secEdgar");
        const filings = await getRecentFilings(args.ticker, args.forms || "8-K,10-K,10-Q", 5);
        return JSON.stringify({
          ticker: args.ticker,
          filings: filings.map(f => ({
            type: f.type,
            date: f.filingDate,
            description: f.description,
          })),
        });
      }

      case "get_reddit_sentiment": {
        const { scanRedditSentiment } = await import("./socialSentiment");
        const result = await scanRedditSentiment();
        return JSON.stringify({
          totalPosts: result.rawPosts,
          trendingStocks: result.trendingStocks.slice(0, 10).map(s => ({
            ticker: s.ticker,
            mentions: s.count,
            sentiment: s.avgSentiment,
            score: s.totalScore,
          })),
        });
      }

      case "get_ticker_sentiment": {
        const { getTickerSentiment } = await import("./socialSentiment");
        const sentiments = await getTickerSentiment(args.tickers);
        return JSON.stringify(Object.fromEntries(sentiments));
      }

      case "get_price_history": {
        const { getPriceHistory } = await import("../db");
        const history = await getPriceHistory(args.symbol, 48); // Last 4 hours at 5-min intervals
        return JSON.stringify({
          symbol: args.symbol,
          snapshots: history.slice(0, 20).map(s => ({
            price: s.price,
            time: s.capturedAt,
          })),
        });
      }

      case "submit_trading_decisions": {
        // This is the terminal tool — return the decisions as-is
        return JSON.stringify(args);
      }

      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (error: any) {
    return JSON.stringify({ error: `Tool ${name} failed: ${error.message}` });
  }
}

function summarizeInsider(transactions: any[]): string {
  const buys = transactions.filter((t: any) => t.transactionType === "purchase").length;
  const sells = transactions.filter((t: any) => t.transactionType === "sale").length;
  if (transactions.length === 0) return "No recent insider activity";
  return `${transactions.length} filings: ${buys} purchases, ${sells} sales (last 90 days)`;
}

// ── Agentic System Prompt ────────────────────────────────────────────────────

const AGENTIC_SYSTEM_PROMPT = `You are an autonomous portfolio manager with access to real-time market tools.

YOUR PROCESS:
1. Review the predictions and current portfolio provided to you
2. For each prediction you're considering acting on, USE YOUR TOOLS to gather data:
   - Check the current price (get_stock_quote)
   - Verify with technical indicators (get_technical_indicators)
   - Check insider trading activity (get_insider_trading)
   - Look for material SEC filings (get_sec_filings)
   - Check retail sentiment if relevant (get_reddit_sentiment or get_ticker_sentiment)
3. Reason step by step about each potential trade
4. When ready, call submit_trading_decisions with your final decisions

DECISION FRAMEWORK:
- ONLY trade on predictions with confidence >= 65
- NEVER allocate more than 10% of total equity to a single position
- PREFER predictions confirmed by multiple tools:
  * Technical indicators align (RSI, MACD support direction)
  * Insider buying confirms bullish thesis (or selling confirms bearish)
  * No contradicting SEC filings (investigations, guidance cuts)
- CLOSE positions when: thesis is invalidated by new tool data, stop loss is near, or a better opportunity exists
- KEEP 20%+ cash reserve
- Maximum 3 new trades per cycle
- For downside predictions, close existing longs in that sector — don't short

POSITION SIZING:
- High confidence (80-100) + multiple tool confirmations: Up to 8% of equity
- Medium confidence (65-79) or single tool confirmation: Up to 5% of equity

IMPORTANT: You MUST call submit_trading_decisions at the end. Even if you decide to do nothing, submit empty arrays with your reasoning.

If you have yesterday's reflection available, use its lessons to avoid repeating mistakes.`;

// ── Main Agentic Loop ────────────────────────────────────────────────────────

export interface AgenticDecisions {
  trades_to_execute: Array<{
    symbol: string;
    side: "buy" | "sell";
    quantity: number;
    reasoning: string;
    confidence: number;
  }>;
  positions_to_close: Array<{
    symbol: string;
    reasoning: string;
  }>;
  market_outlook: string;
  cash_reserve_recommendation: number;
  toolCallsUsed: number;
  toolsInvoked: string[];
}

export async function runAgenticDecisions(
  predictions: any[],
  portfolio: any,
  agentMemory: string | null,
): Promise<AgenticDecisions> {
  const messages: Message[] = [
    { role: "system", content: AGENTIC_SYSTEM_PROMPT },
    {
      role: "user",
      content: `Here are today's predictions and your current portfolio. Use your tools to validate before deciding.

PREDICTIONS:
${JSON.stringify(predictions.map(p => ({
  sector: p.sector,
  direction: p.direction,
  opportunityType: p.opportunityType,
  confidence: p.confidence,
  timeframe: p.timeframe,
  recommendedStocks: p.recommendedStocks,
  reasoning: p.reasoning,
  entryTiming: p.entryTiming,
})), null, 2)}

CURRENT PORTFOLIO:
Cash: $${portfolio?.cashBalance?.toFixed(2) || "100000.00"}
Total Equity: $${portfolio?.totalEquity?.toFixed(2) || "100000.00"}
Open Positions: ${JSON.stringify(portfolio?.positions?.map((p: any) => ({
  symbol: p.symbol,
  qty: p.quantity,
  entry: p.avgEntryPrice,
  current: p.currentPrice,
  pnl: p.unrealizedPnL,
  pnlPct: p.unrealizedPnLPercent,
})) || [])}

${agentMemory ? `YESTERDAY'S REFLECTION (learn from this):\n${agentMemory}` : ""}

Now analyze with your tools and submit your trading decisions.`,
    },
  ];

  const toolsInvoked: string[] = [];
  let toolCallCount = 0;
  let finalDecisions: AgenticDecisions | null = null;

  // Agentic loop: keep calling LLM until it submits decisions or hits limit
  for (let iteration = 0; iteration < MAX_TOOL_CALLS + 2; iteration++) {
    const response = await invokeLLM({
      messages,
      tools: AGENT_TOOLS,
      toolChoice: toolCallCount >= MAX_TOOL_CALLS ? "auto" : "auto",
    });

    const choice = response.choices[0];
    if (!choice) break;

    const assistantMessage = choice.message;

    // Add assistant response to conversation
    messages.push({
      role: "assistant",
      content: typeof assistantMessage.content === "string"
        ? assistantMessage.content
        : JSON.stringify(assistantMessage.content || ""),
      ...(assistantMessage.tool_calls ? {} : {}),
    });

    // If no tool calls, check if it gave a text response with decisions
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      // LLM finished without calling submit_trading_decisions — try to parse its response
      if (typeof assistantMessage.content === "string") {
        try {
          const parsed = JSON.parse(assistantMessage.content);
          if (parsed.trades_to_execute) {
            finalDecisions = {
              ...parsed,
              toolCallsUsed: toolCallCount,
              toolsInvoked,
            };
          }
        } catch { /* not JSON, LLM just gave text */ }
      }
      break;
    }

    // Process each tool call
    for (const toolCall of assistantMessage.tool_calls) {
      const toolName = toolCall.function.name;
      const toolArgs = JSON.parse(toolCall.function.arguments || "{}");

      console.log(`[Agentic] Tool call #${toolCallCount + 1}: ${toolName}(${JSON.stringify(toolArgs)})`);
      toolsInvoked.push(toolName);

      const result = await executeTool(toolName, toolArgs);
      toolCallCount++;

      // Check if this is the terminal tool
      if (toolName === "submit_trading_decisions") {
        const parsed = JSON.parse(result);
        finalDecisions = {
          trades_to_execute: parsed.trades_to_execute || [],
          positions_to_close: parsed.positions_to_close || [],
          market_outlook: parsed.market_outlook || "",
          cash_reserve_recommendation: parsed.cash_reserve_recommendation || 20,
          toolCallsUsed: toolCallCount,
          toolsInvoked,
        };

        // Still add the tool result to messages for completeness
        messages.push({
          role: "tool",
          content: result,
          tool_call_id: toolCall.id,
        });

        console.log(`[Agentic] Decisions submitted after ${toolCallCount} tool calls`);
        return finalDecisions;
      }

      // Add tool result to conversation
      messages.push({
        role: "tool",
        content: result,
        tool_call_id: toolCall.id,
      });

      // Safety: check if we've hit the limit
      if (toolCallCount >= MAX_TOOL_CALLS) {
        console.warn(`[Agentic] Hit max tool calls (${MAX_TOOL_CALLS}), forcing decision`);
        break;
      }
    }
  }

  // If we got here without final decisions, return empty
  if (!finalDecisions) {
    console.warn("[Agentic] Agent did not submit decisions — returning empty");
    finalDecisions = {
      trades_to_execute: [],
      positions_to_close: [],
      market_outlook: "Agent failed to reach a decision",
      cash_reserve_recommendation: 50,
      toolCallsUsed: toolCallCount,
      toolsInvoked,
    };
  }

  return finalDecisions;
}

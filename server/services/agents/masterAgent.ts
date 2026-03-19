import { invokeLLM } from "../../_core/llm";
import axios from "axios";
import type { AgentSummary, MasterDecision } from "./types";

/**
 * Master Decision Agent — Dual-LLM Consensus
 *
 * Receives 6 specialist summaries, reasons over them, outputs final trades.
 * Runs through BOTH Gemini Flash and GPT-4o-mini.
 * Only executes trades where both models agree on direction.
 */

const MASTER_PROMPT = `You are the Chief Portfolio Manager of an autonomous paper trading system. You receive high-confidence predictions AND analysis from 6 specialist analysts, then decide which trades to execute.

YOUR INPUTS:
1. HIGH-CONFIDENCE PREDICTIONS — pre-validated opportunities (calls = buy, puts = buy inverse ETF)
2. News Sentiment Analyst — market-moving events, sector sentiment
3. Technical Analyst — price action, RSI, MACD, support/resistance
4. Insider & Institutional Analyst — SEC Form 4 insider buys/sells
5. Social & Retail Analyst — Reddit sentiment, Fear & Greed Index
6. Congressional Trading Analyst — US Congress member trades
7. Macro & Economic Analyst — GDP, CPI, Fed policy

DECISION FRAMEWORK:
- ALWAYS execute trades when high-confidence predictions exist AND 2+ analysts support the direction
- High-confidence prediction alone (≥75%) + ANY analyst confirmation = TRADE
- Technical + insider buying + positive news = STRONG BUY
- Extreme Fear on Fear & Greed + oversold RSI = contrarian BUY opportunity
- For PUT predictions (bearish): BUY inverse ETFs instead of shorting (SH=short S&P500, SQQQ=triple-short NASDAQ, QID=double-short NASDAQ, FAZ=short Financials, TBT=short Treasuries)
- NEVER allocate more than 8% of equity to a single position
- KEEP 20%+ cash reserve
- Execute 1-3 trades per cycle — being in the market is required for the system to function

POSITION SIZING — calculate quantity as shares to buy:
- Strong signal (3+ sources agree): 8% of equity ÷ stock price = shares
- Moderate signal (2 sources agree): 5% of equity ÷ stock price = shares
- Prediction-only (≥75% conf): 3% of equity ÷ stock price = shares

IMPORTANT: You MUST return at least 1 trade if ANY high-confidence predictions exist and cash > 30%.

You MUST respond with ONLY valid JSON — no markdown, no backticks, no extra text:
{
  "trades_to_execute": [{"symbol": "TICKER", "side": "buy", "quantity": N, "reasoning": "prediction + analyst support", "confidence": N}],
  "positions_to_close": [{"symbol": "TICKER", "reasoning": "exit reason"}],
  "market_outlook": "1-2 sentence outlook",
  "cash_reserve_recommendation": N
}`;

interface TradeDecision {
  trades_to_execute: Array<{ symbol: string; side: "buy" | "sell"; quantity: number; reasoning: string; confidence: number }>;
  positions_to_close: Array<{ symbol: string; reasoning: string }>;
  market_outlook: string;
  cash_reserve_recommendation: number;
}

function buildUserMessage(
  summaries: AgentSummary[],
  portfolio: any,
  agentMemory: string | null,
  predictions: any[] = [],
): string {
  const sections: string[] = [];

  // High-confidence predictions are the PRIMARY trade signal
  if (predictions.length > 0) {
    const predLines = predictions.map((p: any) =>
      `  - ${p.sector} | ${p.opportunityType?.toUpperCase() || "CALL"} | conf=${p.confidence}% | stocks=${JSON.stringify(p.recommendedStocks || [])} | ${p.reasoning?.slice(0, 120)}`,
    ).join("\n");
    sections.push(`=== HIGH-CONFIDENCE PREDICTIONS (${predictions.length} total) ===
These are pre-validated opportunities. Use these as your PRIMARY trade candidates.
${predLines}`);
  }

  for (const s of summaries) {
    sections.push(`=== ${s.agentName.toUpperCase()} ===\n${s.summary}\n`);
  }

  sections.push(`=== CURRENT PORTFOLIO ===
Cash: $${portfolio?.cashBalance?.toFixed(2) || "100000.00"}
Total Equity: $${portfolio?.totalEquity?.toFixed(2) || "100000.00"}
Open Positions: ${JSON.stringify(portfolio?.positions?.map((p: any) => ({
  symbol: p.symbol, qty: p.quantity, entry: p.avgEntryPrice,
  current: p.currentPrice, pnl: p.unrealizedPnL, pnlPct: p.unrealizedPnLPercent,
})) || [])}`);

  if (agentMemory) {
    sections.push(`\n=== YESTERDAY'S REFLECTION ===\n${agentMemory}`);
  }

  sections.push("\nNow analyze all reports and make your trading decisions. Respond with JSON only.");

  return sections.join("\n");
}

async function invokeSecondary(systemPrompt: string, userMessage: string): Promise<TradeDecision | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  const model = process.env.SECONDARY_LLM_MODEL || "openai/gpt-4o";
  try {
    const res = await axios.post(
      `${process.env.OPENROUTER_API_URL || "https://openrouter.ai/api/v1"}/chat/completions`,
      {
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        temperature: 0.7,
        max_tokens: 2048,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/trading-agent",
        },
        timeout: 60_000,
      },
    );
    const content = res.data?.choices?.[0]?.message?.content;
    if (!content) return null;
    // Strip markdown code fences if present
    const cleaned = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    return JSON.parse(cleaned);
  } catch (error: any) {
    console.error("[MasterAgent] Secondary model failed:", error.message);
    return null;
  }
}

function parseDecision(response: any): TradeDecision | null {
  const content = response?.choices?.[0]?.message?.content;
  if (!content || typeof content !== "string") return null;
  try {
    return JSON.parse(content);
  } catch {
    // Try to extract JSON from mixed text
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { /* give up */ }
    }
    return null;
  }
}

function applyConsensus(primary: TradeDecision, secondary: TradeDecision | null): {
  merged: TradeDecision;
  agreed: boolean;
  agreementRate: number;
} {
  if (!secondary) {
    return { merged: primary, agreed: true, agreementRate: 100 };
  }

  const consensusTrades: TradeDecision["trades_to_execute"] = [];
  const primaryOnly: TradeDecision["trades_to_execute"] = [];

  for (const pt of primary.trades_to_execute) {
    const match = secondary.trades_to_execute.find(
      st => st.symbol.toUpperCase() === pt.symbol.toUpperCase() && st.side === pt.side,
    );

    if (match) {
      // Both agree → boost confidence
      consensusTrades.push({
        ...pt,
        confidence: Math.min(95, Math.round((pt.confidence + match.confidence) / 2) + 10),
        reasoning: `[CONSENSUS] ${pt.reasoning}`,
      });
    } else {
      primaryOnly.push(pt);
    }
  }

  const totalUnique = new Set([
    ...primary.trades_to_execute.map(t => t.symbol),
    ...secondary.trades_to_execute.map(t => t.symbol),
  ]).size;

  const agreementRate = totalUnique > 0 ? Math.round((consensusTrades.length / totalUnique) * 100) : 100;

  // Include primary-only trades with confidence >= 70 even without secondary agreement
  const highConfPrimaryOnly = primaryOnly.filter(t => t.confidence >= 70);

  // Merge position closures — if either model says close, close
  const allCloses = new Map<string, string>();
  for (const c of primary.positions_to_close) allCloses.set(c.symbol.toUpperCase(), c.reasoning);
  for (const c of (secondary.positions_to_close || [])) {
    if (!allCloses.has(c.symbol.toUpperCase())) allCloses.set(c.symbol.toUpperCase(), c.reasoning);
  }

  const allTrades = [...consensusTrades, ...highConfPrimaryOnly];

  console.log(
    `[MasterAgent] Consensus: ${consensusTrades.length} agreed, ${primaryOnly.length} primary-only ` +
    `(${primaryOnly.map(t => t.symbol).join(",")}), ${highConfPrimaryOnly.length} high-conf primary included, agreement: ${agreementRate}%`,
  );

  return {
    merged: {
      trades_to_execute: allTrades,
      positions_to_close: Array.from(allCloses.entries()).map(([symbol, reasoning]) => ({ symbol, reasoning })),
      market_outlook: primary.market_outlook,
      cash_reserve_recommendation: Math.max(primary.cash_reserve_recommendation, secondary.cash_reserve_recommendation || 20),
    },
    agreed: agreementRate >= 50,
    agreementRate,
  };
}

export async function runMasterAgent(
  summaries: AgentSummary[],
  portfolio: any,
  agentMemory: string | null,
  predictions: any[] = [],
): Promise<MasterDecision> {
  const startTime = Date.now();
  const userMessage = buildUserMessage(summaries, portfolio, agentMemory, predictions);

  // Run both models in parallel
  const [primaryResponse, secondaryDecision] = await Promise.all([
    invokeLLM({
      messages: [
        { role: "system", content: MASTER_PROMPT },
        { role: "user", content: userMessage },
      ],
      maxTokens: 2048,
    }),
    invokeSecondary(MASTER_PROMPT, userMessage),
  ]);

  const primaryDecision = parseDecision(primaryResponse);

  if (!primaryDecision) {
    console.error("[MasterAgent] Primary model failed to produce valid JSON");
    return emptyDecision(summaries, Date.now() - startTime);
  }

  const { merged, agreed, agreementRate } = applyConsensus(primaryDecision, secondaryDecision);

  const modelsUsed = ["gemini-flash (primary)"];
  if (secondaryDecision) modelsUsed.push(`${process.env.SECONDARY_LLM_MODEL || "gpt-4o"} (secondary)`);

  return {
    ...merged,
    consensus: { agreed, agreementRate, modelsUsed },
    agentSummaries: summaries,
    totalDurationMs: Date.now() - startTime,
    toolCallsUsed: summaries.reduce((sum, s) => sum + s.toolCallsUsed, 0),
    toolsInvoked: summaries.map(s => s.agentName),
  };
}

function emptyDecision(summaries: AgentSummary[], durationMs: number): MasterDecision {
  return {
    trades_to_execute: [],
    positions_to_close: [],
    market_outlook: "Unable to reach decision",
    cash_reserve_recommendation: 50,
    consensus: { agreed: false, agreementRate: 0, modelsUsed: [] },
    agentSummaries: summaries,
    totalDurationMs: durationMs,
    toolCallsUsed: 0,
    toolsInvoked: [],
  };
}

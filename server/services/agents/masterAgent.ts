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

const MASTER_PROMPT = `You are the Chief Portfolio Manager. You receive analysis from 6 specialist analysts and must make final trading decisions.

YOUR ANALYSTS:
1. News Sentiment Analyst — market-moving events, sector sentiment
2. Technical Analyst — price action, RSI, MACD, support/resistance
3. Insider & Institutional Analyst — SEC Form 4 insider buys/sells, 8-K material events
4. Social & Retail Analyst — Reddit sentiment, Fear & Greed Index
5. Congressional Trading Analyst — what US Congress members are buying (especially Pelosi)
6. Macro & Economic Analyst — GDP, CPI, unemployment, Fed policy

DECISION FRAMEWORK:
- ONLY trade when 3+ analysts' signals align on a stock/sector
- Technical + insider buying + positive news = STRONG BUY signal
- Congressional cluster buying + technical breakout = STRONG signal
- Extreme Fear on Fear & Greed + oversold RSI = contrarian BUY opportunity
- Extreme Greed + overbought RSI + insider selling = SELL/REDUCE signal
- If macro is deteriorating (rising rates, falling GDP), reduce overall exposure
- NEVER allocate more than 10% of equity to a single position
- KEEP 20%+ cash reserve
- Maximum 3 new trades per cycle
- For bearish signals, close existing longs — do NOT short

POSITION SIZING:
- Strong multi-signal (3+ analysts agree): Up to 8% of equity
- Moderate signal (2 analysts agree): Up to 5% of equity
- Single analyst signal: SKIP — not enough confirmation

You MUST respond with ONLY valid JSON matching this schema — no other text:
{
  "trades_to_execute": [{"symbol": "...", "side": "buy|sell", "quantity": N, "reasoning": "which analysts agreed and why", "confidence": N}],
  "positions_to_close": [{"symbol": "...", "reasoning": "..."}],
  "market_outlook": "1-2 sentence outlook",
  "cash_reserve_recommendation": N
}

If no trades meet the 3+ analyst threshold, return empty arrays. Doing nothing is a valid decision.`;

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
): string {
  const sections: string[] = [];

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
    return JSON.parse(content);
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
  const primaryOnly: string[] = [];

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
      primaryOnly.push(pt.symbol);
    }
  }

  const totalUnique = new Set([
    ...primary.trades_to_execute.map(t => t.symbol),
    ...secondary.trades_to_execute.map(t => t.symbol),
  ]).size;

  const agreementRate = totalUnique > 0 ? Math.round((consensusTrades.length / totalUnique) * 100) : 100;

  // Merge position closures — if either model says close, close
  const allCloses = new Map<string, string>();
  for (const c of primary.positions_to_close) allCloses.set(c.symbol.toUpperCase(), c.reasoning);
  for (const c of (secondary.positions_to_close || [])) {
    if (!allCloses.has(c.symbol.toUpperCase())) allCloses.set(c.symbol.toUpperCase(), c.reasoning);
  }

  console.log(
    `[MasterAgent] Consensus: ${consensusTrades.length} agreed, ${primaryOnly.length} primary-only (${primaryOnly.join(",")}), agreement: ${agreementRate}%`,
  );

  return {
    merged: {
      trades_to_execute: consensusTrades,
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
): Promise<MasterDecision> {
  const startTime = Date.now();
  const userMessage = buildUserMessage(summaries, portfolio, agentMemory);

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

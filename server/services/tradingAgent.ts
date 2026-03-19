import { invokeLLM } from "../_core/llm";
import { isMarketHours } from "./rssNewsSync";
import { runMultiAgentDecisions } from "./agents/orchestrator";
import type { AgentContext } from "./agents/types";
import type { CycleSummary, TradeAlert, ClosedPosition, DailySummary } from "./telegramAlert";

/**
 * Semi-Autonomous Trading Agent Orchestrator
 *
 * Runs hourly during market hours. Each cycle:
 * 1. Gathers intelligence (RSS + AI analysis)
 * 2. Generates predictions (6 data sources)
 * 3. Evaluates existing positions (SL/TP)
 * 4. Makes trading decisions via LLM "portfolio manager"
 * 5. Executes paper trades and sends Telegram alerts
 *
 * The LLM decides WHAT to trade — not hardcoded rules.
 * The risk manager enforces HOW MUCH — position limits, drawdown, etc.
 */

// ── Agent State (in-memory, backed by DB) ────────────────────────────────────

interface AgentState {
  isPaused: boolean;
  lastRunTime: Date | null;
  cycleCount: number;
  tradesToday: number;
  lastCycleResult: CycleSummary | null;
  agentMemory: string | null; // Yesterday's reflection
}

const state: AgentState = {
  isPaused: false,
  lastRunTime: null,
  cycleCount: 0,
  tradesToday: 0,
  lastCycleResult: null,
  agentMemory: null,
};

export interface AgentStatus {
  isPaused: boolean;
  lastRunTime: Date | null;
  nextRunTime: Date | null;
  cycleCount: number;
  tradesToday: number;
  lastCycleResult: CycleSummary | null;
  agentMemory: string | null;
}

// ── Control Functions ────────────────────────────────────────────────────────

export async function initAgent() {
  const { getAgentConfigValue } = await import("../db");
  const paused = await getAgentConfigValue("is_paused");
  state.isPaused = paused === "true";
  state.agentMemory = await getAgentConfigValue("agent_memory");
  console.log(`[Agent] Initialized — paused: ${state.isPaused}, has memory: ${!!state.agentMemory}`);
}

export async function pauseAgent() {
  state.isPaused = true;
  const { setAgentConfigValue } = await import("../db");
  await setAgentConfigValue("is_paused", "true").catch(() => {});
  const { sendAgentPaused } = await import("./telegramAlert");
  await sendAgentPaused();
}

export async function resumeAgent() {
  state.isPaused = false;
  const { setAgentConfigValue } = await import("../db");
  await setAgentConfigValue("is_paused", "false").catch(() => {});
  const { sendAgentResumed } = await import("./telegramAlert");
  await sendAgentResumed();
}

export function getAgentStatus(): AgentStatus {
  const now = new Date();
  let nextRun: Date | null = null;
  if (!state.isPaused && state.lastRunTime) {
    nextRun = new Date(state.lastRunTime.getTime() + 60 * 60 * 1000);
  }

  return {
    isPaused: state.isPaused,
    lastRunTime: state.lastRunTime,
    nextRunTime: nextRun,
    cycleCount: state.cycleCount,
    tradesToday: state.tradesToday,
    lastCycleResult: state.lastCycleResult,
    agentMemory: state.agentMemory,
  };
}

// ── Main Agent Cycle ─────────────────────────────────────────────────────────

export async function runAgentCycle(portfolioId: number, userId: number, force = false): Promise<CycleSummary> {
  if (state.isPaused) {
    console.log("[Agent] Paused — skipping cycle");
    return emptySummary(0);
  }
  if (!force && !isMarketHours()) {
    console.log("[Agent] Outside market hours — skipping cycle");
    return emptySummary(0);
  }

  const cycleNumber = ++state.cycleCount;
  const riskWarnings: string[] = [];
  const tradesExecuted: TradeAlert[] = [];
  const positionsClosed: ClosedPosition[] = [];
  let predictionsGenerated = 0;
  let highConfidencePredictions = 0;

  console.log(`[Agent] ═══ Cycle #${cycleNumber} starting ═══`);

  try {
    // ── STEP 1: Gather Intelligence ──────────────────────────────────
    console.log(`[Agent] Step 1: Gathering intelligence...`);
    const { syncRSSNews, analyzePendingNews } = await import("./rssNewsSync");
    await syncRSSNews().catch(err => console.warn("[Agent] RSS sync failed:", err));
    await analyzePendingNews().catch(err => console.warn("[Agent] AI analysis failed:", err));

    // ── STEP 2: Generate Predictions ─────────────────────────────────
    console.log(`[Agent] Step 2: Generating predictions (6 data sources)...`);
    const { predictWithTechnicalValidation, extractHistoricalPatterns } = await import("./rallyPrediction");
    const { getRecentNews, getHistoricalRallies, insertRallyPrediction } = await import("../db");

    const recentNews = await getRecentNews(100);
    const historicalRallies = await getHistoricalRallies();
    const patterns = extractHistoricalPatterns(historicalRallies);

    const predictions = await predictWithTechnicalValidation(recentNews, patterns);
    predictionsGenerated = predictions.length;

    const highConf = predictions.filter(p => p.confidence >= 65);
    highConfidencePredictions = highConf.length;

    // Save predictions
    for (const pred of highConf) {
      await insertRallyPrediction({
        sector: pred.sector,
        name: `Predicted ${pred.sector} ${pred.opportunityType === "put" ? "Decline" : "Rally"}`,
        startDate: new Date(),
        description: pred.reasoning,
        predictionConfidence: pred.confidence,
        earlySignals: JSON.stringify(pred.earlySignals),
        keyStocks: JSON.stringify(pred.recommendedStocks),
        opportunityType: pred.opportunityType === "put" ? "put" : "call",
        direction: pred.direction === "down" ? "down" : "up",
      }).catch(err => console.warn("[Agent] Failed to save prediction:", err));
    }

    console.log(`[Agent] ${predictionsGenerated} predictions (${highConfidencePredictions} high-confidence)`);

    // ── STEP 3: Evaluate Existing Positions ──────────────────────────
    console.log(`[Agent] Step 3: Evaluating positions...`);
    const { checkStopLossTakeProfit } = await import("./riskManager");
    const { executePaperTrade, getPortfolioSummary } = await import("./paperTrading");
    const { getPositionBySymbol } = await import("../db");

    const slTpTriggers = await checkStopLossTakeProfit(portfolioId);

    for (const trigger of slTpTriggers) {
      const pos = await getPositionBySymbol(portfolioId, trigger.symbol);
      if (!pos) continue;

      const result = await executePaperTrade({
        portfolioId, userId,
        symbol: trigger.symbol,
        side: "sell",
        quantity: pos.quantity,
        orderType: "market",
        notes: `[Agent] Auto-close: ${trigger.reason}`,
      });

      if (result.success) {
        positionsClosed.push({
          symbol: trigger.symbol,
          reason: trigger.reason,
          pnl: result.total ? result.total - parseFloat(pos.avgEntryPrice) * pos.quantity : 0,
        });
      }
    }

    // ── STEP 4: Multi-Agent Parallel Decisions ─────────────────────
    console.log(`[Agent] Step 4: Running 6 specialist agents in parallel + master decision...`);
    const portfolio = await getPortfolioSummary(portfolioId, userId);
    const { checkTradeRisk } = await import("./riskManager");
    const { getUserWatchlist } = await import("../db");

    let decisions: { trades_to_execute: any[]; positions_to_close: any[]; market_outlook: string; cash_reserve_recommendation: number } = {
      trades_to_execute: [], positions_to_close: [], market_outlook: "", cash_reserve_recommendation: 20,
    };

    if (portfolio) {
      const watchlist = await getUserWatchlist(userId);
      const agentContext: AgentContext = {
        predictions: highConf,
        portfolio,
        watchlistTickers: watchlist.map((w: any) => w.ticker),
        recentNews,
        agentMemory: state.agentMemory,
      };

      const multiResult = await runMultiAgentDecisions(agentContext);
      decisions = multiResult;

      const agentNames = multiResult.agentSummaries.filter(s => !s.error).map(s => s.agentName);
      console.log(
        `[Agent] Multi-agent complete: ${agentNames.length}/6 agents, ` +
        `${multiResult.toolCallsUsed} total tool calls, ` +
        `consensus: ${multiResult.consensus.agreementRate}%`,
      );
    }

    // Execute trades the LLM decided on
    for (const trade of decisions.trades_to_execute) {
      // Risk check first
      const risk = await checkTradeRisk(portfolioId, userId, trade.symbol, trade.side, trade.quantity);
      if (!risk.allowed) {
        riskWarnings.push(`${trade.symbol}: ${risk.blocked.join("; ")}`);
        continue;
      }

      const qty = trade.quantity || risk.suggestedQuantity || 0;
      if (qty <= 0) continue;

      const result = await executePaperTrade({
        portfolioId, userId,
        symbol: trade.symbol,
        side: trade.side,
        quantity: qty,
        orderType: "market",
        stopLoss: risk.suggestedStopLoss,
        takeProfit: risk.suggestedTakeProfit,
        notes: `[Agent] ${trade.reasoning}`,
      });

      if (result.success) {
        state.tradesToday++;
        tradesExecuted.push({
          symbol: trade.symbol,
          side: trade.side,
          quantity: qty,
          price: result.executedPrice || 0,
          reason: trade.reasoning,
          confidence: trade.confidence,
          stopLoss: risk.suggestedStopLoss,
          takeProfit: risk.suggestedTakeProfit,
        });
      }
    }

    // Close positions the LLM recommended closing
    for (const close of decisions.positions_to_close) {
      const pos = await getPositionBySymbol(portfolioId, close.symbol?.toUpperCase());
      if (!pos) continue;

      const result = await executePaperTrade({
        portfolioId, userId,
        symbol: close.symbol,
        side: "sell",
        quantity: pos.quantity,
        orderType: "market",
        notes: `[Agent] LLM close: ${close.reasoning}`,
      });

      if (result.success) {
        positionsClosed.push({
          symbol: close.symbol,
          reason: close.reasoning,
          pnl: result.total ? result.total - parseFloat(pos.avgEntryPrice) * pos.quantity : 0,
        });
      }
    }

    // ── STEP 5: Alert & Log ──────────────────────────────────────────
    const updatedPortfolio = await getPortfolioSummary(portfolioId, userId);

    const summary: CycleSummary = {
      cycleNumber,
      timestamp: new Date(),
      predictionsGenerated,
      highConfidencePredictions,
      tradesExecuted,
      positionsClosed,
      slTpTriggered: slTpTriggers.length,
      riskWarnings,
      portfolioEquity: updatedPortfolio?.totalEquity || 0,
      portfolioPnL: updatedPortfolio?.totalUnrealizedPnL || 0,
      marketOutlook: decisions.market_outlook,
    };

    state.lastCycleResult = summary;
    state.lastRunTime = new Date();

    // Send Telegram alert (fire and forget)
    const { sendCycleSummary } = await import("./telegramAlert");
    sendCycleSummary(summary).catch(() => {});

    // Save cycle log to DB
    const { insertAgentCycleLog } = await import("../db");
    await insertAgentCycleLog({
      cycleNumber,
      predictionsGenerated,
      tradesExecuted: tradesExecuted.length,
      positionsClosed: positionsClosed.length,
      portfolioEquity: summary.portfolioEquity.toFixed(2),
      portfolioPnL: summary.portfolioPnL.toFixed(2),
      riskWarnings: JSON.stringify(riskWarnings),
      summary: JSON.stringify(summary),
    }).catch(err => console.warn("[Agent] Failed to log cycle:", err));

    console.log(
      `[Agent] ═══ Cycle #${cycleNumber} complete ═══ ` +
      `Trades: ${tradesExecuted.length}, Closed: ${positionsClosed.length}, ` +
      `Equity: $${summary.portfolioEquity.toFixed(2)}`
    );

    return summary;

  } catch (error: any) {
    console.error(`[Agent] Cycle #${cycleNumber} FAILED:`, error);
    const { sendRiskWarning } = await import("./telegramAlert");
    sendRiskWarning(`Cycle #${cycleNumber} failed: ${error.message}`).catch(() => {});
    return emptySummary(cycleNumber);
  }
}

// ── Stop Loss / Take Profit Quick Check (every 5 min) ────────────────────────

export async function runStopLossCheck(portfolioId: number, userId: number): Promise<void> {
  if (state.isPaused || !isMarketHours()) return;

  try {
    const { checkStopLossTakeProfit } = await import("./riskManager");
    const triggers = await checkStopLossTakeProfit(portfolioId);

    if (triggers.length === 0) return;

    const { executePaperTrade } = await import("./paperTrading");
    const { getPositionBySymbol } = await import("../db");
    const { sendTradeAlert } = await import("./telegramAlert");

    for (const trigger of triggers) {
      const pos = await getPositionBySymbol(portfolioId, trigger.symbol);
      if (!pos) continue;

      const result = await executePaperTrade({
        portfolioId, userId,
        symbol: trigger.symbol,
        side: "sell",
        quantity: pos.quantity,
        orderType: "market",
        notes: `[Agent SL/TP] ${trigger.reason}`,
      });

      if (result.success) {
        sendTradeAlert({
          symbol: trigger.symbol,
          side: "sell",
          quantity: pos.quantity,
          price: result.executedPrice || trigger.currentPrice,
          reason: trigger.reason,
          confidence: 100,
        }).catch(() => {});
      }
    }
  } catch (error) {
    console.error("[Agent] SL/TP check failed:", error);
  }
}

// ── Daily Reflection (4 PM EST) ──────────────────────────────────────────────

export async function runDailyReflection(portfolioId: number, userId: number): Promise<string> {
  console.log("[Agent] Running daily reflection...");

  try {
    const { getTodaysCycleLogs } = await import("../db");
    const { getPortfolioSummary } = await import("./paperTrading");
    const { getPortfolioTradeHistory } = await import("../db");
    const { sendDailySummary } = await import("./telegramAlert");
    const { setAgentConfigValue } = await import("../db");

    const todaysLogs = await getTodaysCycleLogs();
    const portfolio = await getPortfolioSummary(portfolioId, userId);
    const trades = await getPortfolioTradeHistory(portfolioId, 20);

    const todaysTrades = trades.filter(t => {
      const tradeDate = new Date(t.executedAt);
      const today = new Date();
      return tradeDate.toDateString() === today.toDateString();
    });

    // Ask LLM to reflect
    const response = await invokeLLM({
      messages: [
        {
          role: "system",
          content: DAILY_REFLECTION_PROMPT,
        },
        {
          role: "user",
          content: JSON.stringify({
            cyclesRun: todaysLogs.length,
            tradesExecuted: todaysTrades.length,
            trades: todaysTrades.map(t => ({
              symbol: t.symbol,
              side: t.side,
              quantity: t.quantity,
              price: t.price,
              notes: t.notes,
            })),
            portfolioEquity: portfolio?.totalEquity || 0,
            unrealizedPnL: portfolio?.totalUnrealizedPnL || 0,
            positions: portfolio?.positions?.map(p => ({
              symbol: p.symbol,
              pnl: p.unrealizedPnL,
              pnlPercent: p.unrealizedPnLPercent,
            })) || [],
          }),
        },
      ],
    });

    const reflection = typeof response.choices[0]?.message?.content === "string"
      ? response.choices[0].message.content
      : "Unable to generate reflection.";

    // Save reflection as agent memory for tomorrow
    state.agentMemory = reflection;
    await setAgentConfigValue("agent_memory", reflection).catch(() => {});

    // Reset daily counters
    state.tradesToday = 0;

    // Send daily summary
    const totalPnL = todaysTrades.reduce((sum, t) => {
      return sum + (t.side === "sell" ? parseFloat(t.total) : -parseFloat(t.total));
    }, 0);

    await sendDailySummary({
      date: new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" }),
      cyclesRun: todaysLogs.length,
      totalTradesExecuted: todaysTrades.length,
      totalPnL,
      portfolioEquity: portfolio?.totalEquity || 0,
      bestTrade: todaysTrades.length > 0 ? `${todaysTrades[0]!.symbol} ${todaysTrades[0]!.side}` : "No trades",
      worstTrade: "—",
      agentReflection: reflection,
    });

    console.log("[Agent] Daily reflection complete");
    return reflection;

  } catch (error: any) {
    console.error("[Agent] Daily reflection failed:", error);
    return "Reflection failed: " + error.message;
  }
}

const DAILY_REFLECTION_PROMPT = `You are reviewing your own trading performance for the day as an autonomous paper trading agent.

Given today's cycles, trades, and portfolio state, analyze:
1. Which trades were CORRECT? What signals led to good decisions?
2. Which trades were WRONG or underperforming? What did you miss?
3. Are there recurring patterns in your errors?
4. What specific adjustment should you make tomorrow?

Be specific and actionable. This reflection will be included in tomorrow's decision-making context.
Output a concise paragraph (3-5 sentences) of your key learnings.`;

// ── Helpers ──────────────────────────────────────────────────────────────────

function emptySummary(cycleNumber: number): CycleSummary {
  return {
    cycleNumber,
    timestamp: new Date(),
    predictionsGenerated: 0,
    highConfidencePredictions: 0,
    tradesExecuted: [],
    positionsClosed: [],
    slTpTriggered: 0,
    riskWarnings: [],
    portfolioEquity: 0,
    portfolioPnL: 0,
  };
}

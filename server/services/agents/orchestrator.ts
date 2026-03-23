import type { AgentContext, AgentSummary, MasterDecision } from "./types";
import { runNewsAgent } from "./newsAgent";
import { runTechnicalAgent } from "./technicalAgent";
import { runInsiderAgent } from "./insiderAgent";
import { runSocialAgent } from "./socialAgent";
import { runCongressAgent } from "./congressAgent";
import { runMacroAgent } from "./macroAgent";
import { runGeopoliticalAgent } from "./geopoliticalAgent";
import { runMasterAgent } from "./masterAgent";

/**
 * Multi-Agent Orchestrator
 *
 * Runs 6 specialist agents in parallel, collects summaries,
 * feeds to master agent with dual-LLM consensus.
 *
 * Total time ≈ slowest specialist + master agent (~20-40 seconds)
 * NOT sum of all agents (which would be ~2-3 minutes serial).
 */

export async function runMultiAgentDecisions(ctx: AgentContext): Promise<MasterDecision> {
  const startTime = Date.now();

  console.log("[Orchestrator] ═══ Starting 7 specialist agents in parallel ═══");

  // Run ALL specialists in parallel — if one fails, others continue
  const results = await Promise.allSettled([
    runWithTimeout("news_sentiment", () => runNewsAgent(ctx), 30_000),
    runWithTimeout("technical_analysis", () => runTechnicalAgent(ctx), 45_000),
    runWithTimeout("insider_institutional", () => runInsiderAgent(ctx), 45_000),
    runWithTimeout("social_retail", () => runSocialAgent(ctx), 30_000),
    runWithTimeout("congress_trading", () => runCongressAgent(ctx), 30_000),
    runWithTimeout("macro_economic", () => runMacroAgent(ctx), 20_000),
    runWithTimeout("geopolitical_events", () => runGeopoliticalAgent(ctx), 30_000),
  ]);

  // Collect summaries — use error placeholders for failed agents
  const summaries: AgentSummary[] = results.map((result, index) => {
    const names = ["news_sentiment", "technical_analysis", "insider_institutional", "social_retail", "congress_trading", "macro_economic", "geopolitical_events"];
    if (result.status === "fulfilled") {
      return result.value;
    }
    return {
      agentName: names[index]!,
      summary: `Agent unavailable: ${result.reason?.message || "timeout"}`,
      confidence: 0,
      stocksMentioned: [],
      timestamp: new Date(),
      durationMs: 0,
      toolCallsUsed: 0,
      error: result.reason?.message,
    };
  });

  // Log specialist results
  for (const s of summaries) {
    const status = s.error ? `FAILED (${s.error})` : `OK (${s.durationMs}ms, ${s.toolCallsUsed} tools)`;
    console.log(`[Orchestrator] ${s.agentName}: ${status}`);
  }

  const successfulAgents = summaries.filter(s => !s.error).length;
  console.log(`[Orchestrator] ${successfulAgents}/7 agents succeeded. Computing dashboard alerts...`);

  // Compute dashboard alerts for master agent context
  let alertsContext: string | null = null;
  try {
    const { getInsiderTransactions } = await import("../../services/secEdgar");
    const { getClusterBuys } = await import("../../services/congressTracker");
    const { getFearGreedIndex } = await import("../../services/fearGreedIndex");

    const watchlistTickers = ctx.portfolio?.positions?.map((p: any) => p.symbol) || [];
    const tickers = [...new Set(["NVDA", "AAPL", "TSLA", "MSFT", "META", "AMZN", ...watchlistTickers])];
    const alertLines: string[] = [];

    // Fear & Greed
    const fg = await getFearGreedIndex();
    if (fg && fg.value <= 25) alertLines.push(`- MACRO: Extreme Fear (${fg.value}) — contrarian buy zone`);
    else if (fg && fg.value >= 76) alertLines.push(`- MACRO: Extreme Greed (${fg.value}) — market top risk`);

    // Congress cluster buys
    const clusters = await getClusterBuys(30, 3);
    for (const c of clusters.slice(0, 3)) {
      alertLines.push(`- CONGRESS: ${c.buyers} members buying ${c.ticker} (${c.representatives.slice(0, 2).join(", ")})`);
    }

    // Insider clusters (scan top 6 tickers only to stay fast)
    for (const ticker of tickers.slice(0, 6)) {
      const txs = await getInsiderTransactions(ticker, 15);
      const buys = txs.filter(t => t.transactionType === "purchase");
      const sells = txs.filter(t => t.transactionType === "sale");
      const uniqueBuyers = [...new Set(buys.map(t => t.ownerName))];
      const uniqueSellers = [...new Set(sells.map(t => t.ownerName))];
      if (uniqueBuyers.length >= 2) alertLines.push(`- INSIDER: ${uniqueBuyers.length} insiders buying ${ticker} ($${Math.round(buys.reduce((s, t) => s + (t.totalValue || 0), 0)).toLocaleString()})`);
      else if (uniqueSellers.length >= 3) alertLines.push(`- INSIDER: ${uniqueSellers.length} insiders selling ${ticker} ($${Math.round(sells.reduce((s, t) => s + (t.totalValue || 0), 0)).toLocaleString()})`);
    }

    if (alertLines.length > 0) alertsContext = alertLines.join("\n");
    console.log(`[Orchestrator] ${alertLines.length} dashboard alerts computed`);
  } catch (err: any) {
    console.error("[Orchestrator] Dashboard alerts failed (non-blocking):", err.message);
  }

  console.log(`[Orchestrator] Running master agent...`);

  // Feed all summaries + predictions + alerts to master agent (dual-LLM consensus)
  const decision = await runMasterAgent(summaries, ctx.portfolio, ctx.agentMemory, ctx.predictions, alertsContext);

  decision.totalDurationMs = Date.now() - startTime;

  console.log(
    `[Orchestrator] ═══ Complete in ${decision.totalDurationMs}ms ═══ ` +
    `Trades: ${decision.trades_to_execute.length}, ` +
    `Close: ${decision.positions_to_close.length}, ` +
    `Consensus: ${decision.consensus.agreementRate}%`,
  );

  return decision;
}

/**
 * Run an agent with a timeout. Returns error summary if it exceeds the limit.
 */
async function runWithTimeout(
  name: string,
  fn: () => Promise<AgentSummary>,
  timeoutMs: number,
): Promise<AgentSummary> {
  return Promise.race([
    fn(),
    new Promise<AgentSummary>((_, reject) =>
      setTimeout(() => reject(new Error(`${name} timed out after ${timeoutMs}ms`)), timeoutMs),
    ),
  ]);
}

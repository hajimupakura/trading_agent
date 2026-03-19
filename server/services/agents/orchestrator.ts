import type { AgentContext, AgentSummary, MasterDecision } from "./types";
import { runNewsAgent } from "./newsAgent";
import { runTechnicalAgent } from "./technicalAgent";
import { runInsiderAgent } from "./insiderAgent";
import { runSocialAgent } from "./socialAgent";
import { runCongressAgent } from "./congressAgent";
import { runMacroAgent } from "./macroAgent";
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

  console.log("[Orchestrator] ═══ Starting 6 specialist agents in parallel ═══");

  // Run ALL specialists in parallel — if one fails, others continue
  const results = await Promise.allSettled([
    runWithTimeout("news_sentiment", () => runNewsAgent(ctx), 30_000),
    runWithTimeout("technical_analysis", () => runTechnicalAgent(ctx), 45_000),
    runWithTimeout("insider_institutional", () => runInsiderAgent(ctx), 45_000),
    runWithTimeout("social_retail", () => runSocialAgent(ctx), 30_000),
    runWithTimeout("congress_trading", () => runCongressAgent(ctx), 30_000),
    runWithTimeout("macro_economic", () => runMacroAgent(ctx), 20_000),
  ]);

  // Collect summaries — use error placeholders for failed agents
  const summaries: AgentSummary[] = results.map((result, index) => {
    const names = ["news_sentiment", "technical_analysis", "insider_institutional", "social_retail", "congress_trading", "macro_economic"];
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
  console.log(`[Orchestrator] ${successfulAgents}/6 agents succeeded. Running master agent...`);

  // Feed all summaries to master agent (dual-LLM consensus)
  const decision = await runMasterAgent(summaries, ctx.portfolio, ctx.agentMemory);

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

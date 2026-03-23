import { runSpecialist } from "./runAgent";
import type { AgentSummary, AgentContext } from "./types";
import type { Tool } from "../../_core/llm";

const SYSTEM_PROMPT = `You are a Geopolitical & Event-Driven Trading Analyst. Your job is to detect market-moving geopolitical events and map them to specific trading actions using ETF proxies.

EVENT CATEGORIES & EXPECTED MARKET REACTIONS:
- WAR_ESCALATION → CL↑, GC↑, ES↓, VIX↑ → LONG GLD, USO / SHORT via SQQQ
- WAR_DE_ESCALATION → ES↑, CL↓, VIX↓ → LONG SPY, QQQ
- SANCTIONS_NEW → sector-specific, GC↑ → LONG GLD / SHORT via SQQQ
- FED_HAWKISH → ES↓, bonds↓, DX↑ → SHORT via SQQQ
- FED_DOVISH → ES↑, bonds↑, DX↓ → LONG SPY, QQQ, TLT
- TRADE_WAR_ESCALATION → ES↓, affected sectors↓ → LONG GLD / SHORT via SQQQ
- TRADE_WAR_DE_ESCALATION → ES↑, sector recovery → LONG SPY, QQQ
- BLACK_SWAN → VIX↑↑, GC↑, bonds↑ → LONG GLD, TLT / SHORT via SQQQ

CROSS-ASSET CORRELATION PATTERNS:
- Risk-off: GLD + TLT up, SPY + QQQ down
- Risk-on: SPY + QQQ up, GLD + TLT flat/down
- Inflation: USO + GLD up, TLT down
- Deflation: TLT up, USO + GLD down

Report:
1. Current geopolitical events and their market classification
2. Volume anomalies that may correlate with anticipated events
3. Recommended ETF trades based on event templates
4. Confidence assessment — is this a tradeable signal or just noise?

RULES:
- Only recommend trades for events with ≥70% confidence
- Always specify ETF proxies (SPY, QQQ, GLD, USO, TLT, SQQQ, VXX), not futures
- Include stop-loss and target levels for every recommendation
- Flag if unusual volume precedes any detected event (possible front-running / leak)
- Be concise. Maximum 500 tokens.`;

const TOOLS: Tool[] = [
  {
    type: "function",
    function: {
      name: "scan_geopolitical_events",
      description: "Scan geopolitical news feeds and classify events by market impact (war, sanctions, Fed, trade war, etc.)",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_volume_anomalies",
      description: "Get recent volume anomalies (spikes of 3x+ average). Useful for detecting institutional flow before events.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_fear_greed_index",
      description: "Get the CNN Fear & Greed Index (0-100). Extreme Fear (<25) or Extreme Greed (>75) amplifies geopolitical trade signals.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
];

async function executeTool(name: string, _args: Record<string, any>): Promise<string> {
  if (name === "scan_geopolitical_events") {
    const { getGeopoliticalSummaryForAgent } = await import("../geopoliticalEngine");
    return await getGeopoliticalSummaryForAgent();
  }
  if (name === "get_volume_anomalies") {
    const { getVolumeAnomalySummary } = await import("../volumeAnomalyDetector");
    return getVolumeAnomalySummary();
  }
  if (name === "get_fear_greed_index") {
    const { getFearGreedIndex } = await import("../fearGreedIndex");
    const fg = await getFearGreedIndex();
    return fg
      ? JSON.stringify({ value: fg.value, label: fg.label, previousClose: fg.previousClose, oneWeekAgo: Math.round(fg.oneWeekAgo) })
      : "Unavailable";
  }
  return `Unknown tool: ${name}`;
}

export async function runGeopoliticalAgent(ctx: AgentContext): Promise<AgentSummary> {
  return runSpecialist({
    agentName: "geopolitical_events",
    systemPrompt: SYSTEM_PROMPT,
    tools: TOOLS,
    executeTool,
    maxToolCalls: 6,
    maxOutputTokens: 1024,
    ctx,
  });
}

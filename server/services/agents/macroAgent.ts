import { runSpecialist } from "./runAgent";
import type { AgentSummary, AgentContext } from "./types";
import type { Tool } from "../../_core/llm";

const SYSTEM_PROMPT = `You are a Macro & Economic Analyst. Your ONLY job is to assess the macroeconomic environment.

Report:
1. Growth: Latest GDP growth rate and trend
2. Inflation: Latest CPI reading, accelerating or decelerating
3. Employment: Unemployment rate
4. Monetary policy: Current Fed funds rate, direction of next move
5. Yield curve: 10Y Treasury yield — is it signaling risk-on or risk-off?
6. Overall assessment: Is the macro environment favorable for equities? Recession risk?

RULES:
- Do NOT make trading recommendations.
- Focus on DATA, not opinions. Quote actual numbers from your tools.
- If data is unavailable, say so rather than guessing.
- Be concise. Maximum 400 tokens.`;

const TOOLS: Tool[] = [
  {
    type: "function",
    function: {
      name: "get_economic_indicators",
      description: "Get latest economic indicators from FRED: GDP, CPI, unemployment rate, Fed funds rate, 10Y Treasury yield.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
];

async function executeTool(name: string, _args: Record<string, any>): Promise<string> {
  if (name === "get_economic_indicators") {
    const { getEconomicIndicators } = await import("../fredEconomic");
    const data = await getEconomicIndicators();
    return JSON.stringify({
      gdp: data.gdp ? `${data.gdp.value} (${data.gdp.date})` : "unavailable",
      cpi: data.cpi ? `${data.cpi.value} (${data.cpi.date})` : "unavailable",
      unemployment: data.unemployment ? `${data.unemployment.value}% (${data.unemployment.date})` : "unavailable",
      fedFundsRate: data.fedFundsRate ? `${data.fedFundsRate.value}% (${data.fedFundsRate.date})` : "unavailable",
      treasury10y: data.treasury10y ? `${data.treasury10y.value}% (${data.treasury10y.date})` : "unavailable",
    });
  }
  return JSON.stringify({ error: "Unknown tool" });
}

export async function runMacroAgent(ctx: AgentContext): Promise<AgentSummary> {
  return runSpecialist(
    { name: "macro_economic", systemPrompt: SYSTEM_PROMPT, tools: TOOLS, maxToolCalls: 2, maxOutputTokens: 1024, timeoutMs: 20_000 },
    "Assess the current macroeconomic environment using the latest economic indicators.",
    executeTool,
  );
}

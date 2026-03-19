import { invokeLLM, type Message, type Tool } from "../../_core/llm";
import type { AgentSummary, SpecialistConfig } from "./types";

/**
 * Generic specialist agent runner.
 * Handles both simple (no tools) and agentic (tool-calling loop) agents.
 */

type ToolExecutor = (name: string, args: Record<string, any>) => Promise<string>;

export async function runSpecialist(
  config: SpecialistConfig,
  userMessage: string,
  executeTool?: ToolExecutor,
): Promise<AgentSummary> {
  const startTime = Date.now();
  const messages: Message[] = [
    { role: "system", content: config.systemPrompt },
    { role: "user", content: userMessage },
  ];
  let toolCallCount = 0;

  try {
    // No tools → single LLM call
    if (config.tools.length === 0 || !executeTool) {
      const response = await invokeLLM({ messages, maxTokens: config.maxOutputTokens });
      const content = extractContent(response);
      return success(config.name, content, Date.now() - startTime, 0);
    }

    // Agentic tool-calling loop
    for (let i = 0; i < config.maxToolCalls + 2; i++) {
      const response = await invokeLLM({
        messages,
        tools: config.tools,
        toolChoice: "auto",
        maxTokens: config.maxOutputTokens,
      });

      const choice = response.choices[0];
      if (!choice) break;

      const msg = choice.message;

      // No tool calls → agent is done
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        const content = typeof msg.content === "string" ? msg.content : "";
        return success(config.name, content, Date.now() - startTime, toolCallCount);
      }

      // Add assistant message with tool calls to history
      messages.push({
        role: "assistant",
        content: typeof msg.content === "string" ? msg.content : "",
      });

      // Execute each tool call
      for (const tc of msg.tool_calls) {
        const args = JSON.parse(tc.function.arguments || "{}");
        const result = await executeTool(tc.function.name, args);
        toolCallCount++;

        messages.push({
          role: "tool",
          content: result,
          tool_call_id: tc.id,
        });

        if (toolCallCount >= config.maxToolCalls) break;
      }

      if (toolCallCount >= config.maxToolCalls) {
        // Force a final response without tools
        const final = await invokeLLM({ messages, maxTokens: config.maxOutputTokens });
        const content = extractContent(final);
        return success(config.name, content, Date.now() - startTime, toolCallCount);
      }
    }

    return success(config.name, "Agent completed without output", Date.now() - startTime, toolCallCount);
  } catch (error: any) {
    return {
      agentName: config.name,
      summary: `Agent failed: ${error.message}`,
      confidence: 0,
      stocksMentioned: [],
      timestamp: new Date(),
      durationMs: Date.now() - startTime,
      toolCallsUsed: toolCallCount,
      error: error.message,
    };
  }
}

function extractContent(response: any): string {
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c: any) => (typeof c === "string" ? c : c.text || "")).join("\n");
  }
  return "";
}

function success(name: string, summary: string, durationMs: number, toolCalls: number): AgentSummary {
  return {
    agentName: name,
    summary,
    confidence: 70,
    stocksMentioned: extractTickers(summary),
    timestamp: new Date(),
    durationMs,
    toolCallsUsed: toolCalls,
  };
}

function extractTickers(text: string): string[] {
  const matches = text.match(/\b[A-Z]{2,5}\b/g) || [];
  const common = new Set(["THE", "AND", "FOR", "ARE", "NOT", "ALL", "CAN", "WAS", "HAS", "BUT", "GDP", "CPI", "RSI", "MACD", "SMA", "ETF", "SEC", "FDA", "IPO", "CEO"]);
  return Array.from(new Set(matches.filter(m => !common.has(m))));
}

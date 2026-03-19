import type { Tool } from "../../_core/llm";

/** What every specialist agent returns */
export interface AgentSummary {
  agentName: string;
  summary: string;
  confidence: number;       // 0-100
  stocksMentioned: string[];
  timestamp: Date;
  durationMs: number;
  toolCallsUsed: number;
  error?: string;
}

/** Shared context passed to all agents */
export interface AgentContext {
  predictions: any[];
  portfolio: any;
  watchlistTickers: string[];
  recentNews: any[];
  agentMemory: string | null;
}

/** Master agent output */
export interface MasterDecision {
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
  consensus: {
    agreed: boolean;
    agreementRate: number;
    modelsUsed: string[];
  };
  agentSummaries: AgentSummary[];
  totalDurationMs: number;
  toolCallsUsed: number;
  toolsInvoked: string[];
}

/** Config for a specialist agent */
export interface SpecialistConfig {
  name: string;
  systemPrompt: string;
  tools: Tool[];
  maxToolCalls: number;
  maxOutputTokens: number;
  timeoutMs: number;
}

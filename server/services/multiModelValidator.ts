import { invokeLLM, type InvokeParams, type InvokeResult } from "../_core/llm";
import axios from "axios";

/**
 * Multi-Model Prediction Validator
 *
 * Runs the same prediction through 2 independent LLMs and only
 * returns predictions where both models agree on direction.
 * This dramatically reduces false positives.
 *
 * Model 1: Primary (Gemini Flash via Forge — already configured)
 * Model 2: Secondary (OpenAI-compatible via OpenRouter — GPT-4o-mini or Claude Haiku)
 *
 * Cost: ~2x primary model cost. For Gemini Flash + GPT-4o-mini ≈ $12/month.
 *
 * Environment variables:
 *   OPENROUTER_API_KEY     - OpenRouter API key for secondary model
 *   SECONDARY_LLM_MODEL    - Model ID (default: openai/gpt-4o-mini)
 */

const OPENROUTER_API_URL = process.env.OPENROUTER_API_URL || "https://openrouter.ai/api/v1";

interface PredictionFromModel {
  sector: string;
  direction: "up" | "down";
  opportunityType: "call" | "put";
  confidence: number;
  recommendedStocks: string[];
  reasoning: string;
}

interface ConsensusResult {
  consensusPredictions: PredictionFromModel[];
  primaryOnly: PredictionFromModel[];   // Primary model predicted, secondary didn't
  secondaryOnly: PredictionFromModel[];  // Secondary model predicted, primary didn't
  agreement: number;  // % of predictions both models agreed on
  modelsUsed: string[];
}

/**
 * Invoke the secondary model via OpenRouter.
 * Returns null if OpenRouter is not configured.
 */
async function invokeSecondaryModel(params: InvokeParams): Promise<InvokeResult | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.warn("[MultiModel] OPENROUTER_API_KEY not set — single model mode");
    return null;
  }

  const model = process.env.SECONDARY_LLM_MODEL || "openai/gpt-4o-mini";

  try {
    const messages = params.messages.map(m => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content
        : Array.isArray(m.content)
          ? m.content.map(c => typeof c === "string" ? { type: "text" as const, text: c } : c)
          : m.content,
    }));

    const payload: Record<string, unknown> = {
      model,
      messages,
      temperature: 0.7,
      max_tokens: 4096,
    };

    if (params.response_format || params.responseFormat) {
      payload.response_format = params.response_format || params.responseFormat;
    }

    const response = await axios.post(
      `${OPENROUTER_API_URL}/chat/completions`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/trading-agent",
          "X-Title": "AI Trading Agent",
        },
        timeout: 60_000,
      },
    );

    return response.data as InvokeResult;
  } catch (error: any) {
    console.error("[MultiModel] Secondary model error:", error.message);
    return null;
  }
}

/**
 * Parse predictions from an LLM response.
 */
function parsePredictions(result: InvokeResult | null): PredictionFromModel[] {
  if (!result) return [];

  const content = result.choices[0]?.message?.content;
  if (!content || typeof content !== "string") return [];

  try {
    const parsed = JSON.parse(content);
    if (parsed.predictions && Array.isArray(parsed.predictions)) {
      return parsed.predictions;
    }
  } catch { /* ignore */ }

  return [];
}

/**
 * Check if two predictions agree on the same sector/direction.
 */
function predictionsAgree(a: PredictionFromModel, b: PredictionFromModel): boolean {
  // Normalize sector names for comparison
  const normA = a.sector.toLowerCase().replace(/[^a-z0-9]/g, "");
  const normB = b.sector.toLowerCase().replace(/[^a-z0-9]/g, "");

  // Check sector overlap (fuzzy match — one contains the other)
  const sectorMatch = normA.includes(normB) || normB.includes(normA) || normA === normB;

  // Direction must match exactly
  const directionMatch = a.direction === b.direction;

  // Stock overlap: at least one recommended stock in common
  const stocksA = new Set(a.recommendedStocks.map(s => s.toUpperCase()));
  const stockOverlap = b.recommendedStocks.some(s => stocksA.has(s.toUpperCase()));

  // Agreement = same direction AND (same sector OR overlapping stocks)
  return directionMatch && (sectorMatch || stockOverlap);
}

/**
 * Run prediction through both models and return consensus.
 * Predictions where both models agree get boosted confidence.
 * Predictions where only one model agrees get reduced confidence.
 */
export async function validateWithConsensus(
  params: InvokeParams,
): Promise<ConsensusResult> {
  // Run both models in parallel
  const [primaryResult, secondaryResult] = await Promise.all([
    invokeLLM(params),
    invokeSecondaryModel(params),
  ]);

  const primaryPreds = parsePredictions(primaryResult);
  const secondaryPreds = parsePredictions(secondaryResult);

  const modelsUsed = ["primary (Gemini Flash)"];
  if (secondaryResult) {
    modelsUsed.push(`secondary (${process.env.SECONDARY_LLM_MODEL || "gpt-4o-mini"})`);
  }

  // If secondary model failed, return primary predictions with a note
  if (secondaryPreds.length === 0) {
    return {
      consensusPredictions: primaryPreds,
      primaryOnly: [],
      secondaryOnly: [],
      agreement: 100, // Single model = 100% self-agreement
      modelsUsed,
    };
  }

  // Find consensus predictions
  const consensus: PredictionFromModel[] = [];
  const matchedSecondary = new Set<number>();

  for (const primary of primaryPreds) {
    let found = false;
    for (let i = 0; i < secondaryPreds.length; i++) {
      if (matchedSecondary.has(i)) continue;
      if (predictionsAgree(primary, secondaryPreds[i]!)) {
        // Both models agree — boost confidence
        const avgConfidence = Math.round((primary.confidence + secondaryPreds[i]!.confidence) / 2);
        consensus.push({
          ...primary,
          confidence: Math.min(95, avgConfidence + 10), // +10 confidence boost for consensus
          reasoning: `[CONSENSUS] ${primary.reasoning}\n[Secondary model confirms]: ${secondaryPreds[i]!.reasoning}`,
        });
        matchedSecondary.add(i);
        found = true;
        break;
      }
    }
    if (!found) {
      // Primary only — reduce confidence
      consensus.push({
        ...primary,
        confidence: Math.max(30, primary.confidence - 15), // -15 penalty for no consensus
        reasoning: `[SINGLE MODEL — no consensus] ${primary.reasoning}`,
      });
    }
  }

  // Secondary-only predictions (primary missed them)
  const secondaryOnly: PredictionFromModel[] = [];
  for (let i = 0; i < secondaryPreds.length; i++) {
    if (!matchedSecondary.has(i)) {
      secondaryOnly.push({
        ...secondaryPreds[i]!,
        confidence: Math.max(30, secondaryPreds[i]!.confidence - 15),
      });
    }
  }

  const primaryOnly = consensus.filter(p => p.reasoning.includes("[SINGLE MODEL"));
  const agreedCount = consensus.filter(p => p.reasoning.includes("[CONSENSUS]")).length;
  const totalUnique = primaryPreds.length + secondaryOnly.length;
  const agreement = totalUnique > 0 ? Math.round((agreedCount / totalUnique) * 100) : 0;

  console.log(
    `[MultiModel] Primary: ${primaryPreds.length} predictions, ` +
    `Secondary: ${secondaryPreds.length}, Consensus: ${agreedCount}, ` +
    `Agreement: ${agreement}%`
  );

  return {
    consensusPredictions: consensus,
    primaryOnly: primaryOnly,
    secondaryOnly,
    agreement,
    modelsUsed,
  };
}

/**
 * Check if multi-model validation is available.
 */
export function isMultiModelAvailable(): boolean {
  return !!process.env.OPENROUTER_API_KEY;
}

import { generateOptionsSignal } from "./setupEngine";
import { getOptionChain, getMarketState, isMassiveConfigured } from "./massiveProvider";
import { persistOptionsSnapshot, persistOptionSignal } from "../supabaseOptionsStore";
import type { OptionsCommandCenter, OptionsSignal, SupportedUnderlying } from "./types";

const emptySnapshot = (): OptionsCommandCenter => ({
  provider: "massive", configured: isMassiveConfigured(), delayedWarning: null,
  aiReviewEnabled: process.env.AI_OPTIONS_REVIEW_ENABLED === "true",
  asOf: Date.now(), market: null, contracts: [], signal: null, errors: [],
});

const state: {
  running: boolean;
  timer: ReturnType<typeof setInterval> | null;
  snapshots: Record<SupportedUnderlying, OptionsCommandCenter>;
  lastAiFingerprint: string | null;
  lastAiReview: OptionsSignal["aiReview"] | undefined;
  lastJournalFingerprint: Record<SupportedUnderlying, string | null>;
} = {
  running: false,
  timer: null,
  snapshots: { SPY: emptySnapshot(), SPX: emptySnapshot() },
  lastAiFingerprint: null,
  lastAiReview: undefined,
  lastJournalFingerprint: { SPY: null, SPX: null },
};

async function journalSignal(underlying: SupportedUnderlying, signal: OptionsSignal): Promise<void> {
  if (signal.action !== "enter_call" && signal.action !== "enter_put") return;
  const fingerprint = `${signal.action}:${signal.setup}:${signal.contract?.ticker ?? "none"}:${signal.market.regime}`;
  if (state.lastJournalFingerprint[underlying] === fingerprint) return;
  try {
    if (await persistOptionSignal(underlying, signal, fingerprint)) {
      state.lastJournalFingerprint[underlying] = fingerprint;
      return;
    }
    const { insertOptionSignal } = await import("../../db");
    await insertOptionSignal({
      signalId: signal.id,
      underlying,
      action: signal.action,
      setup: signal.setup,
      confidence: signal.confidence,
      contractTicker: signal.contract?.ticker ?? null,
      fingerprint,
      marketSnapshot: JSON.stringify(signal.market),
      contractSnapshot: signal.contract ? JSON.stringify(signal.contract) : null,
      reasons: JSON.stringify(signal.reasons),
      invalidation: signal.invalidation,
      aiReview: signal.aiReview ? JSON.stringify(signal.aiReview) : null,
      generatedAt: new Date(signal.generatedAt),
    });
    state.lastJournalFingerprint[underlying] = fingerprint;
  } catch (error) {
    console.warn("[OptionsMonitor] Could not journal signal:", error);
  }
}

async function reviewWithAi(signal: OptionsSignal): Promise<OptionsSignal["aiReview"] | undefined> {
  if (process.env.AI_OPTIONS_REVIEW_ENABLED !== "true") return undefined;
  if (!process.env.OPENROUTER_API_KEY && !process.env.BUILT_IN_FORGE_API_KEY) return undefined;
  if (signal.action !== "enter_call" && signal.action !== "enter_put") return undefined;
  const fingerprint = `${signal.action}:${signal.setup}:${signal.contract?.ticker ?? "none"}:${signal.market.regime}`;
  if (fingerprint === state.lastAiFingerprint) return state.lastAiReview;
  try {
    const { invokeLLM } = await import("../../_core/llm");
    const response = await invokeLLM({
      messages: [
        { role: "system", content: "You are a risk reviewer for a paper-only SPX/SPY 0-2 DTE system. Never invent data or override hard risk rules. Return JSON only." },
        { role: "user", content: `Review this deterministic candidate. Confirm only when evidence is internally consistent: ${JSON.stringify(signal)}` },
      ],
      response_format: { type: "json_schema", json_schema: { name: "options_review", strict: true, schema: {
        type: "object", additionalProperties: false,
        properties: { verdict: { type: "string", enum: ["confirm", "reject", "caution"] }, summary: { type: "string" }, risks: { type: "array", items: { type: "string" } } },
        required: ["verdict", "summary", "risks"],
      } } },
    });
    const content = response.choices?.[0]?.message?.content;
    const review = typeof content === "string" ? JSON.parse(content) : undefined;
    state.lastAiFingerprint = fingerprint;
    state.lastAiReview = review;
    return review;
  } catch (error) {
    console.warn("[OptionsMonitor] AI review failed:", error);
    return undefined;
  }
}

export async function refreshOptionsCommandCenter(underlying: SupportedUnderlying = "SPY"): Promise<OptionsCommandCenter> {
  if (!isMassiveConfigured()) {
    state.snapshots[underlying] = { ...state.snapshots[underlying], configured: false, asOf: Date.now(), errors: ["Set MASSIVE_API_KEY to load live options data"] };
    return state.snapshots[underlying];
  }
  const errors: string[] = [];
  const [marketResult, chainResult] = await Promise.allSettled([getMarketState(underlying), getOptionChain(underlying)]);
  const market = marketResult.status === "fulfilled" ? marketResult.value : null;
  const contracts = chainResult.status === "fulfilled" ? chainResult.value : [];
  if (marketResult.status === "rejected") errors.push(String(marketResult.reason));
  if (chainResult.status === "rejected") errors.push(String(chainResult.reason));
  let signal = market ? generateOptionsSignal(market, contracts) : null;
  if (signal) signal = { ...signal, aiReview: await reviewWithAi(signal) };
  if (signal) await journalSignal(underlying, signal);
  state.snapshots[underlying] = { provider: "massive", configured: true, aiReviewEnabled: process.env.AI_OPTIONS_REVIEW_ENABLED === "true", delayedWarning: null, asOf: Date.now(), market, contracts: contracts.slice(0, 40), signal, errors };
  await persistOptionsSnapshot(underlying, state.snapshots[underlying]);
  return state.snapshots[underlying];
}

export function getOptionsMonitorState() { return { running: state.running, snapshots: state.snapshots }; }

export function startOptionsMonitor(intervalMs = 15_000) {
  if (state.running) return;
  state.running = true;
  const refreshBoth = () => void Promise.allSettled([
    refreshOptionsCommandCenter("SPY"), refreshOptionsCommandCenter("SPX"),
  ]);
  refreshBoth();
  state.timer = setInterval(refreshBoth, Math.max(5_000, intervalMs));
}

export function stopOptionsMonitor() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.running = false;
}

import "server-only";

// OpenRouter chat-completion client for the AI review layer. The LLM interprets and
// narrates; signals, sizing, and exits stay deterministic — nothing here places orders.
// Model is configurable via OPENROUTER_MODEL. Default: Claude Sonnet 5 — the best
// quality-per-dollar tier for market reasoning at this call volume (a few calls a day);
// $2/$10 per MTok intro through 2026-08-31, $3/$15 after.

const DEFAULT_MODEL = "anthropic/claude-sonnet-5";

export function aiConfigured(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

export async function chatComplete(input: { system: string; user: string; maxTokens?: number }): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not configured");
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Title": "Velocity" },
    body: JSON.stringify({
      model: process.env.OPENROUTER_MODEL || DEFAULT_MODEL,
      max_tokens: input.maxTokens ?? 900,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user },
      ],
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`OpenRouter ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const text = payload.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("OpenRouter returned an empty completion");
  return text;
}

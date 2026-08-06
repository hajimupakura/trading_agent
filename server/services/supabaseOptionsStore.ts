import type { OptionsCommandCenter, OptionsSignal, SupportedUnderlying } from "./options/types";

function configuration(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url: url.replace(/\/$/, ""), key } : null;
}

async function request(path: string, init: RequestInit): Promise<boolean> {
  const config = configuration();
  if (!config) return false;
  const response = await fetch(`${config.url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: config.key,
      Authorization: `Bearer ${config.key}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal,resolution=merge-duplicates",
      ...init.headers,
    },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Supabase persistence ${response.status}: ${await response.text()}`);
  return true;
}

export async function persistOptionsSnapshot(underlying: SupportedUnderlying, snapshot: OptionsCommandCenter): Promise<boolean> {
  try {
    return await request("options_monitor_snapshots?on_conflict=underlying", {
      method: "POST",
      body: JSON.stringify({ underlying, payload: snapshot, updated_at: new Date(snapshot.asOf).toISOString() }),
    });
  } catch (error) {
    console.warn("[SupabaseOptionsStore] Snapshot persistence failed:", error);
    return false;
  }
}

export async function persistOptionSignal(underlying: SupportedUnderlying, signal: OptionsSignal, fingerprint: string): Promise<boolean> {
  try {
    return await request("option_signals?on_conflict=signal_id", {
      method: "POST",
      body: JSON.stringify({
        signal_id: signal.id, underlying, action: signal.action, setup: signal.setup,
        confidence: signal.confidence, contract_ticker: signal.contract?.ticker ?? null,
        fingerprint, market_snapshot: signal.market, contract_snapshot: signal.contract,
        reasons: signal.reasons, invalidation: signal.invalidation, ai_review: signal.aiReview ?? null,
        generated_at: new Date(signal.generatedAt).toISOString(),
      }),
    });
  } catch (error) {
    console.warn("[SupabaseOptionsStore] Signal persistence failed:", error);
    return false;
  }
}

import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPaperEquityHistory } from "./paper";

// GROUND-TRUTH EQUITY SNAPSHOT (2026-08-27): the paper P&L journal and the actual
// Alpaca account equity diverged with no alarm — replaced sell orders lose their
// fill journals, errored tickets can place orders that never get journaled. The
// account's own equity curve is the only number that can't lie. Persist it (plus
// a month of daily history) so audits reconcile against broker truth, not our
// own bookkeeping.
export async function runPaperEquitySnapshot(): Promise<{ ok: boolean; error?: string }> {
  try {
    const { account, history } = await getPaperEquityHistory();
    const days = (history.timestamp ?? []).map((t, i) => ({
      day: new Date(t * 1000).toISOString().slice(0, 10),
      equity: history.equity?.[i] ?? null,
      profitLoss: history.profit_loss?.[i] ?? null,
    }));
    const admin = createAdminClient();
    const { error } = await admin.from("broker_portfolio_snapshots").upsert({
      broker: "alpaca",
      payload: {
        equity: Number(account.equity),
        lastEquity: Number(account.last_equity),
        cash: Number(account.cash),
        dailyHistory: days,
      },
      updated_at: new Date().toISOString(),
    }, { onConflict: "broker" });
    if (error) throw new Error(`snapshot persist failed: ${error.message}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

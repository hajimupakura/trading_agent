import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { alpacaLatestOptionQuotes } from "./provider";
import type { CommandCenter, Signal } from "./types";

// SHADOW LEDGER (2026-11-19, user call): when the engine fires a qualified entry
// signal and the paper lane skips it (cooldown, caps, kill switch, risk gate), the
// miss is recorded with its entry prices and live-marked every cron tick until the
// contract expires. Born from the 11:55 AM SPX 7275P put that fired, was vetoed by
// the (since removed) morning-only rule, and ran ~+175% unbought. The ledger turns
// every future veto into a measured counterfactual instead of an anecdote.

// One shadow row per action+setup per hour — the engine re-fires every minute while
// a setup holds, and a row per minute would be noise, not a record.
const DEDUPE_MS = 60 * 60_000;

export async function recordShadowSkip(input: { signal: Signal; underlying: string; skipReason: string }): Promise<{ recorded: boolean }> {
  const { signal, underlying, skipReason } = input;
  const contract = signal.contract;
  if (!contract) return { recorded: false };
  const admin = createAdminClient();
  const { data: recent, error: recentError } = await admin.from("signal_shadow_ledger").select("id")
    .eq("underlying", underlying).eq("action", signal.action).eq("setup", signal.setup)
    .gte("created_at", new Date(Date.now() - DEDUPE_MS).toISOString()).limit(1).maybeSingle();
  if (recentError) throw new Error(`Shadow ledger dedupe check failed: ${recentError.message}`);
  if (recent) return { recorded: false };
  // Phase 3 stamp: the news state known at fire time rides the shadow record.
  const newsContext = await import("@/lib/news/market-news").then(module => module.newsContextFor(underlying)).catch(() => null);
  const { error } = await admin.from("signal_shadow_ledger").insert({
    signal_id: signal.id, underlying, action: signal.action, setup: signal.setup,
    contract_ticker: contract.ticker, expiration_date: contract.expirationDate ?? null,
    entry_ask: contract.ask, entry_bid: contract.bid, underlying_price: signal.market.price,
    skip_reason: skipReason, last_bid: contract.bid, peak_bid: contract.bid, news_context: newsContext,
  });
  if (error) throw new Error(`Shadow ledger insert failed: ${error.message}`);
  return { recorded: true };
}

// Live-marking: each tick, open rows get their contract's current bid from the fresh
// SPX snapshot or (any other underlying, and SPX tickers that left the snapshot) a
// direct Alpaca quote; peak_bid ratchets up. Rows whose expiry has passed in ET close.
export async function markShadowLedger(snapshot: CommandCenter | null): Promise<{ marked: number; closed: number }> {
  const admin = createAdminClient();
  const { data: open, error } = await admin.from("signal_shadow_ledger")
    .select("id, contract_ticker, expiration_date, peak_bid")
    .eq("status", "open").limit(200);
  if (error) throw new Error(`Shadow ledger read failed: ${error.message}`);
  if (!open?.length) return { marked: 0, closed: 0 };
  const etToday = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
  const byTicker = new Map((snapshot?.contracts ?? []).map(contract => [contract.ticker, { bid: contract.bid }]));
  // A skipped contract that runs deep ITM (the big counterfactual winners) falls out
  // of the snapshot's ranked cut — quote those directly or the ledger under-reports
  // exactly the misses it exists to measure.
  const missing = open.filter(row => (row.expiration_date == null || String(row.expiration_date) >= etToday) && !byTicker.has(String(row.contract_ticker)));
  if (missing.length) {
    const direct = await alpacaLatestOptionQuotes(missing.map(row => String(row.contract_ticker))).catch(error => { console.error("shadow ledger direct quotes failed", error instanceof Error ? error.message : error); return new Map<string, { bid: number; ask: number }>(); });
    for (const [ticker, quote] of direct) byTicker.set(ticker, { bid: quote.bid });
  }
  let marked = 0, closed = 0;
  for (const row of open) {
    const expired = row.expiration_date != null && String(row.expiration_date) < etToday;
    if (expired) {
      const { error: closeError } = await admin.from("signal_shadow_ledger")
        .update({ status: "closed", closed_at: new Date().toISOString() }).eq("id", row.id);
      if (closeError) console.error("shadow ledger close failed", row.id, closeError.message);
      else closed += 1;
      continue;
    }
    const quote = byTicker.get(String(row.contract_ticker));
    if (!quote || !(quote.bid > 0)) continue;
    const peak = Math.max(Number(row.peak_bid ?? 0), quote.bid);
    // last_marked_at makes staleness observable: when a "now" number looks wrong
    // (2026-11-23 SPCX ITM put bidding under intrinsic), the mark's age settles
    // whether it's a stale quote or an honest illiquid bid.
    const { error: markError } = await admin.from("signal_shadow_ledger")
      .update({ last_bid: quote.bid, peak_bid: peak, last_marked_at: new Date().toISOString() }).eq("id", row.id);
    if (markError) console.error("shadow ledger mark failed", row.id, markError.message);
    else marked += 1;
  }
  return { marked, closed };
}

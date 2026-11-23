import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAlert } from "@/lib/alerts/server";
import type { CommandCenter, Contract } from "./types";

// VIOLENT-DAY SHADOW TRACKERS (user call, 2026-11-23) — audition, never trade.
// Three sessions produced three violent moves no setup class covers: the 11/20
// final-hour cascade, today's 109-pt gap-fade, today's 138-pt V-rip. The naive
// gap-fade rule LOSES over the 7 available up-gap days (-50 pts, 1-for-6), so
// neither setup is armed; instead every trigger records the trade it WOULD take
// into signal_shadow_ledger (real contract, live entry prices), where the existing
// marking machinery tracks bid/peak to expiry. Months of real observations, zero
// dollars at risk — the promotion decision becomes a data call, like the trend path.
//
//   gap_fade : open gaps >= |0.3%| vs prior close, and a close within the first 10
//              bars crosses back through the day's open (failed gap) — fade it.
//              Once per side per day.
//   cascade  : displacement — the last 5 bars move >= 2.5 ATR one way with RSI
//              pinned (<=18 / >=82): exactly the zone the anti-chase gates refuse.
//              45-min cooldown per side.

const etMinutesOf = (timestamp: number) => { const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(timestamp)); return Number(parts.find(part => part.type === "hour")?.value) * 60 + Number(parts.find(part => part.type === "minute")?.value); };
const etDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());

function pickContract(snapshot: CommandCenter, side: "call" | "put"): Contract | null {
  const fresh = (snapshot.contracts ?? []).filter(contract => contract.side === side && contract.ask > 0 && contract.ask <= 8
    && contract.quoteUpdatedAt != null && Date.now() - contract.quoteUpdatedAt < 10 * 60_000 && contract.dte <= 2);
  return fresh.filter(contract => contract.delta != null && Math.abs(contract.delta) >= 0.3)
    .sort((a, b) => Math.abs(Math.abs(a.delta!) - 0.45) - Math.abs(Math.abs(b.delta!) - 0.45))[0]
    ?? fresh.sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0))[0] ?? null;
}

async function record(input: { underlying: string; setup: "gap_fade" | "cascade"; side: "call" | "put"; snapshot: CommandCenter; note: string; dedupeMs: number }): Promise<boolean> {
  const admin = createAdminClient();
  const action = input.side === "call" ? "enter_call" : "enter_put";
  const { data: recent, error: dedupeError } = await admin.from("signal_shadow_ledger").select("id")
    .eq("underlying", input.underlying).eq("setup", input.setup).eq("action", action)
    .gte("created_at", new Date(Date.now() - input.dedupeMs).toISOString()).limit(1).maybeSingle();
  if (dedupeError || recent) return false; // fail closed on dedupe uncertainty — never spam rows
  const contract = pickContract(input.snapshot, input.side);
  if (!contract) return false;
  // Phase 3 stamp: violent-day auditions carry their news state too — these are the
  // fires where "was there a story" matters most.
  const newsContext = await import("@/lib/news/market-news").then(module => module.newsContextFor(input.underlying)).catch(() => null);
  const { error } = await admin.from("signal_shadow_ledger").insert({
    signal_id: `shadow-${input.setup}-${action}-${etDate()}-${Date.now() % 100000}`,
    underlying: input.underlying, action, setup: input.setup,
    contract_ticker: contract.ticker, expiration_date: contract.expirationDate ?? null,
    entry_ask: contract.ask, entry_bid: contract.bid, underlying_price: input.snapshot.market?.price ?? null,
    skip_reason: `violent-day shadow (NOT armed — auditioning): ${input.note}`,
    last_bid: contract.bid, peak_bid: contract.bid, news_context: newsContext,
  });
  if (error) { console.error("violent shadow insert failed", error.message); return false; }
  const { data: owner } = await admin.from("profiles").select("id").limit(1).maybeSingle();
  if (owner) await createAlert({
    userId: String(owner.id), eventKey: `shadow-violent-${input.setup}-${action}-${etDate()}-${Date.now() % 100000}`, severity: "info",
    title: `Shadow ${input.setup.replace("_", "-")}: would ${input.side === "put" ? "buy puts" : "buy calls"} on ${input.underlying}`,
    body: `${input.note}. Would take ${contract.ticker.replace("O:", "")} at $${contract.ask.toFixed(2)} ask — recorded to the shadow ledger (NOT traded; this setup is auditioning). Its live outcome accrues on the Signal Feed.`,
    metadata: { kind: "violent_shadow", setup: input.setup, action, contractTicker: contract.ticker },
  }).catch(() => undefined);
  return true;
}

export async function runViolentDayShadow(snapshot: CommandCenter | null): Promise<{ fired: string[] }> {
  const fired: string[] = [];
  const market = snapshot?.market;
  if (!snapshot || !market || market.bars.length < 2) return { fired };
  const bars = market.bars;
  const seriesStartsAtOpen = etMinutesOf(bars[0]!.timestamp) <= 575;
  const current = bars.at(-1)!;
  const currentMin = etMinutesOf(current.timestamp);
  if (currentMin >= 955) return { fired }; // nothing new inside the last minutes

  // --- gap_fade: needs the open and priorDay; window = first 10 bars.
  if (seriesStartsAtOpen && market.priorDay && bars.length >= 2 && bars.length <= 11) {
    const dayOpen = bars[0]!.open;
    const gapPct = (dayOpen / market.priorDay.close - 1) * 100;
    if (gapPct >= 0.3 && current.close < dayOpen
      && await record({ underlying: market.symbol, setup: "gap_fade", side: "put", snapshot, dedupeMs: 20 * 3_600_000, note: `gapped +${gapPct.toFixed(2)}% and a close fell back through the open (${dayOpen.toFixed(0)}) within ${bars.length - 1} min — failed up-gap` })) fired.push("gap_fade:put");
    if (gapPct <= -0.3 && current.close > dayOpen
      && await record({ underlying: market.symbol, setup: "gap_fade", side: "call", snapshot, dedupeMs: 20 * 3_600_000, note: `gapped ${gapPct.toFixed(2)}% and a close reclaimed the open (${dayOpen.toFixed(0)}) within ${bars.length - 1} min — failed down-gap` })) fired.push("gap_fade:call");
  }

  // --- cascade: 5-bar displacement >= 2.5 ATR with RSI pinned.
  if (bars.length >= 20) {
    const closes = bars.map(bar => bar.close);
    let atrSum = 0; for (let i = closes.length - 14; i < closes.length; i++) atrSum += Math.abs(closes[i]! - closes[i - 1]!);
    const atr = atrSum / 14;
    const displacement = current.close - closes[closes.length - 6]!;
    const rsi = market.technicals.rsi14;
    if (atr > 0 && rsi != null) {
      if (displacement <= -2.5 * atr && rsi <= 18
        && await record({ underlying: market.symbol, setup: "cascade", side: "put", snapshot, dedupeMs: 45 * 60_000, note: `cascade down: ${displacement.toFixed(1)} pts in 5 min (${(Math.abs(displacement) / atr).toFixed(1)} ATR), RSI ${rsi.toFixed(0)} — the zone the anti-chase gates refuse` })) fired.push("cascade:put");
      if (displacement >= 2.5 * atr && rsi >= 82
        && await record({ underlying: market.symbol, setup: "cascade", side: "call", snapshot, dedupeMs: 45 * 60_000, note: `cascade up: +${displacement.toFixed(1)} pts in 5 min (${(displacement / atr).toFixed(1)} ATR), RSI ${rsi.toFixed(0)} — the zone the anti-chase gates refuse` })) fired.push("cascade:call");
    }
  }
  return { fired };
}

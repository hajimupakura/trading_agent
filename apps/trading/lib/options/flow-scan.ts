import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAlert } from "@/lib/alerts/server";
import { recordFlowWatch } from "./flow-watch";
import type { Contract, Underlying } from "./types";

// Unusual options-flow detection over the chains the scanner already pulls.
// Deterministic v1 thresholds (no historical baseline yet):
//   - Contract flow: today's volume >= 1,500 contracts AND >= 3x open interest
//     AND premium traded >= $400k -> "fresh aggressive positioning".
//   - Chain skew: call/put volume ratio beyond 3:1 (or 1:3) on meaningful volume.
// Alerts are deduped per contract/underlying per day via event keys.

const CONTRACT_MIN_VOLUME = 1500;
const CONTRACT_VOL_OI_RATIO = 3;
const CONTRACT_MIN_PREMIUM = 400_000;
const SKEW_RATIO = 3;
const SKEW_MIN_TOTAL_VOLUME: Record<string, number> = { SPY: 100_000, SPX: 20_000 };
const SKEW_DEFAULT_MIN_VOLUME = 5_000;

const etDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());

async function ownerId(): Promise<string | null> {
  const { data } = await createAdminClient().from("profiles").select("id").limit(1).maybeSingle();
  return data?.id ?? null;
}

// What today's scans already wrote for this underlying. Volume is CUMULATIVE, so a
// contract that crosses the thresholds at 10:00 crosses them on every later tick —
// and each one used to cost two serial HTTP round-trips per refresh (an alerts insert
// answered 409-duplicate, then a flow_watches upsert that ignored the duplicate). By
// 11:15 on 2026-11-25 that was ~420 known contracts re-sent every minute: ~800
// sequential calls, 32-40s of the monitor tick's 60s budget, and on slow-database
// minutes the whole 60 (the tick died inside the refresh block, taking the blind-spot
// checks and the job heartbeat with it). Two indexed lookups replace all of that; only
// genuinely NEW contracts are written. A failed lookup returns empty sets, which is
// the old write-everything behavior — slower, never wrong.
async function alreadyRecorded(userId: string, underlying: string, today: string): Promise<{ alertKeys: Set<string>; watchTickers: Set<string> }> {
  const admin = createAdminClient();
  // `O:SPX%` deliberately covers both index roots (SPX monthlies and SPXW weeklies).
  // The created_at floor is only there to ride the (user_id, created_at) index; the
  // date suffix in the pattern is what scopes the keys to today.
  const [alerts, watches] = await Promise.all([
    admin.from("alerts").select("event_key").eq("user_id", userId).gte("created_at", new Date(Date.now() - 36 * 3_600_000).toISOString()).like("event_key", `flow-O:${underlying}%-${today}`).limit(5000),
    admin.from("flow_watches").select("contract_ticker").eq("flow_date", today).like("contract_ticker", `O:${underlying}%`).limit(5000),
  ]);
  if (alerts.error) console.error("flow scan known-alerts lookup failed", underlying, alerts.error.message);
  if (watches.error) console.error("flow scan known-watches lookup failed", underlying, watches.error.message);
  return {
    alertKeys: new Set((alerts.data ?? []).map(row => String(row.event_key))),
    watchTickers: new Set((watches.data ?? []).map(row => String(row.contract_ticker))),
  };
}

export async function scanUnusualFlow(underlying: Underlying, contracts: Contract[]): Promise<void> {
  if (!contracts.length) return;
  // RTH only (2026-11-20): overnight the chains still carry YESTERDAY'S volume while
  // the event-key date rolls at midnight, so every still-elevated contract re-alerted
  // as a fresh "unusual flow" at ~12:03 AM. Flow outside market hours is an echo.
  const clock = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map(part => [part.type, part.value]));
  const minutes = Number(clock.hour) * 60 + Number(clock.minute);
  if (["Sat", "Sun"].includes(String(clock.weekday)) || minutes < 570 || minutes > 975) return;
  const userId = await ownerId();
  if (!userId) return;
  const today = etDate();

  // Per-contract aggressive positioning (short-dated book only — long-dated OI is stale by design).
  const shortDated = contracts.filter(contract => contract.dte <= 7);
  const qualifies = (contract: Contract) => contract.volume >= CONTRACT_MIN_VOLUME && contract.volume >= CONTRACT_VOL_OI_RATIO * Math.max(contract.openInterest, 1) && contract.volume * contract.midpoint * 100 >= CONTRACT_MIN_PREMIUM;
  const known = shortDated.some(qualifies)
    ? await alreadyRecorded(userId, underlying, today).catch(error => { console.error("flow scan known-rows lookup failed", underlying, error); return { alertKeys: new Set<string>(), watchTickers: new Set<string>() }; })
    : { alertKeys: new Set<string>(), watchTickers: new Set<string>() };
  for (const contract of shortDated) {
    const premium = contract.volume * contract.midpoint * 100;
    if (qualifies(contract)) {
      const eventKey = `flow-${contract.ticker}-${today}`;
      if (!known.alertKeys.has(eventKey)) await createAlert({
        userId, eventKey, severity: "warning",
        title: `Unusual flow: ${underlying} ${contract.strike}${contract.side === "call" ? "C" : "P"} ${contract.expirationDate}`,
        body: `${contract.volume.toLocaleString()} contracts traded vs ${contract.openInterest.toLocaleString()} open interest (${(contract.volume / Math.max(contract.openInterest, 1)).toFixed(1)}x) — roughly $${(premium / 1_000_000).toFixed(1)}M in premium. Heavy fresh positioning in a ${contract.dte}DTE ${contract.side}. Flow is information, not instruction: check it against the engine's read before acting.`,
        metadata: { ticker: contract.ticker, volume: contract.volume, openInterest: contract.openInterest, premium, dte: contract.dte },
      }).catch(() => undefined);
      // Smart money tracker: every $500k+ print becomes a scored watch (flow-watch.ts).
      await recordFlowWatch({ ticker: contract.ticker, premium, side: contract.side, alreadyRecorded: known.watchTickers.has(contract.ticker) }).catch(() => undefined);
    }
  }

  // Chain-level call/put skew (short-dated volume only).
  const callVolume = shortDated.filter(contract => contract.side === "call").reduce((sum, contract) => sum + contract.volume, 0);
  const putVolume = shortDated.filter(contract => contract.side === "put").reduce((sum, contract) => sum + contract.volume, 0);
  const total = callVolume + putVolume;
  const minTotal = SKEW_MIN_TOTAL_VOLUME[underlying] ?? SKEW_DEFAULT_MIN_VOLUME;
  if (total >= minTotal && putVolume > 0 && callVolume > 0) {
    const ratio = callVolume / putVolume;
    if (ratio >= SKEW_RATIO || ratio <= 1 / SKEW_RATIO) {
      const bullish = ratio >= SKEW_RATIO;
      // Detailed report: the exact contracts driving the skew, by volume.
      const describe = (contract: Contract) => `${contract.expirationDate.slice(5)} ${contract.strike}${contract.side === "call" ? "C" : "P"}: ${contract.volume.toLocaleString()} vol / ${contract.openInterest.toLocaleString()} OI / ~$${((contract.volume * contract.midpoint * 100) / 1_000_000).toFixed(1)}M premium`;
      const topOf = (side: "call" | "put") => shortDated.filter(contract => contract.side === side).sort((a, b) => b.volume - a.volume).slice(0, 3);
      const topCalls = topOf("call"); const topPuts = topOf("put");
      const detail = shortDated.slice().sort((a, b) => b.volume - a.volume).slice(0, 15).map(contract => ({
        ticker: contract.ticker, side: contract.side, strike: contract.strike, expirationDate: contract.expirationDate,
        dte: contract.dte, volume: contract.volume, openInterest: contract.openInterest,
        premiumTraded: Math.round(contract.volume * contract.midpoint * 100),
        midpoint: contract.midpoint, delta: contract.delta, impliedVolatility: contract.impliedVolatility,
      }));
      await createAlert({
        userId, eventKey: `flow-skew-${underlying}-${bullish ? "call" : "put"}-${today}`, severity: "info",
        title: `${underlying} flow skew: ${bullish ? "calls" : "puts"} ${bullish ? ratio.toFixed(1) : (1 / ratio).toFixed(1)}x ${bullish ? "puts" : "calls"}`,
        body: `Short-dated ${underlying}: ${callVolume.toLocaleString()} call vol vs ${putVolume.toLocaleString()} put vol. Top calls — ${topCalls.map(describe).join(" · ") || "none"}. Top puts — ${topPuts.map(describe).join(" · ") || "none"}. Search any strike in the leaderboard and click the row for full detail and a trade ticket.`,
        metadata: { underlying, callVolume, putVolume, ratio, topContracts: detail },
      }).catch(() => undefined);
    }
  }
}

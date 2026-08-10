import type { ManagedPosition } from "./types.js";

export const EXIT_RULES = { stopLossPct:.30, trailActivationPct:.40, trailPct:.20, stretchActivationPct:1, stretchTrailPct:.15, noFollowThroughMs:10 * 60_000, followThroughPct:.10, mandatoryExitMinutes:15 * 60 + 10,
  // Swing positions: opened at/after 15:30 ET and deliberately held overnight. Next day they run
  // on stop/trail/invalidation only, until the standard 15:10 flat — which also guards expiry,
  // since a 1DTE swing expires at that day's close.
  swingOpenThresholdMinutes:15 * 60 + 30 } as const;

// SCALP mode v2 — REPLAY-CALIBRATED (41 reclaim days, 2026-05..08): the original
// fast-out envelope (2x target, 30-min box) averaged +0.5%/trade because the 2x
// never printed inside 30 minutes (0/41) and the box amputated every big winner
// (May 13 +204% became +8%). The standard patient exits on the SAME entries made
// +7.5%/trade. Scalp mode is therefore an ENTRY lane, not an exit style: burst
// stop/trail rules apply, minus the 10-minute follow-through test and underlying
// invalidation (a reclaim entry's thesis needs an hour, not ten minutes).

export type ExitReason = "mandatory_time_exit"|"premium_stop"|"underlying_invalidation"|"trailing_stop"|"no_follow_through"|"scalp_target"|"scalp_time_box";
export function easternClock(now:Date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone:"America/New_York", weekday:"short", year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", hourCycle:"h23" }).formatToParts(now).map(part => [part.type, part.value]));
  return { weekday:parts.weekday, dateKey:`${parts.year}-${parts.month}-${parts.day}`, minutes:Number(parts.hour) * 60 + Number(parts.minute) };
}
export function evaluateExit(input:{ position:ManagedPosition; bid:number; underlyingPrice:number|null; longDated?:boolean; now?:Date }):ExitReason|null {
  const now = input.now ?? new Date(); const { position, bid, underlyingPrice } = input; const clock = easternClock(now);
  const openedClock = easternClock(new Date(position.openedAt));
  const heldOvernight = openedClock.dateKey < clock.dateKey;
  if (position.exitMode === "scalp") {
    // The 15:10 flat and overnight guards still apply (a worker outage must never
    // leave a 0DTE position unguarded into the close).
    if (heldOvernight && !["Sat","Sun"].includes(clock.weekday) && clock.minutes >= 570) return "mandatory_time_exit";
    if (clock.minutes >= EXIT_RULES.mandatoryExitMinutes) return "mandatory_time_exit";
    if (bid <= position.entryPrice * (1 - EXIT_RULES.stopLossPct)) return "premium_stop";
    const scalpGain = position.peakBid / position.entryPrice - 1;
    const scalpTrail = scalpGain >= EXIT_RULES.stretchActivationPct ? EXIT_RULES.stretchTrailPct : scalpGain >= EXIT_RULES.trailActivationPct ? EXIT_RULES.trailPct : null;
    if (scalpTrail != null && bid <= position.peakBid * (1 - scalpTrail)) return "trailing_stop";
    return null;
  }
  // A swing position is one deliberately opened in the late-day window; it is exempt from the
  // same-day 15:10 flat, held overnight, and force-sold by 10:30 the next morning instead of 09:30.
  const isSwing = openedClock.minutes >= EXIT_RULES.swingOpenThresholdMinutes;
  // Long-dated positions (>2 DTE, typically manual buys) are position trades, not scalps:
  // only the stop, the trailing stops, and (when context exists) invalidation apply.
  // The 15:10 flat still fires once the contract itself is inside the 2-DTE window.
  const longDated = input.longDated === true;
  const weekday = !["Sat","Sun"].includes(clock.weekday);
  if (!longDated && weekday && heldOvernight && clock.minutes >= (isSwing ? EXIT_RULES.mandatoryExitMinutes : 570)) return "mandatory_time_exit";
  if (!longDated && weekday && !heldOvernight && !isSwing && clock.minutes >= EXIT_RULES.mandatoryExitMinutes) return "mandatory_time_exit";
  if (bid <= position.entryPrice * (1 - EXIT_RULES.stopLossPct)) return "premium_stop";
  if (underlyingPrice != null && (position.side === "call" ? underlyingPrice <= position.market.openingRangeHigh : underlyingPrice >= position.market.openingRangeLow)) return "underlying_invalidation";
  const gain = position.peakBid / position.entryPrice - 1;
  const trail = gain >= EXIT_RULES.stretchActivationPct ? EXIT_RULES.stretchTrailPct : gain >= EXIT_RULES.trailActivationPct ? EXIT_RULES.trailPct : null;
  if (trail != null && bid <= position.peakBid * (1 - trail)) return "trailing_stop";
  // No-follow-through is an intraday scalp rule; swing and long-dated positions are governed
  // by the stop and trails instead — a 10-minute test would defeat their thesis.
  if (!isSwing && !longDated && now.getTime() - position.openedAt >= EXIT_RULES.noFollowThroughMs && position.peakBid < position.entryPrice * (1 + EXIT_RULES.followThroughPct)) return "no_follow_through";
  return null;
}

// Days to expiry from an OCC symbol date (YYMMDD segment), in ET.
export function dteFromOcc(symbol:string, now = new Date()):number|null {
  const match = /(\d{2})(\d{2})(\d{2})[CP]\d{8}$/.exec(symbol.replace(/^O:/,""));
  if (!match) return null;
  const expiry = Date.parse(`20${match[1]}-${match[2]}-${match[3]}T16:00:00-04:00`);
  const today = easternClock(now).dateKey;
  const expiryKey = `20${match[1]}-${match[2]}-${match[3]}`;
  if (expiryKey < today) return 0;
  return Math.max(0, Math.round((expiry - now.getTime()) / 86_400_000));
}

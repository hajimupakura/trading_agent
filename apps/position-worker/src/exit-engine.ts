import type { ManagedPosition } from "./types.js";

export const EXIT_RULES = { stopLossPct:.30, trailActivationPct:.40, trailPct:.20, stretchActivationPct:1, stretchTrailPct:.15, noFollowThroughMs:10 * 60_000, followThroughPct:.10, mandatoryExitMinutes:15 * 60 + 10,
  // Swing positions: opened at/after 15:30 ET and deliberately held overnight. Next day they run
  // on stop/trail/invalidation only, until the standard 15:10 flat — which also guards expiry,
  // since a 1DTE swing expires at that day's close.
  swingOpenThresholdMinutes:15 * 60 + 30 } as const;

export type ExitReason = "mandatory_time_exit"|"premium_stop"|"underlying_invalidation"|"trailing_stop"|"no_follow_through";
export function easternClock(now:Date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone:"America/New_York", weekday:"short", year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", hourCycle:"h23" }).formatToParts(now).map(part => [part.type, part.value]));
  return { weekday:parts.weekday, dateKey:`${parts.year}-${parts.month}-${parts.day}`, minutes:Number(parts.hour) * 60 + Number(parts.minute) };
}
export function evaluateExit(input:{ position:ManagedPosition; bid:number; underlyingPrice:number|null; now?:Date }):ExitReason|null {
  const now = input.now ?? new Date(); const { position, bid, underlyingPrice } = input; const clock = easternClock(now);
  const openedClock = easternClock(new Date(position.openedAt));
  const heldOvernight = openedClock.dateKey < clock.dateKey;
  // A swing position is one deliberately opened in the late-day window; it is exempt from the
  // same-day 15:10 flat, held overnight, and force-sold by 10:30 the next morning instead of 09:30.
  const isSwing = openedClock.minutes >= EXIT_RULES.swingOpenThresholdMinutes;
  const weekday = !["Sat","Sun"].includes(clock.weekday);
  if (weekday && heldOvernight && clock.minutes >= (isSwing ? EXIT_RULES.mandatoryExitMinutes : 570)) return "mandatory_time_exit";
  if (weekday && !heldOvernight && !isSwing && clock.minutes >= EXIT_RULES.mandatoryExitMinutes) return "mandatory_time_exit";
  if (bid <= position.entryPrice * (1 - EXIT_RULES.stopLossPct)) return "premium_stop";
  if (underlyingPrice != null && (position.side === "call" ? underlyingPrice <= position.market.openingRangeHigh : underlyingPrice >= position.market.openingRangeLow)) return "underlying_invalidation";
  const gain = position.peakBid / position.entryPrice - 1;
  const trail = gain >= EXIT_RULES.stretchActivationPct ? EXIT_RULES.stretchTrailPct : gain >= EXIT_RULES.trailActivationPct ? EXIT_RULES.trailPct : null;
  if (trail != null && bid <= position.peakBid * (1 - trail)) return "trailing_stop";
  // No-follow-through is an intraday scalp rule; swing positions are governed by the stop,
  // the trail, and the morning deadline instead — a 10-minute test would defeat the overnight thesis.
  if (!isSwing && now.getTime() - position.openedAt >= EXIT_RULES.noFollowThroughMs && position.peakBid < position.entryPrice * (1 + EXIT_RULES.followThroughPct)) return "no_follow_through";
  return null;
}

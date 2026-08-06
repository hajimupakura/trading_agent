import type { ManagedPosition } from "./types.js";

export const EXIT_RULES = { stopLossPct:.30, trailActivationPct:.40, trailPct:.20, stretchActivationPct:1, stretchTrailPct:.15, noFollowThroughMs:10 * 60_000, followThroughPct:.10, mandatoryExitMinutes:15 * 60 + 10 } as const;

export type ExitReason = "mandatory_time_exit"|"premium_stop"|"underlying_invalidation"|"trailing_stop"|"no_follow_through";
export function easternClock(now:Date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone:"America/New_York", weekday:"short", year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", hourCycle:"h23" }).formatToParts(now).map(part => [part.type, part.value]));
  return { weekday:parts.weekday, dateKey:`${parts.year}-${parts.month}-${parts.day}`, minutes:Number(parts.hour) * 60 + Number(parts.minute) };
}
export function evaluateExit(input:{ position:ManagedPosition; bid:number; spyPrice:number|null; now?:Date }):ExitReason|null {
  const now = input.now ?? new Date(); const { position, bid, spyPrice } = input; const clock = easternClock(now);
  const openedClock = easternClock(new Date(position.openedAt));
  const heldOvernight = openedClock.dateKey < clock.dateKey;
  if (!["Sat","Sun"].includes(clock.weekday) && ((heldOvernight && clock.minutes >= 570) || clock.minutes >= EXIT_RULES.mandatoryExitMinutes)) return "mandatory_time_exit";
  if (bid <= position.entryPrice * (1 - EXIT_RULES.stopLossPct)) return "premium_stop";
  if (spyPrice != null && (position.side === "call" ? spyPrice <= position.market.openingRangeHigh : spyPrice >= position.market.openingRangeLow)) return "underlying_invalidation";
  const gain = position.peakBid / position.entryPrice - 1;
  const trail = gain >= EXIT_RULES.stretchActivationPct ? EXIT_RULES.stretchTrailPct : gain >= EXIT_RULES.trailActivationPct ? EXIT_RULES.trailPct : null;
  if (trail != null && bid <= position.peakBid * (1 - trail)) return "trailing_stop";
  if (now.getTime() - position.openedAt >= EXIT_RULES.noFollowThroughMs && position.peakBid < position.entryPrice * (1 + EXIT_RULES.followThroughPct)) return "no_follow_through";
  return null;
}

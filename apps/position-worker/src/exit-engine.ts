import type { ManagedPosition } from "./types.js";

// trailActivationPct 0.40→0.35 (2026-08-13, grid on 42 tapes: arm 35/trail 20 best,
// +8.4%/trade; plateau 30-40; arms at 20-25 halve the edge) →0.33 (2026-08-14): the
// worker arms off the polled BID peak, which reads ~half a spread below the true peak —
// a GOOGL put peaked +34.3% by bid (chart printed higher), missed the 35% arm by half
// a cent, and rode to the -30% stop. 33 stays inside the measured plateau and gives
// bid-vs-print noise room to breathe. Knife-edge thresholds + noisy data = heartbreak.
export const EXIT_RULES = { stopLossPct:.30, trailActivationPct:.33, trailPct:.20, stretchActivationPct:1, stretchTrailPct:.15, noFollowThroughMs:10 * 60_000, followThroughPct:.10, mandatoryExitMinutes:15 * 60 + 10,
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

export type ExitReason = "mandatory_time_exit"|"premium_stop"|"underlying_invalidation"|"trailing_stop"|"no_follow_through"|"scalp_target"|"scalp_time_box"|"breakeven_ratchet";
export function easternClock(now:Date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone:"America/New_York", weekday:"short", year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", hourCycle:"h23" }).formatToParts(now).map(part => [part.type, part.value]));
  return { weekday:parts.weekday, dateKey:`${parts.year}-${parts.month}-${parts.day}`, minutes:Number(parts.hour) * 60 + Number(parts.minute) };
}
export function evaluateExit(input:{ position:ManagedPosition; bid:number; underlyingPrice:number|null; longDated?:boolean; now?:Date }):ExitReason|null {
  const now = input.now ?? new Date(); const { position, bid, underlyingPrice } = input; const clock = easternClock(now);
  const openedClock = easternClock(new Date(position.openedAt));
  const heldOvernight = openedClock.dateKey < clock.dateKey;
  // DOLLAR PROFIT LOCK (2026-08-19, user: "10% of a $90 option is $900. even a $300
  // increase I will take") — percentages don't express protection on large-dollar
  // positions, so this speaks dollars: once a position's PEAK unrealized gain reaches
  // $300, never surrender more than 40% of it — sell if the bid retreats to entry +
  // 60% of the peak gain. Overlays every managed mode; respects drive's pre-10:15
  // sleep; RIDE (manual) stays exempt by design. On cheap multi-lot 0DTEs the %
  // trails usually act first — this lock is the big-premium safety net the % rules
  // structurally can't be.
  // The lock STAYS AWAKE during the overnight morning grace (2026-11-23): grace
  // exists so overnight LOSERS aren't dumped at the bell, but a user GTH 7425C that
  // opened 18x ($0.40 -> ~$7.50) rode down to $2.32 with every guard asleep —
  // the lock's own charter ("even a $300 increase I will take", 2026-08-19) says a
  // big-dollar winner gets protected the moment it exists. Peaks reset at each
  // session's first sighting, so the lock measures the NEW day's peak, never
  // yesterday's.
  const peakDollarGain = (position.peakBid - position.entryPrice) * position.quantity * 100;
  const lockSuspended = position.exitMode === "drive" && clock.minutes < 615;
  // trend (RIDE) and convexity are exempt: the swarm study (5,325 ladder positions,
  // 2026-11-24) showed every early profit-take amputates the monsters that pay for
  // the duds — convexity's charter is max loss = premium, exit on TIME only.
  if (!["trend", "convexity"].includes(position.exitMode) && !lockSuspended && peakDollarGain >= 300) {
    const lockPrice = position.entryPrice + (position.peakBid - position.entryPrice) * 0.6;
    if (bid <= lockPrice) return "trailing_stop";
  }
  if (position.exitMode === "convexity") {
    // CONVEXITY SLEEVE (user-authorized 2026-11-24; calibrated on the 22-month swarm
    // study): far-OTM 3-7 DTE swing. NO premium stop, NO trail, NO profit target —
    // the day+2-close exit beat every target/trail variant (+$157k vs -$55k for 5x
    // targets on the same 979 far-OTM positions). Max loss is the premium, by design.
    // Exits: expiry-day 14:00 ET guard, else day+2 session close (>= 2 trading days
    // held, 15:45 ET). Weekends hold; nothing else sells.
    if (["Sat","Sun"].includes(clock.weekday)) return null;
    const convexityDte = dteFromOcc(position.alpacaSymbol, now) ?? 0;
    if (convexityDte <= 0 && clock.minutes >= 840) return "mandatory_time_exit";
    if (tradingDaysHeld(openedClock.dateKey, clock.dateKey) >= 2 && clock.minutes >= 945) return "mandatory_time_exit";
    return null;
  }
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
  if (position.exitMode === "drive") {
    // Opening-drive entries: a gap-and-go's first minutes are structurally violent — an
    // instant spike arms the trail and the first wobble stops it before the real trend.
    // GRID-CALIBRATED on the 21 historical fire days' REAL option tapes (2026-08-13):
    // immediate trail = -2%/trade; resume 10:15 with a FLAT 20% width = +26%/trade
    // (best band; 10:30 identical, 10:00 far worse — the 10:00-10:05 shake is real).
    // The 15%-after-2x tightening is deliberately absent here (it halved the edge:
    // +14% vs +26%). Profile: 7/21 win, median -30%, monsters carry it — convexity.
    // Until 10:15 only the disaster stop and gap-fill invalidation live.
    if (heldOvernight && !["Sat","Sun"].includes(clock.weekday) && clock.minutes >= 570) return "mandatory_time_exit";
    if (clock.minutes >= EXIT_RULES.mandatoryExitMinutes) return "mandatory_time_exit";
    if (bid <= position.entryPrice * (1 - EXIT_RULES.stopLossPct)) return "premium_stop";
    if (underlyingPrice != null && (position.side === "call" ? underlyingPrice <= position.market.openingRangeHigh : underlyingPrice >= position.market.openingRangeLow)) return "underlying_invalidation";
    if (clock.minutes >= 615) {
      const driveGain = position.peakBid / position.entryPrice - 1;
      if (driveGain >= EXIT_RULES.trailActivationPct && bid <= position.peakBid * (1 - EXIT_RULES.trailPct)) return "trailing_stop";
    }
    return null;
  }
  if (position.exitMode === "thesis") {
    // THESIS mode (flow pairs, multi-day conviction trades — 2026-08-19): what the 8/14
    // "protect profits" change SHOULD have been. Burst mode's scalp reflexes executed
    // five 1-3 DTE flow theses within 10-24 minutes of entry (the 10-minute follow-
    // through test + same-day 15:10 flat are 0DTE rules). Thesis = stop 30%, trail arms
    // +20% / width 15% (the protect-profits calibration), NO 10-minute test, NO same-day
    // flat; overnight gets the morning grace (losers flat 9:45, winners ride on the new
    // day's peaks); hard flat 15:10 on EXPIRY day only. Big-premium overlay still applies.
    const thesisDte = dteFromOcc(position.alpacaSymbol, now) ?? 0;
    const thesisWeekday = !["Sat","Sun"].includes(clock.weekday);
    if (thesisWeekday && thesisDte <= 0 && clock.minutes >= EXIT_RULES.mandatoryExitMinutes) return "mandatory_time_exit";
    if (thesisWeekday && heldOvernight && clock.minutes >= 585 && bid <= position.entryPrice) return "mandatory_time_exit";
    const thesisBig = position.entryPrice >= 20;
    if (bid <= position.entryPrice * (1 - (thesisBig ? 0.12 : EXIT_RULES.stopLossPct))) return "premium_stop";
    const thesisGain = position.peakBid / position.entryPrice - 1;
    const thesisTrail = thesisBig ? (thesisGain >= 0.10 ? 0.08 : null) : (thesisGain >= 0.20 ? 0.15 : null);
    if (thesisTrail != null && !(heldOvernight && clock.minutes < 585) && bid <= position.peakBid * (1 - thesisTrail)) return "trailing_stop";
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
  // Morning grace for overnight positions (user 2026-08-14: "don't sell first thing —
  // wait until ~9:45 and see how the market goes"): 9:30-9:44 only the stop lives; at
  // 9:45 losers go flat while winners keep riding under the normal trail on the NEW
  // day's peaks (the workers reset peak_bid at the first sighting of each session so
  // yesterday's high can't trip the trail at the bell). Everything held overnight
  // still goes flat by 15:10.
  if (!longDated && weekday && heldOvernight && (clock.minutes >= EXIT_RULES.mandatoryExitMinutes || (!isSwing && clock.minutes >= 585 && bid <= position.entryPrice))) return "mandatory_time_exit";
  if (!longDated && weekday && !heldOvernight && !isSwing && clock.minutes >= EXIT_RULES.mandatoryExitMinutes) return "mandatory_time_exit";
  // BIG-PREMIUM PROFILE (entry >= $20/contract): the percentage rules were calibrated
  // on cheap short-dated tapes where ±33% is a wiggle. On a $9k contract, "arm at
  // +33%" means +$3,000 unprotected — a SNDK call's +$1,250 peak round-tripped to
  // -$50 on 2026-08-17 without the trail ever waking. High-premium, higher-delta
  // contracts move less in % terms and each % is real money: stop 12%, arm +10%,
  // trail 8% off the peak.
  const bigPremium = position.entryPrice >= 20;
  const stopPct = bigPremium ? 0.12 : EXIT_RULES.stopLossPct;
  if (bid <= position.entryPrice * (1 - stopPct)) return "premium_stop";
  if (underlyingPrice != null && (position.side === "call" ? underlyingPrice <= position.market.openingRangeHigh : underlyingPrice >= position.market.openingRangeLow)) return "underlying_invalidation";
  const gain = position.peakBid / position.entryPrice - 1;
  // REAL-MONEY LANE: arm +20% / trail 15% (2026-08-18) — calibrated on the real
  // account's OWN 16-trade record, not the replay tapes: five real trades peaked
  // +20-34% and round-tripped to full stops (~-$400) in the 20-33% dead zone, while
  // the record contains a single >+65% winner whose exit is IDENTICAL under both
  // configs. Paper keeps the tape-validated 33/20 and keeps collecting the fat-tail
  // evidence; if paper's monsters prove the wide arm right, promotion is a data call.
  const realLane = position.userId === "robinhood";
  const trail = bigPremium
    ? (gain >= 0.10 ? 0.08 : null)
    : realLane
      ? (gain >= 0.20 ? 0.15 : null)
      : gain >= EXIT_RULES.stretchActivationPct ? EXIT_RULES.stretchTrailPct : gain >= EXIT_RULES.trailActivationPct ? EXIT_RULES.trailPct : null;
  if (trail != null && !(heldOvernight && clock.minutes < 585) && bid <= position.peakBid * (1 - trail)) return "trailing_stop";
  // BREAKEVEN RATCHET (2026-11-23, BS-sim over the 26 sampled SPX days: current rules
  // -38% total vs -10% with the ratchet, no winner clipped): once the peak has reached
  // +25%, the position may never round-trip into a loss — bid back at entry exits flat.
  // This is a FLOOR behind the trail, not a tighter arm (the Aug grid proved early
  // TRAILS halve the edge): a genuine round-trip to entry is a real reversal, not
  // spread noise, which is what makes it robust where tight arms are not. Big-premium
  // positions keep their own calibrated envelope; morning grace still applies.
  if (!bigPremium && gain >= 0.25 && bid <= position.entryPrice && !(heldOvernight && clock.minutes < 585)) return "breakeven_ratchet";
  // No-follow-through is an intraday scalp rule; swing, long-dated, and overnight
  // positions are governed by the stop and trails instead.
  if (!isSwing && !longDated && !heldOvernight && now.getTime() - position.openedAt >= EXIT_RULES.noFollowThroughMs && position.peakBid < position.entryPrice * (1 + EXIT_RULES.followThroughPct)) return "no_follow_through";
  return null;
}

// Weekdays strictly after openKey up to and including nowKey (ET date keys,
// YYYY-MM-DD). Entry Friday -> Tuesday = 2; weekends never count as held days.
export function tradingDaysHeld(openKey:string, nowKey:string):number {
  if (nowKey <= openKey) return 0;
  let count = 0;
  const cursor = new Date(`${openKey}T12:00:00Z`);
  const end = Date.parse(`${nowKey}T12:00:00Z`);
  while (cursor.getTime() < end) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) count++;
  }
  return count;
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

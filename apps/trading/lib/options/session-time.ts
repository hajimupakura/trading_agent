// Pure clock helpers (no server imports) so they can be unit-tested.

// 16:10 ET on the given ET date, as epoch ms (works in both EST and EDT). The exit
// session is over by then on full days and half days alike.
export function sessionCloseMs(dateKey: string): number {
  const guess = Date.parse(`${dateKey}T16:10:00-05:00`);
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hourCycle: "h23" }).format(new Date(guess)));
  return guess - (hour - 16) * 3_600_000; // EDT reads 17 at this instant -> pull back one hour
}

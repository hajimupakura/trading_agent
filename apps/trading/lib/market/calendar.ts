// MARKET CALENDAR (2026-11-27). Every time rule used to assume a weekday is a full
// 9:30-16:00 session. Thanksgiving week showed what that costs: the swarm sale clock
// counted Thanksgiving as a trading day, swarms bought Wednesday were scheduled for
// 15:45 on the 13:00 half day, the 15:10 flat would have fired after same-day options
// had already expired at 13:00, and the worker raised stale-quote and "offline" alarms
// all holiday. Sessions now come from Alpaca's trading calendar (the authority);
// a built-in NYSE table covers an outage so a dead endpoint degrades to the published
// schedule instead of to "every weekday is normal".
//
// Same class as apps/position-worker/src/market-calendar.ts (the two apps ship
// separately). Pure, so rules and tests use it synchronously; calendar-server.ts loads
// Alpaca's published sessions into it.

export type Session = { openMin: number; closeMin: number };

const REGULAR: Session = { openMin: 570, closeMin: 960 };
const HALF_DAY: Session = { openMin: 570, closeMin: 780 };
// NYSE full-day holidays and 13:00 early closes. Fallback only — Alpaca's calendar wins.
const FALLBACK_HOLIDAYS = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);
const FALLBACK_EARLY_CLOSES = new Set(["2026-11-27", "2026-12-24", "2027-11-26"]);

const weekdayOf = (dateKey: string) => new Date(`${dateKey}T12:00:00Z`).getUTCDay();
export const addDays = (dateKey: string, days: number) => new Date(Date.parse(`${dateKey}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export class MarketCalendar {
  // `known` = sessions from the authoritative calendar for [from, to]; dates outside that
  // window (or everything, when it is empty) use the fallback table.
  constructor(private readonly known: Map<string, Session> = new Map(), private readonly from = "", private readonly to = "") {}
  get authoritative(): boolean { return this.known.size > 0; }
  session(dateKey: string): Session | null {
    if (this.known.size && dateKey >= this.from && dateKey <= this.to) return this.known.get(dateKey) ?? null;
    const day = weekdayOf(dateKey);
    if (day === 0 || day === 6 || FALLBACK_HOLIDAYS.has(dateKey)) return null;
    return FALLBACK_EARLY_CLOSES.has(dateKey) ? HALF_DAY : REGULAR;
  }
  isTradingDay(dateKey: string): boolean { return this.session(dateKey) != null; }
  inSession(dateKey: string, minutes: number): boolean {
    const session = this.session(dateKey);
    return session != null && minutes >= session.openMin && minutes < session.closeMin;
  }
  // Trading sessions strictly after openKey, up to and including nowKey.
  tradingDaysBetween(openKey: string, nowKey: string): number {
    if (nowKey <= openKey) return 0;
    let count = 0;
    for (let cursor = addDays(openKey, 1); cursor <= nowKey; cursor = addDays(cursor, 1)) if (this.isTradingDay(cursor)) count++;
    return count;
  }
  // The first trading session strictly after dateKey (searches up to three weeks).
  nextSession(dateKey: string): string | null {
    for (let cursor = addDays(dateKey, 1), step = 0; step < 21; cursor = addDays(cursor, 1), step++) if (this.isTradingDay(cursor)) return cursor;
    return null;
  }
  // A rule written for a regular 16:00 close ("15:10", "15:45") keeps its distance
  // from the close on a short day: min(minute, close - minutesBeforeClose).
  beforeClose(dateKey: string, regularMinute: number): number {
    const session = this.session(dateKey) ?? REGULAR;
    return Math.min(regularMinute, session.closeMin - (REGULAR.closeMin - regularMinute));
  }
}

// BUY GATE for hand-placed and queued orders (2026-11-27). Returns why a buy must not
// go in right now, or null. Every lane's worker sells a same-day contract at the forced
// exit (15:10, or 50 minutes before an early close), so a same-day buy after that minute
// is bought and sold at once — and on a half day it also runs into the broker's own
// cutoff (11/27 12:42: "expires soon, unable to open new positions").
export function buyBlockReason(calendar: MarketCalendar, now: Date, expirationDate?: string | null): string | null {
  const dateKey = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now).map(part => [part.type, part.value]));
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  const session = calendar.session(dateKey);
  if (!session) return "The market is closed today (weekend or market holiday).";
  if (minutes < session.openMin || minutes >= session.closeMin) return `The market is closed right now (today's session is ${clock(session.openMin)}-${clock(session.closeMin)} ET).`;
  const forcedExit = calendar.beforeClose(dateKey, 910);
  if (expirationDate === dateKey && minutes >= forcedExit) return `This contract expires today and it is past ${clock(forcedExit)} ET, when same-day positions are force-sold${session.closeMin < 960 ? " on this half day" : ""} — a buy now would be sold immediately.`;
  return null;
}
const clock = (minutes: number) => { const hour = Math.floor(minutes / 60); return `${hour > 12 ? hour - 12 : hour}:${String(minutes % 60).padStart(2, "0")}${hour >= 12 ? " pm" : " am"}`; };

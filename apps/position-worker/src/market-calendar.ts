// MARKET CALENDAR (2026-11-27). Every time rule used to assume a weekday is a full
// 9:30-16:00 session. Thanksgiving week showed what that costs: the swarm sale clock
// counted Thanksgiving as a trading day, swarms bought Wednesday were scheduled for
// 15:45 on the 13:00 half day, the 15:10 flat would have fired after same-day options
// had already expired at 13:00, and the worker raised stale-quote and "offline" alarms
// all holiday. Sessions now come from Alpaca's trading calendar (the authority);
// a built-in NYSE table covers an outage so a dead endpoint degrades to the published
// schedule instead of to "every weekday is normal".
//
// Pure and synchronous at the point of use: the manager refreshes the shared calendar
// on its own clock (refreshMarketCalendar) and every rule reads currentCalendar().

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
const addDays = (dateKey: string, days: number) => new Date(Date.parse(`${dateKey}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

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
  // A rule written for a regular 16:00 close ("15:10", "15:45") keeps its distance
  // from the close on a short day: min(minute, close - minutesBeforeClose).
  beforeClose(dateKey: string, regularMinute: number): number {
    const session = this.session(dateKey) ?? REGULAR;
    return Math.min(regularMinute, session.closeMin - (REGULAR.closeMin - regularMinute));
  }
}

let shared = new MarketCalendar();
let loadedAt = 0;
export const currentCalendar = (): MarketCalendar => shared;
export function setMarketCalendar(calendar: MarketCalendar) { shared = calendar; loadedAt = Date.now(); }

const toMinutes = (value: string) => {
  const match = /^(\d{1,2}):?(\d{2})/.exec(value.trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : NaN;
};
const etDateKey = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(date);

// Refresh from Alpaca at most every 6 hours (30 minutes after a failure). Never throws:
// on failure the previous calendar (or the fallback table) stays in force and the
// error is logged, so a calendar outage can never stop the exit manager.
export async function refreshMarketCalendar(fetchCalendar: (start: string, end: string) => Promise<Array<{ date: string; open: string; close: string }>>, now = new Date()): Promise<void> {
  const age = Date.now() - loadedAt;
  if (loadedAt && age < (shared.authoritative ? 6 * 3_600_000 : 30 * 60_000)) return;
  const start = addDays(etDateKey(now), -21); const end = addDays(etDateKey(now), 60);
  try {
    const rows = await fetchCalendar(start, end);
    const known = new Map<string, Session>();
    for (const row of rows ?? []) {
      const openMin = toMinutes(String(row.open)); const closeMin = toMinutes(String(row.close));
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(row.date)) && Number.isFinite(openMin) && Number.isFinite(closeMin) && closeMin > openMin) known.set(String(row.date), { openMin, closeMin });
    }
    if (known.size < 20) throw new Error(`calendar returned only ${known.size} sessions for ${start}..${end}`);
    setMarketCalendar(new MarketCalendar(known, start, end));
  } catch (error) {
    loadedAt = Date.now();
    console.error(JSON.stringify({ event: "market_calendar_fallback", error: error instanceof Error ? error.message : String(error) }));
  }
}

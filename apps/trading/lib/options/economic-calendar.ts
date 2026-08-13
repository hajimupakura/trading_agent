// Economic-event guard: the mornings (and FOMC afternoons) where gaps are violent and
// stops routinely jump. Dates verified 2026-08-07 (CPI/FOMC) and 2026-08-13 (PPI) against
// the published BLS/Fed schedules — update the arrays when the next year's schedules post.
//   CPI: 8:30 ET releases. FOMC: 14:00 ET decisions. Jobs (NFP): first Friday, 8:30 ET (computed).
//   PPI: 8:30 ET releases — BRIEF-ONLY (guarded:false): the user gets the pre-release
//   heads-up and the post-release numbers brief, but PPI is a second-tier mover and does
//   NOT trigger the entry guard or the real-money event-day caution (no evidence yet).

export interface EconEvent { name: string; releaseLabel: string; guardStartMinutes: number; guardEndMinutes: number; guarded: boolean }

const CPI_DATES = ["2026-08-12", "2026-09-11", "2026-10-14", "2026-11-10", "2026-12-10", "2027-01-13"];
const PPI_DATES = ["2026-08-13", "2026-09-10", "2026-10-15", "2026-11-13", "2026-12-15"];
const FOMC_DECISION_DATES = ["2026-09-16", "2026-10-28", "2026-12-09"];

const etParts = (now: Date) => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" }).formatToParts(now);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { date: `${value.year}-${value.month}-${value.day}`, minutes: Number(value.hour) * 60 + Number(value.minute), weekday: String(value.weekday) };
};

function isFirstFriday(date: string, weekday: string): boolean {
  return weekday === "Fri" && Number(date.slice(8, 10)) <= 7;
}

// The event scheduled for the given moment's ET day, independent of time (for radar alerts).
export function todaysEconomicEvent(now = new Date()): EconEvent | null {
  const { date, weekday } = etParts(now);
  if (CPI_DATES.includes(date)) return { name: "CPI", releaseLabel: "8:30 AM ET", guardStartMinutes: 0, guardEndMinutes: 10 * 60, guarded: true };
  if (FOMC_DECISION_DATES.includes(date)) return { name: "FOMC decision", releaseLabel: "2:00 PM ET", guardStartMinutes: 13 * 60 + 30, guardEndMinutes: 15 * 60, guarded: true };
  if (isFirstFriday(date, weekday)) return { name: "Jobs report (NFP)", releaseLabel: "8:30 AM ET", guardStartMinutes: 0, guardEndMinutes: 10 * 60, guarded: true };
  if (PPI_DATES.includes(date)) return { name: "PPI (producer prices)", releaseLabel: "8:30 AM ET", guardStartMinutes: 0, guardEndMinutes: 10 * 60, guarded: false };
  return null;
}

// Non-null while entries should be blocked. Morning releases guard until 10:00 ET;
// FOMC guards 13:30-15:00 around the decision and presser.
export function activeEconomicGuard(now = new Date()): (EconEvent & { resumesAt: string }) | null {
  const event = todaysEconomicEvent(now);
  if (!event || !event.guarded) return null;
  const { minutes } = etParts(now);
  if (minutes < event.guardStartMinutes || minutes >= event.guardEndMinutes) return null;
  const hours = Math.floor(event.guardEndMinutes / 60); const mins = event.guardEndMinutes % 60;
  const resumesAt = `${((hours + 11) % 12) + 1}:${String(mins).padStart(2, "0")} ${hours >= 12 ? "PM" : "AM"} ET`;
  return { ...event, resumesAt };
}

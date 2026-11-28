// Days to expiry counted in WEEKDAYS, not calendar days (2026-11-28, Codex review of the
// next-expiry default). Friday -> Monday is 3 calendar days but one session: under the
// calendar count the Monday SPY/SPX contract was ineligible every Friday, so the paper
// lane could never use the next expiry that day. Exchange holidays are not removed, so
// a holiday inside the span counts as a session — the conservative direction (a span
// can only look LONGER than it is, never shorter). Pure; no calendar lookup.
export function weekdayDte(expirationDate: string, calendarDte: number): number {
  if (!(calendarDte > 0)) return Math.max(0, calendarDte);
  const expiry = Date.parse(`${expirationDate}T12:00:00Z`);
  if (!Number.isFinite(expiry)) return calendarDte;
  let sessions = 0;
  for (let offset = calendarDte - 1; offset >= 0; offset--) {
    const day = new Date(expiry - offset * 86_400_000).getUTCDay();
    if (day !== 0 && day !== 6) sessions++;
  }
  return sessions;
}

// The allowedDte check for the index names, by sessions: 0-2 trading days out.
export const indexDteAllowed = (allowedDte: readonly number[], contract: { expirationDate: string; dte: number }) =>
  allowedDte.includes(contract.dte) || allowedDte.includes(weekdayDte(contract.expirationDate, contract.dte));

// Eligible once DTE is counted in sessions: the ranker's screen with its calendar-DTE
// rejection forgiven when the contract is 0-2 sessions out. Used ONLY by the paper
// next-expiry choice — the shared ranker (Telegram cards, real-money lanes, the engine's
// own pick) keeps counting calendar days.
const DTE_REASONS = ["Next-session expiry", "DTE is disabled"];
export function eligibleBySessions(contract: { eligible: boolean; rejectionReasons: string[]; expirationDate: string; dte: number }, allowedDte: readonly number[]): boolean {
  if (contract.eligible) return true;
  return contract.rejectionReasons.length > 0
    && contract.rejectionReasons.every(reason => DTE_REASONS.some(prefix => reason.startsWith(prefix)))
    && indexDteAllowed(allowedDte, contract);
}

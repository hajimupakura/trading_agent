import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAlert } from "@/lib/alerts/server";
import { WATCH_UNDERLYINGS } from "./types";

// Earnings guard for single-name entries (real money AND paper):
//   - No entries at all on a symbol's report DAY (elevated IV bleeds into the event
//     even for intraday holds; BMO gap chop is untradeable by our setups).
//   - No swing-window entries (held overnight) when the NEXT session is a report day.
// Indexes/ETFs (SPY/SPX/QQQ/SLV/GLD) have no earnings rows and pass untouched.
// Dates live in earnings_calendar (some seeded as ESTIMATEs); a weekly staleness
// check pings Telegram when a tradeable single name has no future date on file.

const etDate = (daysAhead = 0) => {
  const date = new Date(Date.now() + daysAhead * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(date);
};

let cache: { rows: Array<{ symbol: string; report_date: string; timing: string }>; at: number } | null = null;
async function upcoming(): Promise<Array<{ symbol: string; report_date: string; timing: string }>> {
  if (cache && Date.now() - cache.at < 10 * 60_000) return cache.rows;
  const { data } = await createAdminClient().from("earnings_calendar")
    .select("symbol,report_date,timing").gte("report_date", etDate()).lte("report_date", etDate(7));
  cache = { rows: data ?? [], at: Date.now() };
  return cache.rows;
}

// Returns a human-readable block reason, or null if clear to enter.
export async function activeEarningsGuard(symbol: string, options?: { swingEntry?: boolean }): Promise<string | null> {
  const rows = await upcoming();
  const today = etDate();
  const todayReport = rows.find(row => row.symbol === symbol && row.report_date === today);
  if (todayReport) return `${symbol} reports earnings today (${todayReport.timing.toUpperCase()}) — single-name entries are blocked on report days`;
  if (options?.swingEntry) {
    // Overnight holds must not sit through tomorrow's report (BMO) or today's AMC print.
    const soon = rows.find(row => row.symbol === symbol && row.report_date <= etDate(1));
    if (soon) return `${symbol} reports earnings ${soon.report_date} — no overnight holds into a report`;
  }
  return null;
}

// Weekly staleness check (piggybacks the post-close cron window): any tradeable
// single name with no future earnings date on file gets flagged once per week.
const SINGLE_NAMES = WATCH_UNDERLYINGS.filter(symbol => !["QQQ", "SLV", "GLD"].includes(symbol));
export async function runEarningsCalendarCheck(): Promise<{ checked: boolean; missing: string[] }> {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map(part => [part.type, part.value]));
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  if (parts.weekday !== "Mon" || minutes < 962 || minutes > 985) return { checked: false, missing: [] };
  const admin = createAdminClient();
  const { data } = await admin.from("earnings_calendar").select("symbol").gte("report_date", etDate());
  const covered = new Set((data ?? []).map(row => String(row.symbol)));
  const missing = SINGLE_NAMES.filter(symbol => !covered.has(symbol));
  if (missing.length) {
    const week = etDate().slice(0, 8) + "wk";
    const { data: owner } = await admin.from("profiles").select("id").limit(1).maybeSingle();
    if (owner) await createAlert({
      userId: String(owner.id), eventKey: `radar-event-earnings-stale-${week}`, severity: "info",
      title: "Earnings calendar has gaps",
      body: `No upcoming earnings date on file for: ${missing.join(", ")}. The earnings guard cannot protect entries in these names until dates are added — worth a quick check of each company's next report date.`,
      metadata: { kind: "earnings_calendar_gaps", missing },
    }).catch(() => undefined);
  }
  return { checked: true, missing };
}

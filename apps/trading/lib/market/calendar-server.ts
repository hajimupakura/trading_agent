import "server-only";
import { MarketCalendar, addDays, type Session } from "./calendar";

// Alpaca's published trading calendar, cached per server instance for 6 hours (30
// minutes after a failure). On any failure the built-in NYSE table in MarketCalendar
// stands in, so a dead endpoint degrades to the published schedule, never to "every
// weekday is a full session".
let cached: { calendar: MarketCalendar; at: number; authoritative: boolean } | null = null;
const etDateKey = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(date);
const toMinutes = (value: string) => { const match = /^(\d{1,2}):?(\d{2})/.exec(String(value).trim()); return match ? Number(match[1]) * 60 + Number(match[2]) : NaN; };

export async function getMarketCalendar(now = new Date()): Promise<MarketCalendar> {
  if (cached && Date.now() - cached.at < (cached.authoritative ? 6 * 3_600_000 : 30 * 60_000)) return cached.calendar;
  const start = addDays(etDateKey(now), -21); const end = addDays(etDateKey(now), 60);
  try {
    const key = process.env.ALPACA_API_KEY_ID; const secret = process.env.ALPACA_API_SECRET_KEY;
    if (!key || !secret) throw new Error("Alpaca keys are not configured");
    const response = await fetch(`https://paper-api.alpaca.markets/v2/calendar?start=${start}&end=${end}`, { headers: { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret }, cache: "no-store", signal: AbortSignal.timeout(6_000) });
    if (!response.ok) throw new Error(`Alpaca calendar ${response.status}`);
    const rows = await response.json() as Array<{ date: string; open: string; close: string }>;
    const known = new Map<string, Session>();
    for (const row of rows ?? []) {
      const openMin = toMinutes(row.open); const closeMin = toMinutes(row.close);
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(row.date)) && Number.isFinite(openMin) && Number.isFinite(closeMin) && closeMin > openMin) known.set(String(row.date), { openMin, closeMin });
    }
    if (known.size < 20) throw new Error(`calendar returned only ${known.size} sessions`);
    cached = { calendar: new MarketCalendar(known, start, end), at: Date.now(), authoritative: true };
  } catch (error) {
    console.error("market calendar: using the built-in NYSE table", error instanceof Error ? error.message : error);
    cached = { calendar: new MarketCalendar(), at: Date.now(), authoritative: false };
  }
  return cached.calendar;
}

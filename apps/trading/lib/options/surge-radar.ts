import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAlert } from "@/lib/alerts/server";
import { WATCH_UNDERLYINGS } from "./types";
import { detectSurge } from "./surge-trigger";

// Surge radar — the MEASURED trigger, multi-ticker, ALERT-ONLY.
// Trigger (backtested on 1yr SPY dailies): decisive day (body >= 60% of range) that
// closes near its high (<= 15% off) AND above the prior day's high. Fired ~33x/yr on
// SPY; ~1 in 6 fires delivered surge-grade (>=2%) follow-through within 3 sessions,
// and this exact pattern preceded the 8/3->8/7 98x SPXW ride. The DOWN mirror is
// reported for awareness but framed no-trade: puts failed every backtest this week.
// Runs post-close (16:02-16:25 ET) once per day per symbol; nothing here trades.

const SYMBOLS = ["SPY", ...WATCH_UNDERLYINGS] as const;

const et = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" }).formatToParts(date);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { minutes: Number(value.hour) * 60 + Number(value.minute), weekday: value.weekday };
};
const etDate = (date = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(date);

function headers() {
  const key = process.env.ALPACA_API_KEY_ID; const secret = process.env.ALPACA_API_SECRET_KEY;
  if (!key || !secret) throw new Error("Alpaca keys are not configured");
  return { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret };
}

interface DayBar { date: string; o: number; h: number; l: number; c: number }
async function dailyBars(): Promise<Record<string, DayBar[]>> {
  const url = new URL("https://data.alpaca.markets/v2/stocks/bars");
  url.searchParams.set("symbols", SYMBOLS.join(",")); url.searchParams.set("timeframe", "1Day");
  url.searchParams.set("feed", "iex"); url.searchParams.set("limit", "1000");
  url.searchParams.set("adjustment", "all"); url.searchParams.set("sort", "asc");
  url.searchParams.set("start", new Date(Date.now() - 12 * 86_400_000).toISOString().slice(0, 10));
  const response = await fetch(url, { headers: headers(), cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Alpaca daily bars ${response.status}`);
  const payload = await response.json() as { bars?: Record<string, Array<{ t: string; o: number; h: number; l: number; c: number }>> };
  const out: Record<string, DayBar[]> = {};
  for (const [symbol, bars] of Object.entries(payload.bars ?? {})) out[symbol] = bars.map(bar => ({ date: etDate(new Date(bar.t)), o: bar.o, h: bar.h, l: bar.l, c: bar.c }));
  return out;
}

export async function runSurgeRadar(): Promise<{ fired: string[]; errors: string[] }> {
  const clock = et();
  const fired: string[] = []; const errors: string[] = [];
  // Post-close sweep only, after the daily bar is final-ish.
  if (["Sat", "Sun"].includes(clock.weekday) || clock.minutes < 962 || clock.minutes > 985) return { fired, errors };
  const admin = createAdminClient();
  const { data: owner } = await admin.from("profiles").select("id").limit(1).maybeSingle();
  if (!owner) return { fired, errors };
  const today = etDate();

  let bars: Record<string, DayBar[]>;
  try { bars = await dailyBars(); } catch (error) { return { fired, errors: [error instanceof Error ? error.message : String(error)] }; }

  for (const symbol of SYMBOLS) {
    try {
      const series = (bars[symbol] ?? []).filter(bar => bar.date <= today);
      const todayBar = series.find(bar => bar.date === today);
      const prior = series.filter(bar => bar.date < today).at(-1);
      if (!todayBar || !prior) continue;
      const direction = detectSurge(todayBar, prior);
      if (!direction) continue;
      const upSurge = direction === "up";
      const eventKey = `radar-surge-${today}-${symbol}`;
      const { data: seen } = await admin.from("alerts").select("id").eq("event_key", eventKey).limit(1).maybeSingle();
      if (seen) continue;
      await admin.from("surge_triggers").insert({
        session_date: today, symbol, direction,
        detail: { open: todayBar.o, high: todayBar.h, low: todayBar.l, close: todayBar.c, priorHigh: prior.h, priorLow: prior.l },
      }).then(({ error }) => { if (error) errors.push(`trigger persistence ${symbol}: ${error.message}`); });
      const changePct = ((todayBar.c / prior.c - 1) * 100).toFixed(1);
      const isIndex = symbol === "SPY";
      await createAlert({
        userId: owner.id, eventKey, severity: upSurge ? "warning" : "info",
        title: upSurge
          ? `Surge conditions: ${isIndex ? "the market (SPY/SPX)" : symbol} closed like a breakout day`
          : `Breakdown close on ${isIndex ? "the market (SPY/SPX)" : symbol} — awareness only`,
        body: upSurge
          ? `${isIndex ? "The market" : symbol} had a decisive up day (${changePct >= "0" ? "+" : ""}${changePct}%), closed near its high, and pushed above yesterday's high — the same closing pattern that preceded the 8/3-8/7 surge. History on this pattern: it fires ~33 times a year on the index and roughly 1 in 6 keeps running hard for days; most fires fizzle, which is why any entry waits for TOMORROW MORNING to confirm (price holding above today's high after 9:45). ${isIndex ? "Candidate expression: a next-Friday SPXW call ~1.5-3% above the market — exact selection rule pending the backtest now finishing." : "Single names carry earnings and headline risk — check the calendar before considering anything."} Nothing is being bought automatically.`
          : `${isIndex ? "The market" : symbol} closed decisively at its lows, below yesterday's low (${changePct}%). For awareness only: every backtest this week found overnight bearish bets after closes like this lose money (the market gapped UP after the textbook version on 8/6). No trade is suggested.`,
        metadata: { kind: "surge_trigger", symbol, direction, changePct: Number(changePct) },
      });
      fired.push(`${symbol}:${direction}`);
    } catch (error) {
      errors.push(`${symbol}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { fired, errors };
}

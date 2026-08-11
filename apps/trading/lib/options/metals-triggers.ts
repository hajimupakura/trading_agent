import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAlert } from "@/lib/alerts/server";

// Metals thesis triggers (user-requested, from two social chart posts 2026-08-10):
//   1. SLV daily CLOSE above $60  -> the poster's own bullish trigger level.
//   2. GLD weekly MACD actually crossing bullish (it was NOT crossed when posted:
//      -10.2 vs -6.7; histogram improving). Alert fires on the real cross only.
// Checked once per day shortly after the close; each alert fires ONCE (fixed event
// key) and goes to the insights channel. These are informational triggers — nothing
// trades on them.

const etNow = () => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map(part => [part.type, part.value]));
  return { weekday: String(parts.weekday), minutes: Number(parts.hour) * 60 + Number(parts.minute) };
};

async function dailyCloses(symbol: string, days: number): Promise<Array<{ date: string; close: number }>> {
  const key = process.env.ALPACA_API_KEY_ID; const secret = process.env.ALPACA_API_SECRET_KEY;
  if (!key || !secret) throw new Error("Alpaca keys are not configured");
  const start = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const url = new URL(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/bars`);
  url.searchParams.set("timeframe", "1Day"); url.searchParams.set("start", start); url.searchParams.set("feed", "iex");
  url.searchParams.set("adjustment", "all"); url.searchParams.set("sort", "asc"); url.searchParams.set("limit", "500");
  const response = await fetch(url, { headers: { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret }, cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Alpaca ${symbol} daily ${response.status}`);
  const payload = await response.json() as { bars?: Array<{ t: string; c: number }> };
  return (payload.bars ?? []).map(bar => ({ date: bar.t.slice(0, 10), close: bar.c }));
}

// ISO-week bucketing (Monday start) -> last close per week, oldest first.
function weeklyCloses(daily: Array<{ date: string; close: number }>): number[] {
  const weeks = new Map<string, number>();
  for (const bar of daily) {
    const date = new Date(`${bar.date}T12:00:00Z`);
    const day = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - day);
    weeks.set(date.toISOString().slice(0, 10), bar.close);
  }
  return [...weeks.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, close]) => close);
}

export async function runMetalTriggers(): Promise<{ checked: boolean; fired: string[] }> {
  const { weekday, minutes } = etNow();
  if (["Sat", "Sun"].includes(weekday) || minutes < 962 || minutes > 985) return { checked: false, fired: [] };
  const admin = createAdminClient();
  const { data: owner } = await admin.from("profiles").select("id").limit(1).maybeSingle();
  if (!owner) return { checked: false, fired: [] };
  const fired: string[] = [];

  // --- SLV close above $60
  try {
    const slv = await dailyCloses("SLV", 10);
    const last = slv.at(-1);
    if (last && last.close >= 60) {
      const { data: seen } = await admin.from("alerts").select("id").eq("event_key", "radar-metal-slv-60").limit(1).maybeSingle();
      if (!seen) {
        await createAlert({
          userId: owner.id, eventKey: "radar-metal-slv-60", severity: "info",
          title: "SLV closed above $60 — the silver trigger level hit",
          body: `SLV (the silver fund) closed at $${last.close.toFixed(2)}, above the $60 level you were watching from that chart post. By the poster's own framing the bullish setup is now "active" (his targets were $63/$65/$67/$70). Reminder of what we verified: silver already ran ~20% in the prior month, so this is a momentum continuation bet, not a bottom entry. Nothing trades automatically on this — it's your call.`,
          metadata: { kind: "metal_trigger", symbol: "SLV", close: last.close },
        });
        fired.push("SLV>60");
      }
    }
  } catch (error) { console.error("SLV trigger check failed", error); }

  // --- GLD weekly MACD bullish cross
  try {
    const gld = await dailyCloses("GLD", 430);
    const closes = weeklyCloses(gld);
    if (closes.length >= 30) {
      let emaFast = closes[0], emaSlow = closes[0], signal = 0, macd = 0;
      for (const close of closes) {
        emaFast += (2 / 13) * (close - emaFast); emaSlow += (2 / 27) * (close - emaSlow);
        macd = emaFast - emaSlow; signal += (2 / 10) * (macd - signal);
      }
      if (macd > signal) {
        const { data: seen } = await admin.from("alerts").select("id").eq("event_key", "radar-metal-gld-macd-cross").limit(1).maybeSingle();
        if (!seen) {
          await createAlert({
            userId: owner.id, eventKey: "radar-metal-gld-macd-cross", severity: "info",
            title: "GLD weekly MACD has actually crossed bullish",
            body: `The gold fund's weekly momentum indicator (MACD) has now genuinely crossed above its signal line — the thing that chart post claimed was "about to happen" back on Aug 10 (it wasn't then; it is now). Weekly-chart signals move on a scale of weeks to months, not days. GLD is at $${gld.at(-1)?.close.toFixed(2)}. Informational only — nothing trades on this.`,
            metadata: { kind: "metal_trigger", symbol: "GLD", macd: +macd.toFixed(2), signal: +signal.toFixed(2) },
          });
          fired.push("GLD-macd-cross");
        }
      }
    }
  } catch (error) { console.error("GLD trigger check failed", error); }

  return { checked: true, fired };
}

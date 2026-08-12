import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAlert } from "@/lib/alerts/server";

// SMART MONEY TRACKER: every large options print (>= $500k premium) becomes a scored
// hypothesis — "this flow knows something" — measured over the following 1 and 3
// trading days instead of trusted or dismissed. Genesis: 2026-08-10 SPCX ($23M calls
// pre-Terafab, +11% in 2 days) and MU (+10%). The running hit rate IS the study: if
// confirmed-rate beats coin-flip over ~30 watches, flow earns a role in sizing via
// the promotion ladder; if not, we will have proven the digests are entertainment.
// Nothing trades on this — it measures.

const WATCH_MIN_PREMIUM = 500_000;
const CONFIRM_PCT = 3; // directional move that counts as confirmation over <=3 days

export async function recordFlowWatch(input: { ticker: string; premium: number; side: "call" | "put" }): Promise<void> {
  if (input.premium < WATCH_MIN_PREMIUM) return;
  const symbol = (/^O:([A-Z]+?)\d{6}/.exec(input.ticker)?.[1] ?? "").replace(/W$/, "");
  if (!symbol) return;
  const flowDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
  await createAdminClient().from("flow_watches").upsert({
    symbol, direction: input.side === "call" ? "bullish" : "bearish",
    contract_ticker: input.ticker, premium: input.premium, flow_date: flowDate,
  }, { onConflict: "contract_ticker,flow_date", ignoreDuplicates: true }).then(({ error }) => { if (error) console.error("flow watch record failed", error.message); });
}

async function dailyCloses(symbol: string, fromDate: string): Promise<Array<{ date: string; close: number }>> {
  const key = process.env.ALPACA_API_KEY_ID; const secret = process.env.ALPACA_API_SECRET_KEY;
  if (!key || !secret) return [];
  const proxy = symbol === "SPX" ? "SPY" : symbol; // no index daily feed — SPY tracks SPX direction 1:1
  const url = new URL(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(proxy)}/bars`);
  url.searchParams.set("timeframe", "1Day"); url.searchParams.set("start", fromDate); url.searchParams.set("feed", "iex");
  url.searchParams.set("adjustment", "all"); url.searchParams.set("sort", "asc"); url.searchParams.set("limit", "10");
  const response = await fetch(url, { headers: { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret }, cache: "no-store", signal: AbortSignal.timeout(8000) });
  if (!response.ok) return [];
  const payload = await response.json() as { bars?: Array<{ t: string; c: number }> };
  return (payload.bars ?? []).map(bar => ({ date: bar.t.slice(0, 10), close: bar.c }));
}

// Post-close scorer (16:05-16:25 ET weekdays): grades aged watches, telegrams
// confirmations with the running hit rate.
export async function runFlowWatchScoring(): Promise<{ checked: boolean; scored: number }> {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map(part => [part.type, part.value]));
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  if (["Sat", "Sun"].includes(String(parts.weekday)) || minutes < 965 || minutes > 985) return { checked: false, scored: 0 };
  const admin = createAdminClient();
  const { data: watches } = await admin.from("flow_watches").select("*").eq("status", "watching").order("premium", { ascending: false }).limit(25);
  let scored = 0;
  for (const watch of watches ?? []) {
    const closes = await dailyCloses(String(watch.symbol), String(watch.flow_date));
    if (closes.length < 2) continue; // flow day + at least one later close
    const base = closes[0].close;
    const sign = watch.direction === "bullish" ? 1 : -1;
    const alignedPct = (index: number) => +(((closes[index].close / base - 1) * 100) * sign).toFixed(2);
    const patch: Record<string, unknown> = {};
    if (closes.length >= 2 && watch.ret_1d == null) patch.ret_1d = alignedPct(1);
    if (closes.length >= 4) {
      patch.ret_3d = alignedPct(3);
      patch.status = "scored";
      patch.verdict = alignedPct(3) >= CONFIRM_PCT ? "confirmed" : alignedPct(3) <= -CONFIRM_PCT ? "refuted" : "neutral";
    } else if (closes.length >= 2 && alignedPct(closes.length - 1) >= CONFIRM_PCT && watch.verdict == null) {
      // Early confirmation: already moved 3%+ in the flow's direction before day 3.
      patch.verdict = "confirmed";
    }
    if (!Object.keys(patch).length) continue;
    await admin.from("flow_watches").update(patch).eq("id", watch.id);
    scored++;
    if (patch.verdict === "confirmed") {
      const { data: tally } = await admin.from("flow_watches").select("verdict").not("verdict", "is", null);
      const confirmed = (tally ?? []).filter(row => row.verdict === "confirmed").length;
      const total = (tally ?? []).length;
      await createAlert({
        userId: (await admin.from("profiles").select("id").limit(1).maybeSingle()).data?.id as string,
        eventKey: `radar-event-flowwatch-${watch.id}`, severity: "info",
        title: `Smart money confirmed: ${watch.symbol} moved with the big print`,
        body: `On ${watch.flow_date}, ~$${(Number(watch.premium) / 1_000_000).toFixed(1)}M of ${watch.direction} option bets hit ${watch.symbol}. Since then it has moved ${alignedPct(closes.length - 1)}% in that direction — the flow was right. Running scoreboard: ${confirmed} of ${total} large prints confirmed so far. This is measurement, not a signal yet — at ~30 scored watches we test whether following the whales actually beats a coin flip.`,
        metadata: { kind: "flow_watch_confirmed", symbol: watch.symbol, premium: watch.premium, confirmed, total },
      }).catch(error => console.error("flow watch alert failed", error));
    }
  }
  return { checked: true, scored };
}

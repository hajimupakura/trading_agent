import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAlert } from "@/lib/alerts/server";
import { telegramConfigured } from "@/lib/notify/telegram";
import { freshContract } from "./execute";

// DIP COMPANION for manual-exit positions (user ask, 2026-11-23, after panic-selling
// an NVDA 195C at $0.39 on a dip that rebounded to $0.73): the system SHOUTS, never
// sells. When a manual_hold position falls 25% (and again at 50%) from its session
// peak, one calm message states the numbers that matter — peak-relative drawdown is
// fear's metric, entry-relative P&L is the plan's — so the human deciding the exit
// has arithmetic in the room, not just adrenaline. Each tier fires once per
// position per day; event keys ride the radar- prefix for instant Telegram delivery.
// Quote ladder mirrors executeSell: worker bid while its row is a live pulse,
// otherwise the scan's fresh quote; a position with no fresh price alerts nothing
// (the worker-silence tripwire owns that failure).

const TIERS = [
  { pct: 0.25, slug: "dip25", label: "25% off its session peak" },
  { pct: 0.50, slug: "dip50", label: "HALF its session peak" },
] as const;

const et = () => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map(part => [part.type, part.value]));
  return { weekday: String(parts.weekday), minutes: Number(parts.hour) * 60 + Number(parts.minute) };
};

export async function notifyManualHoldDips(): Promise<{ alerted: number }> {
  if (!telegramConfigured()) return { alerted: 0 };
  const clock = et();
  if (["Sat", "Sun"].includes(clock.weekday) || clock.minutes < 575 || clock.minutes >= 960) return { alerted: 0 };
  const admin = createAdminClient();
  const { data: holds } = await admin.from("rh_position_monitors")
    .select("occ_ticker,chain_symbol,quantity,entry_price,latest_bid,updated_at,user_id")
    .eq("status", "manual_hold");
  if (!holds?.length) return { alerted: 0 };
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
  let alerted = 0;
  for (const hold of holds) {
    const occ = String(hold.occ_ticker);
    // Freshness ladder: worker bid only while its row is a live pulse (<3 min).
    const workerFresh = Date.now() - Date.parse(String(hold.updated_at)) < 3 * 60_000;
    let bid = workerFresh ? Number(hold.latest_bid ?? 0) : 0;
    if (!(bid > 0)) {
      const chain = String(hold.chain_symbol);
      const live = await freshContract(["SPXW", "SPX"].includes(chain) ? "SPX" : chain, occ).catch(() => null);
      if (live && live.bid > 0) bid = live.bid;
    }
    if (!(bid > 0)) continue;
    // Session peak lives in tg_dip_state (the worker's manual_hold branch does not
    // reliably refresh peak_bid).
    const { data: state } = await admin.from("tg_dip_state").select("peak_bid").eq("occ_ticker", occ).eq("session_date", today).maybeSingle();
    const peak = Math.max(Number(state?.peak_bid ?? 0), bid);
    await admin.from("tg_dip_state").upsert({ occ_ticker: occ, session_date: today, peak_bid: peak, updated_at: new Date().toISOString() });
    if (!(peak > 0) || bid >= peak) continue;
    const drawdown = (peak - bid) / peak;
    const tier = [...TIERS].reverse().find(candidate => drawdown >= candidate.pct);
    if (!tier) continue;
    const eventKey = `radar-${tier.slug}-${occ}-${today}`;
    const { data: seen } = await admin.from("alerts").select("id").eq("event_key", eventKey).limit(1).maybeSingle();
    if (seen) continue;
    const entry = Number(hold.entry_price);
    const vsEntryPct = entry > 0 ? (bid / entry - 1) * 100 : null;
    // A dip WITH a fresh headline is information; a dip WITHOUT one is flow — naming
    // which one this is changes how it should feel. Lookup is best-effort.
    const chainSymbol = String(hold.chain_symbol);
    const newsSymbol = ["SPXW", "SPX"].includes(chainSymbol) ? "SPX" : chainSymbol;
    const { latestNewsFor, newsAge } = await import("@/lib/news/market-news");
    const news = await latestNewsFor(newsSymbol).catch(() => null);
    const newsLine = news ? ` Fresh news: "${news.headline.slice(0, 120)}" (${newsAge(news.publishedAt)}).` : ` No ${newsSymbol} headline in 3h — this dip is flow, not information.`;
    await createAlert({
      userId: String(hold.user_id), eventKey, severity: "warning",
      title: `Dip check: ${occ.replace("O:", "")} is ${Math.round(drawdown * 100)}% off its peak`,
      body: `${Math.floor(Number(hold.quantity))}× ${occ.replace("O:", "")} — bid $${bid.toFixed(2)}, session peak $${peak.toFixed(2)} (${tier.label}). Versus YOUR ENTRY ($${entry.toFixed(2)}) it is ${vsEntryPct == null ? "?" : `${vsEntryPct >= 0 ? "+" : ""}${vsEntryPct.toFixed(0)}%`}.${newsLine} The peak number is fear's metric; the entry number is your plan's. This position is manual-exit — nothing sells unless you do. If you'd rather the trail decide, "Hand back" in /positions re-arms it.`,
      metadata: { kind: "tg_dip_alert", occTicker: occ, bid, peak, drawdownPct: Math.round(drawdown * 100), vsEntryPct },
    }).catch(() => undefined);
    alerted++;
  }
  return { alerted };
}

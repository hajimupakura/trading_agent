import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAlert } from "@/lib/alerts/server";
import { loadRiskSettings } from "@/lib/settings/risk-settings";
import { todaysEconomicEvent } from "@/lib/options/economic-calendar";
import { aiConfigured, chatComplete } from "./openrouter";
import type { CommandCenter, Underlying } from "@/lib/options/types";
import { TRADE_UNDERLYINGS, WATCH_UNDERLYINGS } from "@/lib/options/types";

// AI review layer: the LLM interprets and narrates — it never decides. Deterministic
// gates (risk caps, economic guard, kill switch) remain the only things that can
// allow or block an order. Three products:
//   1. Morning brief (~9:15 ET): one narrative over radar/flow/regime/watchlist.
//   2. Trade critique: devil's-advocate read of a ticket before the user approves it.
//   3. Weekly post-mortem (Fri after close): narrative over the week's fills.
// Briefs and post-mortems go through createAlert, which mirrors to Telegram.

const etParts = (now = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" }).formatToParts(now);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { date: `${value.year}-${value.month}-${value.day}`, minutes: Number(value.hour) * 60 + Number(value.minute), weekday: String(value.weekday) };
};

async function ownerId(): Promise<string | null> {
  const { data } = await createAdminClient().from("profiles").select("id").limit(1).maybeSingle();
  return data?.id ?? null;
}

async function alertExists(eventKey: string): Promise<boolean> {
  const { data } = await createAdminClient().from("alerts").select("id").eq("event_key", eventKey).limit(1).maybeSingle();
  return Boolean(data);
}

// Recent radar/flow/engine alerts, oldest first, compacted for the prompt.
async function recentSystemAlerts(hoursBack: number): Promise<string[]> {
  const since = new Date(Date.now() - hoursBack * 3_600_000).toISOString();
  const { data } = await createAdminClient().from("alerts")
    .select("event_key,title,body,created_at")
    .gte("created_at", since)
    .order("created_at", { ascending: true })
    .limit(40);
  return (data ?? [])
    .filter(row => !String(row.event_key).startsWith("ai-"))
    .map(row => `[${String(row.created_at).slice(0, 16)}Z] ${row.title}: ${row.body}`);
}

interface SnapshotSummary { symbol: string; price: number | null; regime: string | null; priorClose: number | null; changePct: number | null }

async function snapshotSummaries(symbols: readonly Underlying[]): Promise<SnapshotSummary[]> {
  const { data } = await createAdminClient().from("options_monitor_snapshots").select("underlying,payload").in("underlying", symbols as unknown as string[]);
  return (data ?? []).map(row => {
    const payload = row.payload as CommandCenter | null;
    const market = payload?.market ?? null;
    const price = market?.price ?? payload?.spotPrice ?? null;
    const priorClose = market?.priorDay?.close ?? null;
    return {
      symbol: String(row.underlying), price, regime: market?.regime ?? null, priorClose,
      changePct: price != null && priorClose ? ((price / priorClose - 1) * 100) : null,
    };
  });
}

function formatSnapshots(rows: SnapshotSummary[]): string {
  return rows.map(row => `${row.symbol}: ${row.price != null ? `$${row.price.toFixed(2)}` : "no price"}${row.changePct != null ? ` (${row.changePct >= 0 ? "+" : ""}${row.changePct.toFixed(2)}% vs prior close)` : ""}${row.regime ? ` · regime ${row.regime}` : ""}`).join("\n");
}

// ---------------------------------------------------------------- morning brief

export async function runMorningBrief(): Promise<boolean> {
  const userId = await ownerId();
  if (!userId || !aiConfigured()) return false;
  const today = etParts().date;
  const eventKey = `ai-brief-${today}`;
  if (await alertExists(eventKey)) return false;

  const [alerts, indexSnaps, watchSnaps] = await Promise.all([
    recentSystemAlerts(18),
    snapshotSummaries(TRADE_UNDERLYINGS),
    snapshotSummaries(WATCH_UNDERLYINGS),
  ]);
  const econ = todaysEconomicEvent();
  const movers = watchSnaps.filter(row => row.changePct != null).sort((a, b) => Math.abs(b.changePct!) - Math.abs(a.changePct!)).slice(0, 5);

  const brief = await chatComplete({
    system: "You are the morning-brief writer for Velocity, a disciplined options-trading system trading SPY/SPX 0-2DTE plus a 10-name watchlist. Write ONE tight narrative (200-300 words, plain text, no markdown headers) in two parts: 'Today's tape' (what the overnight/pre-market data says) and 'The playbook' (which of the system's setups — opening-range breakout, trend-day continuation, swing entries — are favored or disfavored, and what would invalidate that read). Use ONLY the data provided. Never invent numbers. Never instruct the user to place a trade; the deterministic engine decides entries. If data is thin, say so plainly. The reader is a beginner still learning market terms: write in plain everyday English, briefly explain any necessary jargon the first time it appears (e.g. 'open interest — contracts already outstanding'), and prefer 'bets the market rises/falls' over bullish/bearish positioning.",
    user: [
      `Date: ${today} (ET).`,
      econ ? `Scheduled economic event: ${econ.name} at ${econ.releaseLabel} — the engine blocks entries around it.` : "No CPI/FOMC/NFP event scheduled today.",
      `Index state:\n${formatSnapshots(indexSnaps) || "none"}`,
      `Top watchlist movers:\n${formatSnapshots(movers) || "none"}`,
      `System alerts from the last 18 hours (radar, flow, regime, fills):\n${alerts.length ? alerts.join("\n") : "none — quiet tape."}`,
    ].join("\n\n"),
    maxTokens: 700,
  });

  await createAlert({ userId, eventKey, severity: "info", title: "Morning brief — today's tape & playbook", body: brief, metadata: { kind: "ai_brief", model: process.env.OPENROUTER_MODEL ?? "anthropic/claude-sonnet-5" } });
  return true;
}

// ---------------------------------------------------------------- trade critique

export interface CritiqueTicket {
  underlying: string; ticker: string; side: "call" | "put"; strike: number;
  expirationDate: string; dte: number; quantity: number; limitPrice: number;
}

export async function critiqueTicket(ticket: CritiqueTicket): Promise<string> {
  const [alerts, snaps] = await Promise.all([
    recentSystemAlerts(8),
    snapshotSummaries([ticket.underlying as Underlying]),
  ]);
  const econ = todaysEconomicEvent();
  const tomorrowEcon = todaysEconomicEvent(new Date(Date.now() + 86_400_000));
  return chatComplete({
    system: "You are the devil's advocate for an options trader about to submit a ticket. Your ONLY job is the bear case against this specific trade: crowding (is the flow already one-sided the same way?), event risk, chase risk after an extended move, theta/DTE math, spread and liquidity cost, and sizing relative to a small account. Be concrete and numeric where the data allows; 120-180 words, plain text. End with one line: 'Strongest counter-argument: …'. You advise only — deterministic risk gates decide what is allowed. Use ONLY the data provided; never invent numbers. The reader is a beginner: plain everyday English, explain jargon in a few words the first time it appears, dollar amounts over Greek-letter shorthand.",
    user: [
      `Ticket: BUY ${ticket.quantity} × ${ticket.underlying} ${ticket.strike}${ticket.side === "call" ? "C" : "P"} exp ${ticket.expirationDate} (${ticket.dte}DTE) at $${ticket.limitPrice.toFixed(2)} limit — total debit $${(ticket.quantity * ticket.limitPrice * 100).toFixed(0)}. OCC: ${ticket.ticker}.`,
      econ ? `Economic event TODAY: ${econ.name} at ${econ.releaseLabel}.` : tomorrowEcon ? `Economic event TOMORROW: ${tomorrowEcon.name} at ${tomorrowEcon.releaseLabel}.` : "No CPI/FOMC/NFP today or tomorrow.",
      `Underlying state:\n${formatSnapshots(snaps) || "no snapshot available"}`,
      `Recent system alerts (flow skews, radar, fills, last 8h):\n${alerts.length ? alerts.join("\n") : "none"}`,
    ].join("\n\n"),
    maxTokens: 450,
  });
}

// ---------------------------------------------------------------- weekly post-mortem

export async function runWeeklyPostMortem(): Promise<boolean> {
  const userId = await ownerId();
  if (!userId || !aiConfigured()) return false;
  const today = etParts().date;
  const eventKey = `ai-postmortem-${today}`;
  if (await alertExists(eventKey)) return false;

  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { data: orders } = await createAdminClient().from("paper_trade_orders")
    .select("created_at,action,underlying,contract_ticker,quantity,limit_price,status,signal_id,risk_snapshot")
    .eq("user_id", userId).gte("created_at", since).order("created_at", { ascending: true }).limit(200);
  const rows = (orders ?? []).map(row => {
    const snapshot = row.risk_snapshot as { exitReason?: string; manual?: boolean } | null;
    return `[${String(row.created_at).slice(0, 16)}Z] ${row.action} ${row.quantity}× ${row.contract_ticker} @ $${Number(row.limit_price).toFixed(2)} (${row.status})${snapshot?.exitReason ? ` exit=${snapshot.exitReason}` : ""}${row.signal_id ? "" : " [manual]"}`;
  });
  if (!rows.length) return false;

  const review = await chatComplete({
    system: "You write the weekly trading journal post-mortem for Velocity's paper/live book. From the order log, reconstruct round trips (buy_to_open matched to sell_to_close on the same contract) and write a 200-300 word plain-text narrative: which setups and exit reasons paid, which bled, manual vs engine entries, and ONE specific process observation for next week. Exit-reason vocabulary: premium_stop (stop loss), trail (trailing profit exit), no_follow_through (10-min momentum fail), time (mandatory close). Use ONLY the log; entry/exit limit prices approximate fills. Never invent P&L numbers — describe direction and pattern, and say when data is insufficient. Process critique only; no trade recommendations. The reader is a beginner: plain everyday English, explain each exit-reason term in simple words when first used (e.g. 'trailing profit exit — sold after giving back part of the gain from the peak').",
    user: `Order log, last 7 days (oldest first):\n${rows.join("\n")}`,
    maxTokens: 700,
  });

  await createAlert({ userId, eventKey, severity: "info", title: "Weekly journal post-mortem", body: review, metadata: { kind: "ai_postmortem", orderCount: rows.length } });
  return true;
}

// ---------------------------------------------------------------- noise digest

// Sweeps digest-tier alerts (flow skews, unusual-flow hits, watchlist chatter) that
// the instant dispatcher left pending, and turns them into ONE triaged Telegram
// message — or silence, when nothing is decision-relevant. Pending rows are marked
// notified either way so noise never piles up for a re-send.
export async function runNoiseDigest(): Promise<boolean> {
  const userId = await ownerId();
  if (!userId) return false;
  const clock = etParts();
  const eventKey = `ai-digest-${clock.date}-${String(clock.minutes).padStart(4, "0")}`;
  if (await alertExists(eventKey)) return false;

  const admin = createAdminClient();
  const { data: pending } = await admin.from("alerts")
    .select("id,event_key,severity,title,body,created_at")
    .is("notified_at", null)
    .order("created_at", { ascending: true })
    .limit(60);
  const digestRows = (pending ?? []).filter(row =>
    !["success", "critical"].includes(String(row.severity))
    && !String(row.event_key).startsWith("radar-")
    && !String(row.event_key).startsWith("ai-"));
  if (!digestRows.length) return false;

  const summary = await chatComplete({
    system: "You triage notification noise for an options trader mid-session. Input: system alerts (flow skews, unusual contract flow, watchlist events) accumulated over the last ~30 minutes. Write ONE compact digest (max 100 words, plain text): lead with anything decision-relevant — NEW one-sided skews, unusually large fresh positioning, clustering across related names, anything contradicting the current book — then compress or drop routine repeats (say 'plus N routine flow pings' rather than listing them). Use ONLY the data given; never invent numbers. Write for a beginner: plain everyday English, no unexplained jargon — 'bets the market falls' not 'bearish skew', 'expiring Monday' not '3DTE', sizes in dollars — and end with one short line saying whether anything needs doing (usually: nothing, information only). If nothing is decision-relevant, reply with exactly: SKIP",
    user: `Pending alerts (oldest first):\n${digestRows.map(row => `[${String(row.created_at).slice(11, 16)}Z ${row.severity}] ${row.title}: ${row.body}`).join("\n")}`,
    maxTokens: 350,
  });

  const now = new Date().toISOString();
  await admin.from("alerts").update({ notified_at: now }).in("id", digestRows.map(row => row.id));
  if (summary.trim().toUpperCase() === "SKIP") return false;
  await createAlert({ userId, eventKey, severity: "info", title: `Flow digest — ${digestRows.length} alerts triaged`, body: summary, metadata: { kind: "ai_digest", triaged: digestRows.length } });
  return true;
}

// ---------------------------------------------------------------- urgent escalation

// Every-5-minute peek at NEW digest-tier alerts with a deliberately high bar: if
// something is worth interrupting the trader now (unusually large fresh positioning,
// a new strong skew tied to SPY/SPX or open exposure, clustered same-direction flow
// across names), it goes to Telegram immediately instead of waiting for the
// half-hour sweep. HOLD leaves everything pending for the consolidated digest.
export async function runUrgentEscalation(): Promise<boolean> {
  const userId = await ownerId();
  if (!userId) return false;
  const clock = etParts();
  const eventKey = `ai-urgent-${clock.date}-${String(clock.minutes).padStart(4, "0")}`;
  if (await alertExists(eventKey)) return false;

  const admin = createAdminClient();
  const { data: pending } = await admin.from("alerts")
    .select("id,event_key,severity,title,body,created_at")
    .is("notified_at", null)
    .order("created_at", { ascending: true })
    .limit(60);
  const digestRows = (pending ?? []).filter(row =>
    !["success", "critical"].includes(String(row.severity))
    && !String(row.event_key).startsWith("radar-")
    && !String(row.event_key).startsWith("ai-"));
  // Only spend an LLM call when something NEW arrived since the last 5-minute check.
  const hasFresh = digestRows.some(row => Date.now() - new Date(String(row.created_at)).getTime() < 5.5 * 60_000);
  if (!digestRows.length || !hasFresh) return false;

  const verdict = await chatComplete({
    system: "You are the interrupt filter for an options trader mid-session. Input: held system alerts (flow skews, unusual contract flow, watchlist events). Decide if ANY of it justifies interrupting the trader RIGHT NOW rather than waiting up to 30 minutes for the routine digest. The bar is high — interrupt ONLY for: unusually large fresh positioning (size and aggression stand out even among unusual-flow alerts), a NEW strong skew in SPY/SPX, clustered same-direction flow across related names, or flow that directly contradicts what a holder of SPY/SPX calls or puts would want to see. Routine single-name flow pings are never worth an interrupt. If nothing qualifies, reply with exactly: HOLD. If something qualifies, reply with ONLY the alert message to send (max 60 words, plain text, lead with the single most important item). Use ONLY the data given; never invent numbers. Write for a beginner: everyday English, no unexplained jargon — 'big bets the market falls' not 'bearish flow', 'expiring Monday' not '3DTE' — and end by saying whether any action is needed (usually none — information only).",
    user: `Held alerts (oldest first):\n${digestRows.map(row => `[${String(row.created_at).slice(11, 16)}Z ${row.severity}] ${row.title}: ${row.body}`).join("\n")}`,
    maxTokens: 250,
  });
  if (verdict.trim().toUpperCase() === "HOLD") return false;

  // Send the interrupt and mark everything it saw — the half-hour digest then only
  // covers alerts that arrive after this point, so nothing is reported twice.
  await createAlert({ userId, eventKey, severity: "warning", title: "Flow interrupt — worth a look now", body: verdict.trim(), metadata: { kind: "ai_urgent", triaged: digestRows.length } });
  await admin.from("alerts").update({ notified_at: new Date().toISOString() }).in("id", digestRows.map(row => row.id));
  return true;
}

// -------------------------------------------------------- cron entry point

// Called by the every-minute cron. Fires the brief in the 9:15-9:29 ET window and the
// post-mortem Friday 16:45-16:59 ET; event-key checks make each a once-per-day action.
export async function maybeRunScheduledReviews(): Promise<string[]> {
  const clock = etParts();
  if (["Sat", "Sun"].includes(clock.weekday) || !aiConfigured()) return [];
  const userId = await ownerId();
  if (!userId) return [];
  const settings = await loadRiskSettings(userId);
  if (!settings.aiReviewEnabled) return [];
  const ran: string[] = [];
  if (clock.minutes >= 555 && clock.minutes < 570 && await runMorningBrief()) ran.push("morning-brief");
  if (clock.weekday === "Fri" && clock.minutes >= 1005 && clock.minutes < 1020 && await runWeeklyPostMortem()) ran.push("weekly-postmortem");
  // Noise digest: every 30 minutes at :05/:35 from 10:05 through the 16:35 sweep.
  // Deliberately OFF the :00/:30 marks — those are %15 ticks where the cron does its
  // heaviest chain refreshes and can hit the 60s ceiling before reaching this step.
  if (clock.minutes >= 605 && clock.minutes <= 995 && clock.minutes % 30 === 5 && await runNoiseDigest()) ran.push("noise-digest");
  // Urgent escalation: every 5 minutes between sweeps, high-bar interrupt check on
  // newly held alerts so genuinely important flow never waits the full half hour.
  else if (clock.minutes >= 575 && clock.minutes <= 990 && clock.minutes % 5 === 0 && await runUrgentEscalation()) ran.push("urgent-escalation");
  return ran;
}

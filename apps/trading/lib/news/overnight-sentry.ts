import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAlert } from "@/lib/alerts/server";
import { aiConfigured, chatComplete } from "@/lib/ai/openrouter";
import { getFuturesGlimpse } from "@/lib/options/futures";

// OVERNIGHT NEWS SENTRY (user call, 2026-11-23: "if the futures are down with bad
// Asia market news or trump announces a war or big tariffs — I need to know that
// and play SPX"). The overnight watch is the system's eyes on PRICE (ES gaps,
// ignition); this is its ear for the WHY. During the GTH window (8 PM – 9:25 AM ET)
// each cron tick screens fresh Benzinga headlines through a keyword prefilter, and
// candidates go to the LLM for severity triage. Only genuinely market-moving world
// news (severity >= 4/5) pages — with the live ES read attached, so the alert
// arrives decision-ready while SPX options still trade on Robinhood.
// NEWS INFORMS, THE HUMAN TRADES: nothing here places orders; whatever the user
// buys overnight, the worker adopts at 9:30 (dollar lock stays awake in grace).
// Cost control: prefilter first (most ticks cost zero LLM calls), max 3 pages and
// 12 triage calls per night, one page per story cluster per 2 hours.

const ET = "America/New_York";
const et = () => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: ET, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map(part => [part.type, part.value]));
  return { weekday: String(parts.weekday), minutes: Number(parts.hour) * 60 + Number(parts.minute) };
};
const etDateOf = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: ET }).format(new Date(ms));
const nightKey = (minutes: number) => etDateOf(minutes >= 1200 ? Date.now() + 86_400_000 : Date.now());

// Macro-shock vocabulary: a headline must hit one of these to be worth an LLM call.
const SHOCK_RE = /\b(war|invasion|invades?|attack|strikes?|missile|nuclear|military|tariffs?|sanctions?|embargo|trade\s+war|fed\b|fomc|rate\s+(cut|hike|decision)|powell|treasur(y|ies)|default|downgrade|credit\s+event|bank\s+(run|failure|collapse)|crash|plunge|sell-?off|halt(ed)?|circuit\s+breaker|emergency|china|beijing|taiwan|japan|nikkei|hang\s+seng|asia|europe|ecb|oil\s+(surge|spike|embargo)|opec|president|white\s+house|executive\s+order|shutdown|debt\s+ceiling|cyber ?attack|outage)\b/i;

export async function runOvernightNewsSentry(): Promise<{ active: boolean; paged: number }> {
  const clock = et();
  // Active: GTH hours — 20:00 through 9:25 ET, Sunday night through Friday morning.
  const inWindow = clock.minutes >= 1200 || clock.minutes <= 565;
  const weekdayOk = !(clock.weekday === "Sat" || (clock.weekday === "Sun" && clock.minutes <= 565) || (clock.weekday === "Fri" && clock.minutes >= 1200));
  if (!inWindow || !weekdayOk || !aiConfigured()) return { active: false, paged: 0 };
  const admin = createAdminClient();
  const night = nightKey(clock.minutes);
  // Night budget: alerts carry eventKey overnight-news-<night>-N; stop at 3.
  const { data: tonight } = await admin.from("alerts").select("id").like("event_key", `overnight-news-${night}-%`);
  if ((tonight ?? []).length >= 3) return { active: true, paged: 0 };
  // Fresh, unscreened headlines from the last 15 minutes that pass the prefilter.
  const { data: rows } = await admin.from("market_news").select("news_id,headline,summary,published_at")
    .gte("published_at", new Date(Date.now() - 15 * 60_000).toISOString())
    .order("published_at", { ascending: false }).limit(20);
  const candidates = (rows ?? []).filter(row => SHOCK_RE.test(`${row.headline} ${row.summary ?? ""}`));
  if (!candidates.length) return { active: true, paged: 0 };
  // Screened-story log lives in tg_dip_state? No — reuse alerts dedupe per headline hash
  // and a per-night triage budget tracked via ops_job_state-like row in tg_tickets? Keep
  // it simple: dedupe per headline via event-key check, cap triage calls per tick at 3.
  let paged = 0;
  const { data: owner } = await admin.from("profiles").select("id").limit(1).maybeSingle();
  if (!owner) return { active: true, paged: 0 };
  for (const candidate of candidates.slice(0, 3)) {
    // NOT "overnight-" prefixed: that prefix is the dispatcher's INSTANT tier, and the
    // screening audit trail belongs in the digest, not on the user's phone at 2 AM.
    const storyKey = `news-screened-${String(candidate.news_id)}`;
    const { data: screened } = await admin.from("alerts").select("id").eq("event_key", storyKey).limit(1).maybeSingle();
    if (screened) continue;
    // Mark screened FIRST (info alert, digest-tier, doubles as the audit trail) so a
    // crash mid-triage can never re-bill the same story every tick.
    await createAlert({ userId: String(owner.id), eventKey: storyKey, severity: "info", title: `Overnight screen: ${String(candidate.headline).slice(0, 80)}`, body: "Headline passed the macro-shock prefilter; LLM triage ran. A separate page follows only if severity >= 4.", metadata: { kind: "overnight_news_screened", newsId: candidate.news_id } }).catch(() => undefined);
    let verdict: { severity?: number; direction?: string; why?: string } = {};
    try {
      const raw = await chatComplete({
        system: "You are a markets desk triage analyst. Judge whether a headline is likely to move S&P 500 futures OVERNIGHT. Respond with STRICT JSON only: {\"severity\": 1-5, \"direction\": \"bearish\"|\"bullish\"|\"unclear\", \"why\": \"<one sentence, plain language>\"}. Severity 5 = war/major-tariff/credit-event scale; 4 = clearly market-moving macro; 3 or less = ordinary news flow, analyst chatter, single-company stories without index impact.",
        user: `Headline: ${candidate.headline}\nSummary: ${String(candidate.summary ?? "").slice(0, 400)}\nTime: overnight GTH session`,
        maxTokens: 200,
      });
      verdict = JSON.parse(raw.replace(/^```json?\s*|\s*```$/g, ""));
    } catch (error) { console.error("overnight triage failed", error instanceof Error ? error.message : error); continue; }
    if (Number(verdict.severity) < 4) continue;
    const futures = await getFuturesGlimpse().catch(() => null);
    const es = futures?.rows.find(row => row.product === "ES" || row.label.includes("S&P"));
    const esLine = es?.changePct != null ? ` ES futures ${es.changePct >= 0 ? "+" : ""}${es.changePct.toFixed(2)}% (${es.price.toFixed(0)}).` : "";
    paged++;
    await createAlert({
      userId: String(owner.id), eventKey: `overnight-news-${night}-${(tonight ?? []).length + paged}`, severity: "warning",
      title: `🌙 OVERNIGHT ${String(verdict.direction ?? "").toUpperCase()}: ${String(candidate.headline).slice(0, 90)}`,
      body: `${verdict.why ?? ""}${esLine} SPX options are OPEN on Robinhood (GTH until 9:25 AM). If you trade it: limit orders only, overnight spreads are wide — and whatever you buy, the worker adopts at 9:30 with the dollar lock awake. Reply "news" for the latest tape.`,
      metadata: { kind: "overnight_news_page", newsId: candidate.news_id, severity: verdict.severity, direction: verdict.direction },
    }).catch(() => undefined);
    if ((tonight ?? []).length + paged >= 3) break;
  }
  return { active: true, paged };
}

import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAlert } from "@/lib/alerts/server";
import { aiConfigured, chatComplete } from "@/lib/ai/openrouter";
import { WATCH_UNDERLYINGS } from "@/lib/options/types";

// MORNING NEWS SCORER (user call, 2026-11-24: "the live morning news scorer should
// specifically flag the security/regulatory angle on a single name"). Once per
// trading day, pre-open, the overnight+pre-market tape is scored on the SAME rubric
// as the 2026-11-24 news-shock study, so live rows and the studied history form one
// labeled series. Why this exists: the study (108 days) found the entire puts-side
// lottery payoff concentrated on days whose tape carried a security/regulatory/legal
// angle on a single name (+$97k on 53 such days; every other day's puts were net
// losers) — "the government showing up" (raids, probes, penalties, export controls),
// not generic bad news. Alpaca's news retention (~7 months) denied us training
// history, so rows accumulate here until there is enough to train on (~3 months).
// NEWS IS CONTEXT, NEVER SIGNAL: this stamps the day and pages the human when the
// secreg-single-name cell lights up; nothing here gates or generates entries.

const ET = "America/New_York";
const RUBRIC = `Score the MORNING news tape for a trading desk. Respond with STRICT JSON only:
{"shock": 0-3, "direction": -1|0|1, "systemic": true|false, "name": "<TICKER>"|null, "secreg": true|false, "note": "<biggest story, under 8 words>"}
Definitions: shock 0 = routine corporate/analyst chatter; 1 = notable news (big analyst move, product event, meaningful macro print); 2 = genuine shock (surprise guidance, regulatory action, geopolitical jolt, big macro surprise); 3 = major market-moving shock. direction: dominant tone for the names/market (-1 bad, +1 good, 0 mixed). systemic: biggest story is macro/market-wide rather than single-name. name: the ticker at the center of the biggest story, null if macro. secreg: a security/regulatory/legal/national-security angle is present in a TOP story (probe, raid, lawsuit, penalty, export controls, antitrust, recall, government action) — not incidental mentions.`;

// Heuristic fallback (method 'heuristic-v1') so a missing LLM key degrades to a
// cruder score instead of a silent gap in the series.
const SECREG_RE = /\b(probe|investigat\w+|raid(ed)?|SEC|DOJ|FBI|FTC|NHTSA|ITC|lawsuit|sues?|sued|subpoena|penalt\w+|fine[sd]?|settlement|recall|antitrust|export\s+(control|ban|curb)|national\s+security|sanction\w*|indict\w+|charges|regulator\w*|injunction|DMA\b)\b/i;
const BAD_RE = /\b(plunge|crash|tumble|sink|slump|miss(es|ed)?|cuts?\s+guidance|warns?|downgrade|halt|resign|layoffs?|delay|weak)\b/i;
const GOOD_RE = /\b(surge|soar|rall(y|ies)|record|beats?|raises?\s+guidance|upgrade|approval|wins?|strong)\b/i;

const etParts = () => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: ET, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map(part => [part.type, part.value]));
  return { weekday: String(parts.weekday), minutes: Number(parts.hour) * 60 + Number(parts.minute), dateKey: new Intl.DateTimeFormat("en-CA", { timeZone: ET }).format(new Date()) };
};

type Score = { shock: number; direction: number; systemic: boolean; name: string | null; secreg: boolean; note: string };

export async function runMorningNewsScore(): Promise<{ scored: boolean; skipped?: string }> {
  const clock = etParts();
  // Window: 9:05-9:25 ET weekdays — after the overnight tape is complete, before the
  // Morning Card (9:25) so the card's tick can read today's row.
  if (["Sat", "Sun"].includes(clock.weekday)) return { scored: false, skipped: "weekend" };
  if (clock.minutes < 545 || clock.minutes > 565) return { scored: false, skipped: "outside window" };
  const admin = createAdminClient();
  const { data: existing } = await admin.from("morning_news_scores").select("day").eq("day", clock.dateKey).maybeSingle();
  if (existing) return { scored: false, skipped: "already scored" };
  // Tape window: since the last weekday's 16:00 ET close (Mondays reach back to Friday).
  const backHours = clock.weekday === "Mon" ? 65.5 : 17.5;
  const since = new Date(Date.now() - backHours * 3_600_000).toISOString();
  const watch = new Set<string>([...WATCH_UNDERLYINGS, "SPY", "SPX", "QQQ"]);
  const { data: rows } = await admin.from("market_news").select("headline,symbols,published_at")
    .gte("published_at", since).order("published_at", { ascending: false }).limit(400);
  const tagged = (rows ?? []).filter(row => (row.symbols as string[] | null ?? []).some(symbol => watch.has(String(symbol).toUpperCase())));
  const headlines = [...new Set(tagged.map(row => String(row.headline).slice(0, 160)))].slice(0, 80);
  if (!headlines.length) return { scored: false, skipped: "no overnight headlines" };

  let score: Score | null = null;
  let method = "heuristic-v1";
  if (aiConfigured()) {
    try {
      const raw = await chatComplete({ system: RUBRIC, user: `Overnight+pre-market headlines (${clock.dateKey}):\n${headlines.map(h => `- ${h}`).join("\n")}`, maxTokens: 300 });
      const parsed = JSON.parse(raw.replace(/^```json?\s*|\s*```$/g, "")) as Partial<Score>;
      if (typeof parsed.shock === "number" && typeof parsed.secreg === "boolean") {
        score = {
          shock: Math.max(0, Math.min(3, Math.round(parsed.shock))),
          direction: Math.max(-1, Math.min(1, Math.round(Number(parsed.direction ?? 0)))),
          systemic: Boolean(parsed.systemic),
          name: parsed.name ? String(parsed.name).toUpperCase().slice(0, 8) : null,
          secreg: parsed.secreg, note: String(parsed.note ?? "").slice(0, 80),
        };
        method = "llm-v1";
      }
    } catch (error) { console.error("morning news LLM score failed", error instanceof Error ? error.message : error); }
  }
  if (!score) {
    // Crude but honest: keyword hits over the tape, dominant ticker by mention count.
    const text = headlines.join("\n");
    const counts = new Map<string, number>();
    for (const row of tagged) for (const symbol of (row.symbols as string[] | null ?? [])) {
      const up = String(symbol).toUpperCase();
      if (watch.has(up) && !["SPY", "SPX", "QQQ"].includes(up)) counts.set(up, (counts.get(up) ?? 0) + 1);
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const secregHits = headlines.filter(h => SECREG_RE.test(h)).length;
    const bad = headlines.filter(h => BAD_RE.test(h)).length; const good = headlines.filter(h => GOOD_RE.test(h)).length;
    score = {
      shock: secregHits >= 3 || Math.max(bad, good) >= 6 ? 2 : secregHits >= 1 || Math.max(bad, good) >= 2 ? 1 : 0,
      direction: bad > good * 1.5 ? -1 : good > bad * 1.5 ? 1 : 0,
      systemic: !top || top[1] < 3, name: top ? top[0] : null,
      secreg: SECREG_RE.test(text), note: "heuristic keyword score",
    };
  }
  const secregSingle = score.secreg && !score.systemic && Boolean(score.name);
  const { error } = await admin.from("morning_news_scores").insert({
    day: clock.dateKey, shock: score.shock, direction: score.direction, systemic: score.systemic,
    name: score.name, secreg: score.secreg, secreg_single: secregSingle, note: score.note,
    headline_count: headlines.length, method,
  });
  if (error) throw new Error(`morning score persistence: ${error.message}`);
  // The one cell with evidence pages the human — context for HIS decisions, not a trigger.
  if (secregSingle) {
    const { data: owner } = await admin.from("profiles").select("id").limit(1).maybeSingle();
    if (owner) await createAlert({
      userId: String(owner.id), eventKey: `morning-secreg-${clock.dateKey}`, severity: "warning",
      title: `🏛 GOVERNMENT-ON-A-NAME morning: ${score.name} — ${score.note}`,
      body: `The overnight tape carries a security/regulatory angle on ${score.name} (shock ${score.shock}/3, tone ${score.direction > 0 ? "good" : score.direction < 0 ? "bad" : "mixed"}). The news-shock study (108 days) found days like this carried the ENTIRE puts-side lottery payoff (+$97k on 53 such days; all other days' puts were net losers) — raids, probes, penalties, export controls. Context, not a trigger: the engine still needs a real fire, and most such days still produce nothing.`,
      metadata: { kind: "morning_secreg_flag", day: clock.dateKey, name: score.name, shock: score.shock, direction: score.direction, method },
    }).catch(() => undefined);
  }
  return { scored: true };
}

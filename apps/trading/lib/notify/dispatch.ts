import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { insightsChannelConfigured, sendTelegram, telegramConfigured } from "./telegram";

// Telegram dispatcher, run by the every-minute cron. Reads pending alerts from the
// alerts table (single source of truth — catches worker-written alerts too, which
// never pass through createAlert) and routes by tier:
//   INSTANT (sent immediately): fills/exits and failures (severity success/critical),
//     radar warnings (time-sensitive), and AI briefs/digests (already synthesized).
//   DIGEST (left pending): flow skews, unusual-flow hits, watchlist chatter — swept
//     into one LLM-triaged Telegram message every 30 minutes by runNoiseDigest().
// notified_at is the cursor: null = pending. Marked only after a successful send so
// transient Telegram failures retry next tick; rows older than the stale window are
// marked without sending to avoid replaying old backlog.

const STALE_MS = 6 * 3_600_000;

export function isInstantAlert(row: { severity: string; event_key: string }): boolean {
  return ["success", "critical"].includes(row.severity)
    || String(row.event_key).startsWith("radar-")
    || String(row.event_key).startsWith("ai-");
}

const ICON: Record<string, string> = { info: "ℹ️", success: "✅", warning: "⚠️", critical: "🚨" };

// Market-insight alerts safe for the shared subscriber channel: sector money maps,
// pre-market gaps, radar reads, overnight-scan verdicts, morning briefs. STRICT
// whitelist — errors, fills, positions, critiques, and post-mortems never match.
const INSIGHT_PREFIXES = ["radar-sectors-", "radar-sector-", "radar-gap-", "radar-trend-", "radar-regime-", "radar-event-", "radar-convexity-scan-", "radar-convexity-report-", "radar-surge-", "radar-metal-", "ai-brief-", "ai-rule-"];
export function isInsightAlert(eventKey: string): boolean {
  return INSIGHT_PREFIXES.some(prefix => eventKey.startsWith(prefix));
}

export async function dispatchInstantAlerts(): Promise<{ sent: number; digestPending: number }> {
  if (!telegramConfigured()) return { sent: 0, digestPending: 0 };
  const admin = createAdminClient();
  // Query the instant tier DIRECTLY — never slice the whole pending set, or a
  // digest-tier backlog starves critical alerts out of the fetch window.
  const { data: pending, error } = await admin.from("alerts")
    .select("id,event_key,severity,title,body,created_at")
    .is("notified_at", null)
    .or("severity.in.(success,critical),event_key.like.radar-%,event_key.like.ai-%")
    .order("created_at", { ascending: true })
    .limit(25);
  if (error) throw new Error(`Alert dispatch query failed: ${error.message}`);
  const { count: digestPending } = await admin.from("alerts")
    .select("id", { count: "exact", head: true }).is("notified_at", null);

  let sent = 0;
  const now = Date.now();
  for (const row of pending ?? []) {
    if (now - new Date(String(row.created_at)).getTime() > STALE_MS) {
      await admin.from("alerts").update({ notified_at: new Date().toISOString() }).eq("id", row.id);
      continue;
    }
    try {
      const message = `${ICON[String(row.severity)] ?? "ℹ️"} ${row.title}\n\n${row.body}`;
      await sendTelegram(message);
      // Mirror market insights to the shared channel; a channel failure never blocks
      // the owner's delivery or the cursor.
      if (insightsChannelConfigured() && isInsightAlert(String(row.event_key))) {
        await sendTelegram(message, process.env.TELEGRAM_INSIGHTS_CHAT_ID).catch(err => console.error("Insights channel send failed", row.event_key, err));
      }
      await admin.from("alerts").update({ notified_at: new Date().toISOString() }).eq("id", row.id);
      sent += 1;
    } catch (err) {
      console.error("Instant alert send failed (will retry)", row.event_key, err);
    }
  }
  return { sent, digestPending: Math.max((digestPending ?? 0) - (pending?.length ?? 0), 0) };
}

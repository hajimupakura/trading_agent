import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { telegramConfigured } from "@/lib/notify/telegram";
import { sendText } from "./api";

// Fill feedback for Telegram buys (user ask, 2026-11-23: "how do I know the buy was
// successful without going to Robinhood"). "✅ BUY submitted" means the limit order
// was PLACED, not filled. The worker sights every fill within seconds and registers
// it in rh_position_monitors — this cron hook closes the loop: 🎯 FILLED (quantity +
// average price) the minute the position appears, or ⏳ after 10 minutes with no
// position (limit resting below the market; gfd cancels it at day's end). Each
// notice fires once, flagged on the ticket's result payload.
export async function notifyTelegramFills(): Promise<{ notified: number }> {
  if (!telegramConfigured()) return { notified: 0 };
  const admin = createAdminClient();
  const { data: rows } = await admin.from("tg_tickets").select("id,payload,result,decided_at")
    .eq("kind", "buy").eq("status", "executed")
    .gte("decided_at", new Date(Date.now() - 45 * 60_000).toISOString());
  let notified = 0;
  for (const row of rows ?? []) {
    const result = (row.result ?? {}) as Record<string, unknown>;
    if (result.fillNotified) continue; // keep watching after a no-fill notice — a late fill still gets its 🎯
    const occ = String((row.payload as { ticker?: string }).ticker ?? "");
    if (!occ) continue;
    const { data: monitor } = await admin.from("rh_position_monitors").select("quantity,entry_price,status").eq("occ_ticker", occ).maybeSingle();
    const ageMs = Date.now() - Date.parse(String(row.decided_at));
    if (monitor && ["monitoring", "manual_hold", "closing"].includes(String(monitor.status)) && Number(monitor.quantity) > 0) {
      await sendText(`🎯 FILLED: ${Math.floor(Number(monitor.quantity))}× ${occ.replace("O:", "")} at $${Number(monitor.entry_price).toFixed(2)} average. Manual exit — /positions to manage it.`).catch(() => undefined);
      await admin.from("tg_tickets").update({ result: { ...result, fillNotified: true } }).eq("id", row.id);
      notified++;
    } else if (!result.noFillNotified && ageMs > 10 * 60_000) {
      await sendText(`⏳ No fill yet on ${occ.replace("O:", "")} (submitted ${Math.round(ageMs / 60_000)} min ago) — the limit is resting below the market. It cancels on its own at day's end if it never fills; I'll say 🎯 the moment it does.`).catch(() => undefined);
      await admin.from("tg_tickets").update({ result: { ...result, noFillNotified: true } }).eq("id", row.id);
      notified++;
    }
  }
  return { notified };
}

import { answerCallback, botChatId, editMessage, sendText } from "@/lib/telegram-bot/api";
import { executeBuyTicket, executeSell, setHold, skipTickets } from "@/lib/telegram-bot/execute";
import { handleCommand } from "@/lib/telegram-bot/commands";

// Telegram webhook: the bot's inbound half. Security is layered and FAIL CLOSED —
// no TELEGRAM_WEBHOOK_SECRET configured means no processing at all; a request
// without Telegram's secret header is rejected; and updates from any chat other
// than the owner's TELEGRAM_CHAT_ID are acknowledged and dropped (200 so Telegram
// doesn't retry them forever, but nothing executes).
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) return new Response("bot not configured", { status: 503 });
  if (request.headers.get("x-telegram-bot-api-secret-token") !== secret) return new Response("unauthorized", { status: 401 });
  const update = await request.json().catch(() => null);
  const ownerChat = botChatId();
  // Always answer 200 from here on: a non-200 makes Telegram redeliver the update,
  // and a redelivered buy callback is a double-execution hazard. Ticket claims are
  // the real idempotency; the 200 is belt-and-suspenders.
  try {
    if (update?.callback_query) {
      const callback = update.callback_query;
      if (String(callback.message?.chat?.id) !== String(ownerChat)) { await answerCallback(String(callback.id)); return Response.json({ ok: true }); }
      await answerCallback(String(callback.id), "Working…");
      const data = String(callback.data ?? "");
      const messageId = Number(callback.message?.message_id ?? 0);
      const originalText = String(callback.message?.text ?? "");
      const [verb, rest] = [data.slice(0, data.indexOf(":")), data.slice(data.indexOf(":") + 1)];
      let outcome: string | null = null;
      if (data === "noop") { await editMessage(messageId, `${originalText}\n\n— cancelled.`); return Response.json({ ok: true }); }
      if (verb === "cf") outcome = await executeBuyTicket(rest);
      else if (verb === "cx") outcome = await skipTickets(rest);
      else if (verb === "sa") outcome = await executeSell(rest, "all");
      else if (verb === "sh") outcome = await executeSell(rest, "half");
      else if (verb.startsWith("sn")) outcome = await executeSell(rest, Math.max(1, Number(verb.slice(2)) || 1));
      else if (verb === "co") { const { cancelRestingBuy } = await import("@/lib/telegram-bot/execute"); outcome = await cancelRestingBuy(rest); }
      else if (verb === "hd") outcome = await setHold(rest, true);
      else if (verb === "hb") outcome = await setHold(rest, false);
      if (outcome != null) {
        // Replace the card's buttons with the outcome so a handled card can't be re-tapped.
        await editMessage(messageId, `${originalText}\n\n${outcome || "Done."}`);
        // ALWAYS also answer as a NEW message (silent only for skips): an edit doesn't
        // notify and lands wherever the card sits in scroll history — on 2026-11-23
        // the user tapped a 17-min-old TSLA card, the stale refusal was appended to
        // the card far above the fold, and all they saw was the vanishing "Working…"
        // toast. Every executing tap must end in an explicit ✅/🛑/⌛ + reason at the
        // bottom of the chat.
        if (outcome && verb !== "cx") await sendText(outcome).catch(() => undefined);
      }
      return Response.json({ ok: true });
    }
    const message = update?.message;
    if (message) {
      if (String(message.chat?.id) !== String(ownerChat)) return Response.json({ ok: true });
      if (message.voice || message.audio) { await sendText("Voice commands are coming in the next phase — for now type it, e.g. \"buy 2 6900p\"."); return Response.json({ ok: true }); }
      if (typeof message.text === "string" && message.text.trim()) await handleCommand(message.text);
      return Response.json({ ok: true });
    }
  } catch (error) {
    console.error("telegram webhook failed", error instanceof Error ? error.message : error);
    await sendText(`⚠️ Bot error: ${error instanceof Error ? error.message.slice(0, 200) : "unknown"} — nothing was executed unless a ✅ message says so.`).catch(() => undefined);
  }
  return Response.json({ ok: true });
}

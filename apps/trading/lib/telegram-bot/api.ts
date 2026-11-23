import "server-only";

// Two-way Telegram surface for the trade bot: inline keyboards, message edits,
// callback answers. The one-way alert mirror in notify/telegram.ts stays untouched.
// Same env vars (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID); missing config no-ops.

export type InlineButton = { text: string; callback_data: string };

async function api(method: string, payload: Record<string, unknown>): Promise<any> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(8_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Telegram ${method} failed: ${response.status} ${String(body?.description ?? "").slice(0, 200)}`);
  return body?.result ?? null;
}

export function botChatId(): string | null { return process.env.TELEGRAM_CHAT_ID ?? null; }

export async function sendWithButtons(text: string, buttons: InlineButton[][]): Promise<number | null> {
  const chat = botChatId(); if (!chat) return null;
  const result = await api("sendMessage", { chat_id: chat, text: text.slice(0, 4000), disable_web_page_preview: true, reply_markup: { inline_keyboard: buttons } });
  return result?.message_id ?? null;
}

export async function sendText(text: string): Promise<void> {
  const chat = botChatId(); if (!chat) return;
  await api("sendMessage", { chat_id: chat, text: text.slice(0, 4000), disable_web_page_preview: true });
}

// Persistent reply keyboard: the four everyday actions always visible above the
// user's keyboard — nobody should have to memorize bot commands. Attached to the
// help reply once; Telegram keeps it in the chat from then on.
export async function sendTextWithMenu(text: string): Promise<void> {
  const chat = botChatId(); if (!chat) return;
  await api("sendMessage", {
    chat_id: chat, text: text.slice(0, 4000), disable_web_page_preview: true,
    reply_markup: { keyboard: [[{ text: "📊 Positions" }, { text: "🎯 Goal" }], [{ text: "📰 News" }, { text: "❓ Help" }]], resize_keyboard: true, is_persistent: true },
  });
}

// Edits are best-effort: a failed edit must never fail the trade it reports on.
export async function editMessage(messageId: number, text: string, buttons?: InlineButton[][]): Promise<void> {
  const chat = botChatId(); if (!chat || !messageId) return;
  await api("editMessageText", { chat_id: chat, message_id: messageId, text: text.slice(0, 4000), disable_web_page_preview: true, ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}) }).catch(() => undefined);
}

export async function answerCallback(callbackId: string, text?: string): Promise<void> {
  await api("answerCallbackQuery", { callback_query_id: callbackId, ...(text ? { text: text.slice(0, 180) } : {}) }).catch(() => undefined);
}

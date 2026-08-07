import "server-only";

// Telegram mirror for every in-app alert. Configure two env vars:
//   TELEGRAM_BOT_TOKEN — create a bot with @BotFather, copy the token.
//   TELEGRAM_CHAT_ID   — message your bot once, then open
//     https://api.telegram.org/bot<TOKEN>/getUpdates and copy message.chat.id.
// Missing config is a silent no-op so alert writes never fail because Telegram is unset.

export function telegramConfigured(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

export async function sendTelegram(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  // Telegram caps a message at 4096 characters.
  const body = text.length > 4000 ? `${text.slice(0, 3990)}…` : text;
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: body, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Telegram sendMessage failed: ${response.status}`);
}

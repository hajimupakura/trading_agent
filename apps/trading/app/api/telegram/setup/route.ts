import "server-only";

// One-time webhook registration (CRON_SECRET-guarded). Run after setting
// TELEGRAM_WEBHOOK_SECRET in Vercel:
//   curl -H "Authorization: Bearer $CRON_SECRET" https://<app>/api/telegram/setup
// Reads the bot token from env at runtime — the token never leaves the server.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) return new Response("Unauthorized", { status: 401 });
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const domain = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;
  if (!token || !secret || !domain) return Response.json({ error: `missing env: ${[!token && "TELEGRAM_BOT_TOKEN", !secret && "TELEGRAM_WEBHOOK_SECRET", !domain && "VERCEL_URL"].filter(Boolean).join(", ")}` }, { status: 400 });
  const url = `https://${domain}/api/telegram/webhook`;
  // ?info=1 — read-only diagnostic: returns getWebhookInfo (pending updates,
  // last_error_message/date) WITHOUT re-registering, which would drop pending
  // updates and destroy exactly the evidence a delivery problem leaves behind.
  if (new URL(request.url).searchParams.get("info")) {
    const infoOnly = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`).then(response => response.json()).catch(() => null);
    return Response.json({ webhookUrl: url, info: infoOnly?.result ?? null });
  }
  const set = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, secret_token: secret, allowed_updates: ["message", "callback_query"], drop_pending_updates: true }),
  }).then(response => response.json()).catch(error => ({ error: String(error) }));
  const info = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`).then(response => response.json()).catch(() => null);
  return Response.json({ webhookUrl: url, set, info: info?.result ?? null });
}

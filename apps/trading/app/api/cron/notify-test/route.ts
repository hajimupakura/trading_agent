import { sendTelegram, telegramConfigured } from "@/lib/notify/telegram";
import { aiConfigured, chatComplete } from "@/lib/ai/openrouter";

export const dynamic = "force-dynamic";

// One-shot plumbing check, CRON_SECRET-guarded: confirms the Telegram env vars work
// (sends a real test message) and reports whether the OpenRouter key is present.
export async function GET(request: Request) {
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const status = { telegramConfigured: telegramConfigured(), aiConfigured: aiConfigured(), telegramSent: false, telegramError: null as string | null, aiReply: null as string | null, aiError: null as string | null };
  if (status.aiConfigured) {
    try { status.aiReply = await chatComplete({ system: "Reply with exactly: OK", user: "ping", maxTokens: 10 }); }
    catch (error) { status.aiError = error instanceof Error ? error.message : String(error); }
  }
  if (status.telegramConfigured) {
    try {
      await sendTelegram("✅ Velocity → Telegram pipeline is live. Every alert (entries, exits, radar, flow, morning briefs, post-mortems) will mirror here.");
      status.telegramSent = true;
    } catch (error) {
      status.telegramError = error instanceof Error ? error.message : String(error);
    }
  }
  return Response.json(status);
}

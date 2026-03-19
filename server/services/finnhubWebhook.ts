import type { Express, Request, Response } from "express";

/**
 * Finnhub Webhook Handler
 *
 * Finnhub sends real-time push events to this endpoint when:
 * - Company news is published
 * - Earnings surprises occur
 * - Price alerts trigger
 * - SEC filings drop
 *
 * Authentication: every request contains header X-Finnhub-Secret
 * matching FINNHUB_WEBHOOK_SECRET env var.
 */

const WEBHOOK_SECRET = process.env.FINNHUB_WEBHOOK_SECRET;

interface FinnhubWebhookPayload {
  type: string;        // e.g. "news", "earnings", "price"
  data: any[];
}

export function registerFinnhubWebhook(app: Express) {
  app.post("/api/webhooks/finnhub", async (req: Request, res: Response) => {
    // 1. Authenticate — always respond 200 first to avoid Finnhub disabling the endpoint
    const secret = req.headers["x-finnhub-secret"];
    if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
      console.warn("[Finnhub Webhook] Invalid secret received:", secret);
      res.status(200).json({ ok: false, reason: "invalid_secret" });
      return;
    }

    // 2. Acknowledge receipt immediately (Finnhub requires 2xx before any processing)
    res.status(200).json({ ok: true });

    // 3. Process event asynchronously
    const payload = req.body as FinnhubWebhookPayload;
    if (!payload || !payload.type) return;

    console.log(`[Finnhub Webhook] Received event type: ${payload.type}`, JSON.stringify(payload).slice(0, 200));

    try {
      switch (payload.type) {
        case "news":
          await handleNewsEvent(payload.data);
          break;
        case "earnings":
          await handleEarningsEvent(payload.data);
          break;
        default:
          console.log(`[Finnhub Webhook] Unhandled event type: ${payload.type}`);
      }
    } catch (err: any) {
      console.error("[Finnhub Webhook] Error processing event:", err.message);
    }
  });

  console.log("[Finnhub Webhook] Registered at POST /api/webhooks/finnhub");
}

async function handleNewsEvent(items: any[]) {
  if (!Array.isArray(items) || items.length === 0) return;

  const { db } = await import("../db");
  const { newsArticles } = await import("../../drizzle/schema");

  let inserted = 0;
  for (const item of items) {
    if (!item.headline || !item.url) continue;
    try {
      await db.insert(newsArticles).ignore().values({
        title: item.headline,
        summary: item.summary || null,
        content: item.summary || item.headline,
        url: item.url,
        source: item.source || "Finnhub",
        publishedAt: item.datetime ? new Date(item.datetime * 1000) : new Date(),
        isAnalyzed: 0,
      });
      inserted++;
    } catch {
      // Duplicate url — already stored
    }
  }
  if (inserted > 0) {
    console.log(`[Finnhub Webhook] Stored ${inserted} new articles from push`);
  }
}

async function handleEarningsEvent(items: any[]) {
  if (!Array.isArray(items) || items.length === 0) return;
  // Log earnings surprises for the agent to pick up on next cycle
  for (const item of items) {
    console.log(`[Finnhub Webhook] Earnings: ${item.symbol} actual=${item.actual} est=${item.estimate} surprise=${item.surprise}%`);
  }
}

import { fetchAllRSSFeeds, RSSFeedItem } from "./rssFeedService";
import { analyzeNewsArticle } from "./sentimentAnalysis";
import { getDb } from "../db";
import { newsArticles } from "../../drizzle/schema";
import { eq } from "drizzle-orm";

/**
 * RSS News Sync Service
 * Fetches news from RSS feeds and schedules AI analysis
 */

/**
 * Sync news from RSS feeds (runs every 15 minutes)
 * Fetches headlines and stores them immediately without AI analysis
 */
export async function syncRSSNews(): Promise<{ added: number; skipped: number }> {
  try {
    const db = await getDb();
    if (!db) {
      console.warn("[RSS Sync] Database not available");
      return { added: 0, skipped: 0 };
    }

    // Fetch all RSS feeds
    const rssItems = await fetchAllRSSFeeds();
    console.log(`[RSS Sync] Fetched ${rssItems.length} articles from RSS feeds`);

    let added = 0;
    let skipped = 0;

    for (const item of rssItems) {
      try {
        // Check if article already exists by URL
        const existing = await db
          .select()
          .from(newsArticles)
          .where(eq(newsArticles.url, item.link))
          .limit(1);

        if (existing.length > 0) {
          skipped++;
          continue;
        }

        // Insert new article without AI analysis
        await db.insert(newsArticles).values({
          title: item.title,
          summary: item.summary || null,
          content: item.content || null,
          url: item.link,
          source: item.source,
          publishedAt: item.pubDate,
          scrapedAt: new Date(),
          isAnalyzed: 0, // Mark as pending analysis
          sentiment: null,
          potentialTerm: null,
          aiSummary: null,
          mentionedStocks: null,
          sectors: null,
          rallyIndicator: "none",
        });

        added++;
      } catch (error) {
        console.error(`[RSS Sync] Error inserting article:`, error);
      }
    }

    console.log(`[RSS Sync] Added ${added} new articles, skipped ${skipped} existing`);
    return { added, skipped };
  } catch (error) {
    console.error("[RSS Sync] Error syncing RSS news:", error);
    return { added: 0, skipped: 0 };
  }
}

/**
 * Analyze pending news articles with AI (runs every 30 minutes during market hours)
 * Only analyzes articles that haven't been analyzed yet
 */
export async function analyzePendingNews(): Promise<{ analyzed: number; failed: number }> {
  try {
    const db = await getDb();
    if (!db) {
      console.warn("[AI Analysis] Database not available");
      return { analyzed: 0, failed: 0 };
    }

    // Get all unanalyzed articles
    const pending = await db
      .select()
      .from(newsArticles)
      .where(eq(newsArticles.isAnalyzed, 0))
      .limit(50); // Process up to 50 articles per run

    if (pending.length === 0) {
      console.log("[AI Analysis] No pending articles to analyze");
      return { analyzed: 0, failed: 0 };
    }

    console.log(`[AI Analysis] Analyzing ${pending.length} pending articles`);

    let analyzed = 0;
    let failed = 0;

    for (const article of pending) {
      try {
        // Analyze with AI
        const analysis = await analyzeNewsArticle({
          title: article.title,
          summary: article.summary,
          content: article.content,
        });

        // Update article with AI analysis results
        await db
          .update(newsArticles)
          .set({
            isAnalyzed: 1,
            aiSummary: analysis.aiSummary,
            sentiment: analysis.sentiment,
            potentialTerm: analysis.potentialTerm,
            mentionedStocks: JSON.stringify(analysis.mentionedStocks),
            sectors: JSON.stringify(analysis.sectors),
            rallyIndicator: analysis.rallyIndicator,
            predictionConfidence: analysis.confidence,
          })
          .where(eq(newsArticles.id, article.id));

        analyzed++;

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        console.error(`[AI Analysis] Error analyzing article ${article.id}:`, error);
        failed++;
      }
    }

    console.log(`[AI Analysis] Analyzed ${analyzed} articles, ${failed} failed`);
    return { analyzed, failed };
  } catch (error) {
    console.error("[AI Analysis] Error analyzing pending news:", error);
    return { analyzed: 0, failed: 0 };
  }
}

/**
 * Check if current time is during market hours (8 AM - 4 PM EST)
 */
export function isMarketHours(): boolean {
  const now = new Date();
  const estTime = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const hour = estTime.getHours();
  
  // Market hours: 8 AM - 4 PM EST (Monday-Friday)
  const day = estTime.getDay();
  const isWeekday = day >= 1 && day <= 5;
  const isDuringHours = hour >= 8 && hour < 16;
  
  return isWeekday && isDuringHours;
}

/**
 * Main sync function that should be called on a schedule
 * - RSS sync: Every 15 minutes (always)
 * - AI analysis: Every 30 minutes during market hours only
 */
export async function scheduledNewsSync(includeAnalysis: boolean = false) {
  console.log("[Scheduled Sync] Starting news sync...");
  
  // Always sync RSS feeds
  const syncResult = await syncRSSNews();
  console.log(`[Scheduled Sync] RSS sync complete: ${syncResult.added} added, ${syncResult.skipped} skipped`);
  
  // Only run AI analysis if requested and during market hours
  if (includeAnalysis && isMarketHours()) {
    console.log("[Scheduled Sync] Running AI analysis (market hours)...");
    const analysisResult = await analyzePendingNews();
    console.log(`[Scheduled Sync] AI analysis complete: ${analysisResult.analyzed} analyzed, ${analysisResult.failed} failed`);
  } else if (includeAnalysis) {
    console.log("[Scheduled Sync] Skipping AI analysis (outside market hours)");
  }
}

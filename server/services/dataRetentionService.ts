import { getDb } from "../db";
import { newsArticles, arkTrades, alerts, sectorMomentum, stockHistoricalCandles, rallyEvents } from "../../drizzle/schema";
import { lt, and, eq } from "drizzle-orm";

/**
 * Data Retention Service
 * Manages database cleanup to prevent unbounded growth
 * 
 * Budget-friendly retention policy:
 * - News articles: Keep 30 days (analyzed) + 7 days (unanalyzed)
 * - ARK trades: Keep 90 days
 * - Sector momentum: Keep 60 days
 * - Stock candles: Keep 90 days
 * - Rally events: Keep predictions for 180 days, historical forever
 * - Alerts: Keep 30 days (read) + 90 days (unread)
 */

export interface RetentionStats {
  newsArticles: { deleted: number; retained: number };
  arkTrades: { deleted: number; retained: number };
  alerts: { deleted: number; retained: number };
  sectorMomentum: { deleted: number; retained: number };
  stockCandles: { deleted: number; retained: number };
  rallyEvents: { deleted: number; retained: number };
}

/**
 * Clean up old news articles based on retention policy
 * - Analyzed articles: Keep 30 days
 * - Unanalyzed articles: Keep 7 days (they might be outdated or broken)
 */
export async function cleanupNewsArticles(): Promise<{ deleted: number; retained: number }> {
  const db = await getDb();
  if (!db) {
    console.warn("[Retention] Database not available");
    return { deleted: 0, retained: 0 };
  }

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  try {
    // Delete analyzed articles older than 30 days
    const analyzedDeleted = await db
      .delete(newsArticles)
      .where(
        and(
          eq(newsArticles.isAnalyzed, 1),
          lt(newsArticles.publishedAt, thirtyDaysAgo)
        )
      )
      .returning({ id: newsArticles.id });

    // Delete unanalyzed articles older than 7 days (likely stale/broken)
    const unanalyzedDeleted = await db
      .delete(newsArticles)
      .where(
        and(
          eq(newsArticles.isAnalyzed, 0),
          lt(newsArticles.publishedAt, sevenDaysAgo)
        )
      )
      .returning({ id: newsArticles.id });

    const totalDeleted = analyzedDeleted.length + unanalyzedDeleted.length;

    // Get count of retained articles
    const retained = await db
      .select({ count: newsArticles.id })
      .from(newsArticles);

    console.log(`[Retention] News: Deleted ${totalDeleted} old articles (${analyzedDeleted.length} analyzed, ${unanalyzedDeleted.length} unanalyzed)`);

    return { deleted: totalDeleted, retained: retained.length };
  } catch (error) {
    console.error("[Retention] Error cleaning news articles:", error);
    return { deleted: 0, retained: 0 };
  }
}

/**
 * Clean up old ARK trades (keep 90 days)
 * Historical context is useful but older than 90 days has diminishing returns
 */
export async function cleanupArkTrades(): Promise<{ deleted: number; retained: number }> {
  const db = await getDb();
  if (!db) return { deleted: 0, retained: 0 };

  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

  try {
    const deleted = await db
      .delete(arkTrades)
      .where(lt(arkTrades.tradeDate, ninetyDaysAgo))
      .returning({ id: arkTrades.id });

    const retained = await db
      .select({ count: arkTrades.id })
      .from(arkTrades);

    console.log(`[Retention] ARK Trades: Deleted ${deleted.length} old trades`);

    return { deleted: deleted.length, retained: retained.length };
  } catch (error) {
    console.error("[Retention] Error cleaning ARK trades:", error);
    return { deleted: 0, retained: 0 };
  }
}

/**
 * Clean up old alerts
 * - Read alerts: Keep 30 days
 * - Unread alerts: Keep 90 days (user might want to see them)
 */
export async function cleanupAlerts(): Promise<{ deleted: number; retained: number }> {
  const db = await getDb();
  if (!db) return { deleted: 0, retained: 0 };

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

  try {
    // Delete read alerts older than 30 days
    const readDeleted = await db
      .delete(alerts)
      .where(
        and(
          eq(alerts.isRead, true),
          lt(alerts.createdAt, thirtyDaysAgo)
        )
      )
      .returning({ id: alerts.id });

    // Delete unread alerts older than 90 days
    const unreadDeleted = await db
      .delete(alerts)
      .where(
        and(
          eq(alerts.isRead, false),
          lt(alerts.createdAt, ninetyDaysAgo)
        )
      )
      .returning({ id: alerts.id });

    const totalDeleted = readDeleted.length + unreadDeleted.length;

    const retained = await db
      .select({ count: alerts.id })
      .from(alerts);

    console.log(`[Retention] Alerts: Deleted ${totalDeleted} old alerts (${readDeleted.length} read, ${unreadDeleted.length} unread)`);

    return { deleted: totalDeleted, retained: retained.length };
  } catch (error) {
    console.error("[Retention] Error cleaning alerts:", error);
    return { deleted: 0, retained: 0 };
  }
}

/**
 * Clean up old sector momentum data (keep 60 days)
 * Recent trends are most relevant for trading decisions
 */
export async function cleanupSectorMomentum(): Promise<{ deleted: number; retained: number }> {
  const db = await getDb();
  if (!db) return { deleted: 0, retained: 0 };

  const sixtyDaysAgo = new Date();
  sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);

  try {
    const deleted = await db
      .delete(sectorMomentum)
      .where(lt(sectorMomentum.date, sixtyDaysAgo))
      .returning({ id: sectorMomentum.id });

    const retained = await db
      .select({ count: sectorMomentum.id })
      .from(sectorMomentum);

    console.log(`[Retention] Sector Momentum: Deleted ${deleted.length} old records`);

    return { deleted: deleted.length, retained: retained.length };
  } catch (error) {
    console.error("[Retention] Error cleaning sector momentum:", error);
    return { deleted: 0, retained: 0 };
  }
}

/**
 * Clean up old stock historical candles (keep 90 days)
 * Technical analysis beyond 90 days uses different data sources
 */
export async function cleanupStockCandles(): Promise<{ deleted: number; retained: number }> {
  const db = await getDb();
  if (!db) return { deleted: 0, retained: 0 };

  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

  try {
    const deleted = await db
      .delete(stockHistoricalCandles)
      .where(lt(stockHistoricalCandles.lastUpdated, ninetyDaysAgo))
      .returning({ id: stockHistoricalCandles.id });

    const retained = await db
      .select({ count: stockHistoricalCandles.id })
      .from(stockHistoricalCandles);

    console.log(`[Retention] Stock Candles: Deleted ${deleted.length} old records`);

    return { deleted: deleted.length, retained: retained.length };
  } catch (error) {
    console.error("[Retention] Error cleaning stock candles:", error);
    return { deleted: 0, retained: 0 };
  }
}

/**
 * Clean up old rally event predictions (keep 180 days)
 * Keep historical rallies forever for pattern learning
 * Only delete predicted/potential rallies that are old
 */
export async function cleanupRallyEvents(): Promise<{ deleted: number; retained: number }> {
  const db = await getDb();
  if (!db) return { deleted: 0, retained: 0 };

  const oneEightyDaysAgo = new Date();
  oneEightyDaysAgo.setDate(oneEightyDaysAgo.getDate() - 180);

  try {
    // Only delete predicted/potential rallies older than 180 days
    // Keep historical rallies (is_historical = true) forever
    const deleted = await db
      .delete(rallyEvents)
      .where(
        and(
          eq(rallyEvents.isHistorical, false),
          lt(rallyEvents.createdAt, oneEightyDaysAgo)
        )
      )
      .returning({ id: rallyEvents.id });

    const retained = await db
      .select({ count: rallyEvents.id })
      .from(rallyEvents);

    console.log(`[Retention] Rally Events: Deleted ${deleted.length} old predictions (kept historical)`);

    return { deleted: deleted.length, retained: retained.length };
  } catch (error) {
    console.error("[Retention] Error cleaning rally events:", error);
    return { deleted: 0, retained: 0 };
  }
}

/**
 * Run all retention cleanup tasks
 * Should be scheduled to run daily during off-peak hours
 */
export async function runDataRetentionCleanup(): Promise<RetentionStats> {
  console.log("[Retention] Starting data retention cleanup...");

  const stats: RetentionStats = {
    newsArticles: await cleanupNewsArticles(),
    arkTrades: await cleanupArkTrades(),
    alerts: await cleanupAlerts(),
    sectorMomentum: await cleanupSectorMomentum(),
    stockCandles: await cleanupStockCandles(),
    rallyEvents: await cleanupRallyEvents(),
  };

  const totalDeleted = 
    stats.newsArticles.deleted +
    stats.arkTrades.deleted +
    stats.alerts.deleted +
    stats.sectorMomentum.deleted +
    stats.stockCandles.deleted +
    stats.rallyEvents.deleted;

  console.log(`[Retention] Cleanup complete! Total records deleted: ${totalDeleted}`);
  console.log(`[Retention] Summary:`, JSON.stringify(stats, null, 2));

  return stats;
}

/**
 * Get current database statistics (for monitoring)
 */
export async function getDatabaseStats() {
  const db = await getDb();
  if (!db) return null;

  try {
    const news = await db.select({ count: newsArticles.id }).from(newsArticles);
    const trades = await db.select({ count: arkTrades.id }).from(arkTrades);
    const userAlerts = await db.select({ count: alerts.id }).from(alerts);
    const momentum = await db.select({ count: sectorMomentum.id }).from(sectorMomentum);
    const candles = await db.select({ count: stockHistoricalCandles.id }).from(stockHistoricalCandles);
    const rallies = await db.select({ count: rallyEvents.id }).from(rallyEvents);

    return {
      newsArticles: news.length,
      arkTrades: trades.length,
      alerts: userAlerts.length,
      sectorMomentum: momentum.length,
      stockCandles: candles.length,
      rallyEvents: rallies.length,
      total: news.length + trades.length + userAlerts.length + momentum.length + candles.length + rallies.length,
    };
  } catch (error) {
    console.error("[Retention] Error getting database stats:", error);
    return null;
  }
}

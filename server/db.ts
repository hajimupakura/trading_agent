import { eq, sql, desc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import {
  InsertUser,
  users,
  newsArticles,
  InsertNewsArticle,
  watchlistStocks,
  InsertWatchlistStock,
  arkTrades,
  InsertArkTrade,
  alerts,
  InsertAlert,
  rallyEvents,
  InsertRallyEvent,
  sectorMomentum,
  InsertSectorMomentum,
  userPreferences,
  InsertUserPreference,
  priceSnapshots,
  InsertPriceSnapshot,
  portfolios,
  InsertPortfolio,
  positions,
  InsertPosition,
  tradesLog,
  InsertTradeLog,
  agentCycleLogs,
  InsertAgentCycleLog,
  agentConfig,
} from "../drizzle/schema";
import { ENV } from './_core/env';

let _db: ReturnType<typeof drizzle> | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = 'admin';
      updateSet.role = 'admin';
    }
    if (user.passwordHash !== undefined) {
      values.passwordHash = user.passwordHash;
      updateSet.passwordHash = user.passwordHash;
    }
    if (user.resetToken !== undefined) {
      values.resetToken = user.resetToken;
      updateSet.resetToken = user.resetToken;
    }
    if (user.resetTokenExpiresAt !== undefined) {
      values.resetTokenExpiresAt = user.resetTokenExpiresAt;
      updateSet.resetTokenExpiresAt = user.resetTokenExpiresAt;
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

export async function setResetToken(openId: string, token: string, expiresAt: Date): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(users)
    .set({ resetToken: token, resetTokenExpiresAt: expiresAt })
    .where(eq(users.openId, openId));
}

export async function getUserByResetToken(token: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users)
    .where(eq(users.resetToken, token))
    .limit(1);
  return result.length > 0 ? result[0] : undefined;
}

// News Articles
export async function insertNewsArticle(article: InsertNewsArticle) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.insert(newsArticles).values(article);
  return result;
}

export async function getRecentNews(limit: number = 50, sector?: string) {
  const db = await getDb();
  if (!db) return [];
  
  let query = db.select().from(newsArticles).orderBy(desc(newsArticles.publishedAt)).$dynamic();
  
  return await query.limit(limit);
}

export async function getNewsByDateRange(startDate: Date, endDate: Date) {
  const db = await getDb();
  if (!db) return [];
  
  return await db.select().from(newsArticles)
    .where(sql`${newsArticles.publishedAt} BETWEEN ${startDate} AND ${endDate}`)
    .orderBy(desc(newsArticles.publishedAt));
}

// Watchlist
export async function getUserWatchlist(userId: number) {
  const db = await getDb();
  if (!db) return [];
  
  return await db.select().from(watchlistStocks)
    .where(eq(watchlistStocks.userId, userId))
    .orderBy(watchlistStocks.isPriority, watchlistStocks.addedAt);
}

export async function addToWatchlist(stock: InsertWatchlistStock) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  return await db.insert(watchlistStocks).values(stock);
}

export async function removeFromWatchlist(id: number, userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  return await db.delete(watchlistStocks)
    .where(sql`${watchlistStocks.id} = ${id} AND ${watchlistStocks.userId} = ${userId}`);
}

// ARK Trades
export async function insertArkTrade(trade: InsertArkTrade) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  return await db.insert(arkTrades).values(trade);
}

export async function getRecentArkTrades(limit: number = 100) {
  const db = await getDb();
  if (!db) return [];
  
  return await db.select().from(arkTrades)
    .orderBy(desc(arkTrades.tradeDate))
    .limit(limit);
}

export async function getArkTradesByTicker(ticker: string, limit: number = 50) {
  const db = await getDb();
  if (!db) return [];

  return await db.select().from(arkTrades)
    .where(eq(arkTrades.ticker, ticker))
    .orderBy(desc(arkTrades.tradeDate))
    .limit(limit);
}

// Alerts
export async function createAlert(alert: InsertAlert) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  return await db.insert(alerts).values(alert);
}

export async function getUserAlerts(userId: number, unreadOnly: boolean = false) {
  const db = await getDb();
  if (!db) return [];
  
  if (unreadOnly) {
    return await db.select().from(alerts)
      .where(sql`${alerts.userId} = ${userId} AND ${alerts.isRead} = 0`)
      .orderBy(desc(alerts.createdAt))
      .limit(100);
  }

  return await db.select().from(alerts)
    .where(eq(alerts.userId, userId))
    .orderBy(desc(alerts.createdAt))
    .limit(100);
}

export async function markAlertAsRead(alertId: number, userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  return await db.update(alerts)
    .set({ isRead: 1 })
    .where(sql`${alerts.id} = ${alertId} AND ${alerts.userId} = ${userId}`);
}

// Rally Events
export async function insertRallyEvent(event: InsertRallyEvent) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  return await db.insert(rallyEvents).values(event);
}

export async function getRallyEvents(status?: "ongoing" | "ended" | "potential") {
  const db = await getDb();
  if (!db) return [];
  
  let query = db.select().from(rallyEvents).$dynamic();
  
  if (status) {
    query = query.where(eq(rallyEvents.status, status));
  }
  
  return await query.orderBy(desc(rallyEvents.startDate));
}

// Sector Momentum
export async function insertSectorMomentum(momentum: InsertSectorMomentum) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  return await db.insert(sectorMomentum).values(momentum);
}

export async function getLatestSectorMomentum() {
  const db = await getDb();
  if (!db) return [];
  
  // Get the most recent momentum for each sector
  return await db.select().from(sectorMomentum)
    .orderBy(desc(sectorMomentum.date))
    .limit(50);
}

// User Preferences
export async function getUserPreferences(userId: number) {
  const db = await getDb();
  if (!db) return undefined;
  
  const result = await db.select().from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  
  return result.length > 0 ? result[0] : undefined;
}

export async function upsertUserPreferences(prefs: InsertUserPreference) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  return await db.insert(userPreferences).values(prefs)
    .onDuplicateKeyUpdate({
      set: {
        refreshSchedule: prefs.refreshSchedule,
        alertThreshold: prefs.alertThreshold,
        enableEmailAlerts: prefs.enableEmailAlerts,
        watchedSectors: prefs.watchedSectors,
        maxPositionPct: prefs.maxPositionPct,
        maxSectorPct: prefs.maxSectorPct,
        stopLossPct: prefs.stopLossPct,
        takeProfitPct: prefs.takeProfitPct,
        maxDrawdownPct: prefs.maxDrawdownPct,
        maxOpenPositions: prefs.maxOpenPositions,
      }
    });
}

// YouTube influencer queries
export async function insertYoutubeInfluencer(influencer: any) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const { youtubeInfluencers } = await import("../drizzle/schema");
  return await db.insert(youtubeInfluencers).values(influencer);
}

export async function getUserYoutubeInfluencers(userId: number) {
  const db = await getDb();
  if (!db) return [];
  const { youtubeInfluencers } = await import("../drizzle/schema");
  return await db.select().from(youtubeInfluencers).where(eq(youtubeInfluencers.userId, userId));
}

export async function insertYoutubeVideo(video: any) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const { youtubeVideos } = await import("../drizzle/schema");
  return await db.insert(youtubeVideos).values(video);
}

export async function getRecentYoutubeVideos(limit: number = 20) {
  const db = await getDb();
  if (!db) return [];
  const { youtubeVideos, youtubeInfluencers } = await import("../drizzle/schema");
  const { desc } = await import("drizzle-orm");
  
  return await db
    .select({
      video: youtubeVideos,
      influencer: youtubeInfluencers,
    })
    .from(youtubeVideos)
    .leftJoin(youtubeInfluencers, eq(youtubeVideos.influencerId, youtubeInfluencers.id))
    .orderBy(desc(youtubeVideos.publishedAt))
    .limit(limit);
}

// Rally prediction queries
export async function getHistoricalRallies() {
  const db = await getDb();
  if (!db) return [];
  return await db.select().from(rallyEvents).where(eq(rallyEvents.isHistorical, 1));
}

export async function getPredictedRallies() {
  const db = await getDb();
  if (!db) return [];
  return await db.select().from(rallyEvents).where(eq(rallyEvents.status, "predicted"));
}

export async function insertRallyPrediction(prediction: any) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return await db.insert(rallyEvents).values({
    ...prediction,
    status: "predicted",
    isHistorical: 0,
  });
}

// Price Snapshots
export async function insertPriceSnapshot(snapshot: InsertPriceSnapshot) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return await db.insert(priceSnapshots).values(snapshot);
}

export async function insertPriceSnapshots(snapshots: InsertPriceSnapshot[]) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  if (snapshots.length === 0) return;
  return await db.insert(priceSnapshots).values(snapshots);
}

export async function getPriceHistory(symbol: string, limit: number = 288) {
  // 288 = 24 hours at 5-min intervals
  const db = await getDb();
  if (!db) return [];

  return await db.select().from(priceSnapshots)
    .where(eq(priceSnapshots.symbol, symbol.toUpperCase()))
    .orderBy(desc(priceSnapshots.capturedAt))
    .limit(limit);
}

// ── Portfolios ──────────────────────────────────────────────────────────────

export async function createPortfolio(portfolio: InsertPortfolio) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return await db.insert(portfolios).values(portfolio);
}

export async function getUserPortfolios(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return await db.select().from(portfolios)
    .where(eq(portfolios.userId, userId))
    .orderBy(desc(portfolios.createdAt));
}

export async function getPortfolioById(id: number, userId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(portfolios)
    .where(sql`${portfolios.id} = ${id} AND ${portfolios.userId} = ${userId}`)
    .limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function updatePortfolioCash(id: number, newBalance: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return await db.update(portfolios)
    .set({ cashBalance: newBalance })
    .where(eq(portfolios.id, id));
}

// ── Positions ───────────────────────────────────────────────────────────────

export async function getPortfolioPositions(portfolioId: number) {
  const db = await getDb();
  if (!db) return [];
  return await db.select().from(positions)
    .where(eq(positions.portfolioId, portfolioId))
    .orderBy(desc(positions.openedAt));
}

export async function getPositionBySymbol(portfolioId: number, symbol: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(positions)
    .where(sql`${positions.portfolioId} = ${portfolioId} AND ${positions.symbol} = ${symbol}`)
    .limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function insertPosition(position: InsertPosition) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return await db.insert(positions).values(position);
}

export async function updatePosition(id: number, updates: { quantity?: number; avgEntryPrice?: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return await db.update(positions).set(updates).where(eq(positions.id, id));
}

export async function deletePosition(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return await db.delete(positions).where(eq(positions.id, id));
}

// ── Trade Log ───────────────────────────────────────────────────────────────

export async function insertTradeLog(trade: InsertTradeLog) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return await db.insert(tradesLog).values(trade);
}

export async function getPortfolioTradeHistory(portfolioId: number, limit: number = 100) {
  const db = await getDb();
  if (!db) return [];
  return await db.select().from(tradesLog)
    .where(eq(tradesLog.portfolioId, portfolioId))
    .orderBy(desc(tradesLog.executedAt))
    .limit(limit);
}

// ── Agent Cycle Logs ────────────────────────────────────────────────────────

export async function insertAgentCycleLog(log: InsertAgentCycleLog) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return await db.insert(agentCycleLogs).values(log);
}

export async function getAgentCycleLogs(limit: number = 20) {
  const db = await getDb();
  if (!db) return [];
  return await db.select().from(agentCycleLogs)
    .orderBy(desc(agentCycleLogs.createdAt))
    .limit(limit);
}

export async function getTodaysCycleLogs() {
  const db = await getDb();
  if (!db) return [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return await db.select().from(agentCycleLogs)
    .where(sql`${agentCycleLogs.createdAt} >= ${today}`)
    .orderBy(desc(agentCycleLogs.createdAt));
}

// ── Agent Config (key-value) ────────────────────────────────────────────────

export async function getAgentConfigValue(key: string): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;
  const result = await db.select().from(agentConfig)
    .where(eq(agentConfig.key, key))
    .limit(1);
  return result.length > 0 ? result[0]!.value : null;
}

export async function setAgentConfigValue(key: string, value: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(agentConfig).values({ key, value })
    .onDuplicateKeyUpdate({ set: { value } });
}

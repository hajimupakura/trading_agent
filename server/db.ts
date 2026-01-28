import { eq, sql, desc, count } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
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
  stockFinancials,
  InsertStockFinancials,
  stockHistoricalCandles,
  InsertStockHistoricalCandle,
  userDefinedAlerts,
  InsertUserDefinedAlert,
} from "../drizzle/schema";
import { ENV } from './_core/env';

let _db: ReturnType<typeof drizzle> | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      const client = postgres(process.env.DATABASE_URL);
      _db = drizzle(client);
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
    .orderBy(arkTrades.tradeDate)
    .limit(limit);
}

export async function getArkTradesByTicker(ticker: string, limit: number = 50) {
  const db = await getDb();
  if (!db) return [];
  
  return await db.select().from(arkTrades)
    .where(eq(arkTrades.ticker, ticker))
    .orderBy(arkTrades.tradeDate)
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
      .orderBy(alerts.createdAt)
      .limit(100);
  }
  
  return await db.select().from(alerts)
    .where(eq(alerts.userId, userId))
    .orderBy(alerts.createdAt)
    .limit(100);
}

export async function markAlertAsRead(alertId: number, userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  return await db.update(alerts)
    .where(sql`${alerts.id} = ${alertId} AND ${alerts.userId} = ${userId}`);
}

// User Defined Alerts
export async function getUserDefinedAlerts(userId: number, status: "active" | "triggered" | "inactive" = "active") {
  const db = await getDb();
  if (!db) return [];

  return await db.select().from(userDefinedAlerts)
    .where(sql`${userDefinedAlerts.userId} = ${userId} AND ${userDefinedAlerts.status} = ${status}`)
    .orderBy(desc(userDefinedAlerts.createdAt));
}

export async function insertUserDefinedAlert(alert: InsertUserDefinedAlert) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return await db.insert(userDefinedAlerts).values(alert);
}

export async function updateUserDefinedAlertStatus(alertId: number, status: "active" | "triggered" | "inactive") {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return await db.update(userDefinedAlerts)
    .set({ status, triggeredAt: status === 'triggered' ? new Date() : null })
    .where(eq(userDefinedAlerts.id, alertId));
}

// Screener
export async function getScreenerResults(filters: { minMarketCap?: number, maxPeRatio?: number, sector?: string }) {
  const db = await getDb();
  if (!db) return [];

  let query = db.select({
    ticker: stockFinancials.ticker,
    marketCap: stockFinancials.marketCap,
    peRatio: stockFinancials.peRatio,
    eps: stockFinancials.eps,
    // Add other fields you want to display in the screener results
  })
  .from(stockFinancials)
  .$dynamic();

  const conditions = [];

  if (filters.minMarketCap) {
    conditions.push(sql`${stockFinancials.marketCap} >= ${filters.minMarketCap}`);
  }
  if (filters.maxPeRatio) {
    conditions.push(sql`${stockFinancials.peRatio} <= ${filters.maxPeRatio}`);
  }
  
  if (filters.sector) {
    // This requires a join with newsArticles to filter by sector.
    // For simplicity, we'll omit this for now and add it in a future iteration.
    // A better approach would be to have a dedicated `stocks` table with a `sector` column.
  }

  if (conditions.length > 0) {
    query = query.where(sql.join(conditions, sql` AND `));
  }

  return await query.limit(100);
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
  
  // Order by created_at DESC to show latest predictions first
  return await query.orderBy(desc(rallyEvents.createdAt));
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
    .orderBy(sectorMomentum.date)
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
  return await db.select().from(rallyEvents).where(eq(rallyEvents.isHistorical, true));
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
    isHistorical: false,
  });
}

export async function getPredictionPerformanceStats() {
  const db = await getDb();
  if (!db) return { success: 0, failure: 0, neutral: 0, total: 0 };
  
  const stats = await db
    .select({
      outcome: rallyEvents.predictionOutcome,
      count: count(rallyEvents.id),
    })
    .from(rallyEvents)
    .where(sql`${rallyEvents.backtestStatus} = 'completed'`)
    .groupBy(rallyEvents.predictionOutcome);

  const result = {
    success: 0,
    failure: 0,
    neutral: 0,
    total: 0,
  };

  stats.forEach(stat => {
    if (stat.outcome) {
      result[stat.outcome] = stat.count;
    }
    result.total += stat.count;
  });

  return result;
}

export async function getPredictionById(predictionId: number) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db.select().from(rallyEvents).where(eq(rallyEvents.id, predictionId)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

export async function updateRallyPredictionWithOptions(
  predictionId: number,
  options: {
    optionsStrategy: string;
    suggestedStrike: string;
    suggestedExpiration: string;
    entryStrategy: string;
    exitStrategy: string;
    riskAssessment: string;
    // Live market data
    optionPremium?: string;
    optionGreeks?: string;
    currentStockPrice?: string;
    breakEvenPrice?: string;
    probabilityOfProfit?: number;
    openInterest?: number;
    impliedVolatility?: string;
  }
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return await db.update(rallyEvents)
    .set({
      optionsStrategy: options.optionsStrategy,
      suggestedStrike: options.suggestedStrike,
      suggestedExpiration: options.suggestedExpiration,
      entryStrategy: options.entryStrategy,
      exitStrategy: options.exitStrategy,
      riskAssessment: options.riskAssessment,
      // Live market data
      optionPremium: options.optionPremium,
      optionGreeks: options.optionGreeks,
      currentStockPrice: options.currentStockPrice,
      breakEvenPrice: options.breakEvenPrice,
      probabilityOfProfit: options.probabilityOfProfit,
      openInterest: options.openInterest,
      impliedVolatility: options.impliedVolatility,
      optionsDataFetchedAt: new Date(),
    })
    .where(eq(rallyEvents.id, predictionId));
}

// Stock Financials
export async function getStockFinancials(ticker: string) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db.select().from(stockFinancials)
    .where(eq(stockFinancials.ticker, ticker))
    .orderBy(desc(stockFinancials.lastUpdated))
    .limit(1);

  return result.length > 0 ? result[0] : undefined;
}

export async function insertStockFinancials(financials: InsertStockFinancials) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return await db.insert(stockFinancials).values(financials)
    .onConflictDoUpdate({
      target: stockFinancials.ticker,
      set: {
        marketCap: financials.marketCap,
        peRatio: financials.peRatio,
        eps: financials.eps,
        dividendYield: financials.dividendYield,
        beta: financials.beta,
        high52Week: financials.high52Week,
        low52Week: financials.low52Week,
        lastUpdated: new Date(),
      }
    });
}

// Stock Historical Candles
export async function getStockHistoricalCandles(ticker: string, resolution: string, from: number, to: number) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db.select().from(stockHistoricalCandles)
    .where(
      sql`${stockHistoricalCandles.ticker} = ${ticker} AND 
           ${stockHistoricalCandles.resolution} = ${resolution} AND 
           ${stockHistoricalCandles.from} = ${from} AND 
           ${stockHistoricalCandles.to} = ${to}`
    )
    .orderBy(desc(stockHistoricalCandles.lastUpdated))
    .limit(1);

  if (result.length === 0) return undefined;

  const data = result[0];
  return {
    ...data,
    open: JSON.parse(data.open || "[]"),
    high: JSON.parse(data.high || "[]"),
    low: JSON.parse(data.low || "[]"),
    close: JSON.parse(data.close || "[]"),
    volume: JSON.parse(data.volume || "[]"),
    timestamp: JSON.parse(data.timestamp || "[]"),
  };
}

export async function insertStockHistoricalCandles(candles: InsertStockHistoricalCandle) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return await db.insert(stockHistoricalCandles).values({
    ticker: candles.ticker,
    resolution: candles.resolution,
    open: JSON.stringify(candles.open),
    high: JSON.stringify(candles.high),
    low: JSON.stringify(candles.low),
    close: JSON.stringify(candles.close),
    volume: JSON.stringify(candles.volume),
    timestamp: JSON.stringify(candles.timestamp),
    from: candles.from,
    to: candles.to,
    lastUpdated: new Date(),
  })
    .onConflictDoUpdate({
      target: [stockHistoricalCandles.ticker, stockHistoricalCandles.resolution, stockHistoricalCandles.from, stockHistoricalCandles.to],
      set: {
        open: JSON.stringify(candles.open),
        high: JSON.stringify(candles.high),
        low: JSON.stringify(candles.low),
        close: JSON.stringify(candles.close),
        volume: JSON.stringify(candles.volume),
        timestamp: JSON.stringify(candles.timestamp),
        lastUpdated: new Date(),
      }
    });
}

import { int, mysqlEnum, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 * Extend this file with additional tables as your product grows.
 * Columns use camelCase to match both database fields and generated types.
 */
export const users = mysqlTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: int("id").autoincrement().primaryKey(),
  /** Manus OAuth identifier (openId) returned from the OAuth callback. Unique per user. */
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/**
 * Market news articles aggregated from multiple sources
 */
export const newsArticles = mysqlTable("news_articles", {
  id: int("id").autoincrement().primaryKey(),
  title: text("title").notNull(),
  summary: text("summary"),
  content: text("content"),
  url: varchar("url", { length: 1024 }).notNull().unique(),
  source: varchar("source", { length: 128 }).notNull(), // Reuters, Bloomberg, Yahoo Finance, etc.
  publishedAt: timestamp("published_at").notNull(),
  scrapedAt: timestamp("scraped_at").defaultNow().notNull(),
  isAnalyzed: int("isAnalyzed").default(0).notNull(), // 0 = pending AI analysis, 1 = analyzed
  aiSummary: text("aiSummary"),
  sentiment: mysqlEnum("sentiment", ["bullish", "bearish", "neutral"]),
  potentialTerm: mysqlEnum("potentialTerm", ["short", "medium", "long", "none"]),
  mentionedStocks: text("mentioned_stocks"), // JSON array of ticker symbols
  sectors: text("sectors"), // JSON array of dynamically detected sectors
  rallyIndicator: mysqlEnum("rally_indicator", ["strong", "moderate", "weak", "none"]).default("none"),
  emergingSector: text("emerging_sector"), // Newly detected sector name
  predictionConfidence: int("prediction_confidence"), // 0-100 confidence score
});

export type NewsArticle = typeof newsArticles.$inferSelect;
export type InsertNewsArticle = typeof newsArticles.$inferInsert;

/**
 * User's watchlist stocks
 */
export const watchlistStocks = mysqlTable("watchlist_stocks", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  ticker: varchar("ticker", { length: 32 }).notNull(),
  name: varchar("name", { length: 256 }),
  isPriority: int("is_priority").default(0).notNull(), // For GOOG, NVDA, TSLA
  addedAt: timestamp("added_at").defaultNow().notNull(),
});

export type WatchlistStock = typeof watchlistStocks.$inferSelect;
export type InsertWatchlistStock = typeof watchlistStocks.$inferInsert;

/**
 * ARK Invest daily trades
 */
export const arkTrades = mysqlTable("ark_trades", {
  id: int("id").autoincrement().primaryKey(),
  tradeDate: timestamp("trade_date").notNull(),
  fund: varchar("fund", { length: 16 }).notNull(), // ARKK, ARKQ, ARKW, ARKG, ARKF, ARKX, etc.
  ticker: varchar("ticker", { length: 32 }).notNull(),
  companyName: varchar("company_name", { length: 256 }),
  direction: mysqlEnum("direction", ["buy", "sell"]).notNull(),
  shares: int("shares"),
  marketValue: varchar("market_value", { length: 64 }), // Store as string to preserve precision
  percentOfEtf: varchar("percent_of_etf", { length: 16 }),
  scrapedAt: timestamp("scraped_at").defaultNow().notNull(),
});

export type ArkTrade = typeof arkTrades.$inferSelect;
export type InsertArkTrade = typeof arkTrades.$inferInsert;

/**
 * Market rally events and patterns
 */
export const rallyEvents = mysqlTable("rally_events", {
  id: int("id").autoincrement().primaryKey(),
  sector: varchar("sector", { length: 128 }).notNull(), // Dynamic sector name
  name: varchar("name", { length: 256 }).notNull(),
  startDate: timestamp("start_date").notNull(),
  peakDate: timestamp("peak_date"),
  description: text("description"),
  catalysts: text("catalysts"), // JSON array of key events that triggered the rally
  keyStocks: text("key_stocks"), // JSON array of ticker symbols that benefited
  performance: text("performance"), // JSON object with performance metrics
  status: mysqlEnum("status", ["ongoing", "ended", "potential", "predicted"]).default("potential").notNull(),
  predictionConfidence: int("prediction_confidence"), // 0-100 for predicted rallies
  earlySignals: text("early_signals"), // JSON array of signals detected before rally
  isHistorical: int("is_historical").default(0).notNull(), // 1 for learning data, 0 for predictions
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type RallyEvent = typeof rallyEvents.$inferSelect;
export type InsertRallyEvent = typeof rallyEvents.$inferInsert;

/**
 * User alerts and notifications
 */
export const alerts = mysqlTable("alerts", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: mysqlEnum("type", ["rally_detected", "ark_trade", "market_event", "downside_risk", "watchlist_update"]).notNull(),
  severity: mysqlEnum("severity", ["high", "medium", "low"]).default("medium").notNull(),
  title: varchar("title", { length: 256 }).notNull(),
  message: text("message").notNull(),
  metadata: text("metadata"), // JSON object with additional data (stocks, sectors, etc.)
  isRead: int("is_read").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type Alert = typeof alerts.$inferSelect;
export type InsertAlert = typeof alerts.$inferInsert;

/**
 * User preferences and settings
 */
export const userPreferences = mysqlTable("user_preferences", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("user_id").notNull().unique().references(() => users.id, { onDelete: "cascade" }),
  refreshSchedule: varchar("refresh_schedule", { length: 64 }).default("4h").notNull(), // e.g., "4h", "6h", "12h"
  alertThreshold: mysqlEnum("alert_threshold", ["all", "medium_high", "high_only"]).default("medium_high").notNull(),
  enableEmailAlerts: int("enable_email_alerts").default(1).notNull(),
  watchedSectors: text("watched_sectors"), // JSON array of sectors to focus on
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});

export type UserPreference = typeof userPreferences.$inferSelect;
export type InsertUserPreference = typeof userPreferences.$inferInsert;

// Re-export YouTube tables
export { youtubeInfluencers, youtubeVideos } from "./schema_youtube";
export type { YoutubeInfluencer, InsertYoutubeInfluencer, YoutubeVideo, InsertYoutubeVideo } from "./schema_youtube";

/**
 * Sector momentum tracking
 */
export const sectorMomentum = mysqlTable("sector_momentum", {
  id: int("id").autoincrement().primaryKey(),
  sector: varchar("sector", { length: 128 }).notNull(), // Dynamic sector name
  date: timestamp("date").notNull(),
  momentum: mysqlEnum("momentum", ["very_strong", "strong", "moderate", "weak", "declining"]).notNull(),
  newsCount: int("news_count").default(0).notNull(),
  sentimentScore: varchar("sentiment_score", { length: 16 }), // Average sentiment as decimal
  topStocks: text("top_stocks"), // JSON array of top performing stocks
  rallyProbability: int("rally_probability"), // 0-100 probability of upcoming rally
  isEmerging: int("is_emerging").default(0).notNull(), // 1 for newly detected sectors
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type SectorMomentum = typeof sectorMomentum.$inferSelect;
export type InsertSectorMomentum = typeof sectorMomentum.$inferInsert;
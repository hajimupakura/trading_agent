import { integer, pgEnum, pgTable, text, timestamp, varchar, serial, boolean } from "drizzle-orm/pg-core";

// PostgreSQL Enums
export const roleEnum = pgEnum("role", ["user", "admin"]);
export const sentimentEnum = pgEnum("sentiment", ["bullish", "bearish", "neutral"]);
export const potentialTermEnum = pgEnum("potential_term", ["short", "medium", "long", "none"]);
export const rallyIndicatorEnum = pgEnum("rally_indicator", ["strong", "moderate", "weak", "none"]);
export const directionEnum = pgEnum("direction", ["buy", "sell"]);
export const statusEnum = pgEnum("status", ["ongoing", "ended", "potential", "predicted"]);
export const alertTypeEnum = pgEnum("alert_type", ["rally_detected", "ark_trade", "market_event", "downside_risk", "watchlist_update"]);
export const severityEnum = pgEnum("severity", ["high", "medium", "low"]);
export const alertThresholdEnum = pgEnum("alert_threshold", ["all", "medium_high", "high_only"]);
export const momentumEnum = pgEnum("momentum", ["very_strong", "strong", "moderate", "weak", "declining"]);
export const predictionOutcomeEnum = pgEnum("prediction_outcome", ["success", "failure", "neutral"]);
export const backtestStatusEnum = pgEnum("backtest_status", ["pending", "processing", "completed"]);

/**
 * Core user table backing auth flow.
 */
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: roleEnum("role").default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/**
 * Market news articles aggregated from multiple sources
 */
export const newsArticles = pgTable("news_articles", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  summary: text("summary"),
  content: text("content"),
  url: varchar("url", { length: 1024 }).notNull().unique(),
  source: varchar("source", { length: 128 }).notNull(),
  publishedAt: timestamp("published_at").notNull(),
  scrapedAt: timestamp("scraped_at").defaultNow().notNull(),
  isAnalyzed: boolean("isAnalyzed").default(false).notNull(),
  analysisRequestedAt: timestamp("analysis_requested_at"),
  aiSummary: text("aiSummary"),
  sentiment: sentimentEnum("sentiment"),
  potentialTerm: potentialTermEnum("potentialTerm"),
  mentionedStocks: text("mentioned_stocks"),
  sectors: text("sectors"),
  rallyIndicator: rallyIndicatorEnum("rally_indicator").default("none"),
  emergingSector: text("emerging_sector"),
  predictionConfidence: integer("prediction_confidence"),
});

export type NewsArticle = typeof newsArticles.$inferSelect;
export type InsertNewsArticle = typeof newsArticles.$inferInsert;

/**
 * User's watchlist stocks
 */
export const watchlistStocks = pgTable("watchlist_stocks", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  ticker: varchar("ticker", { length: 32 }).notNull(),
  name: varchar("name", { length: 256 }),
  isPriority: boolean("is_priority").default(false).notNull(),
  addedAt: timestamp("added_at").defaultNow().notNull(),
});

export type WatchlistStock = typeof watchlistStocks.$inferSelect;
export type InsertWatchlistStock = typeof watchlistStocks.$inferInsert;

/**
 * ARK Invest daily trades
 */
export const arkTrades = pgTable("ark_trades", {
  id: serial("id").primaryKey(),
  tradeDate: timestamp("trade_date").notNull(),
  fund: varchar("fund", { length: 16 }).notNull(),
  ticker: varchar("ticker", { length: 32 }).notNull(),
  companyName: varchar("company_name", { length: 256 }),
  direction: directionEnum("direction").notNull(),
  shares: integer("shares"),
  marketValue: varchar("market_value", { length: 64 }),
  percentOfEtf: varchar("percent_of_etf", { length: 16 }),
  scrapedAt: timestamp("scraped_at").defaultNow().notNull(),
});

export type ArkTrade = typeof arkTrades.$inferSelect;
export type InsertArkTrade = typeof arkTrades.$inferInsert;

/**
 * Market rally events and patterns
 */
export const rallyEvents = pgTable("rally_events", {
  id: serial("id").primaryKey(),
  sector: varchar("sector", { length: 128 }).notNull(),
  name: varchar("name", { length: 256 }).notNull(),
  startDate: timestamp("start_date").notNull(),
  peakDate: timestamp("peak_date"),
  description: text("description"),
  catalysts: text("catalysts"),
  keyStocks: text("key_stocks"),
  performance: text("performance"),
  status: statusEnum("status").default("potential").notNull(),
  predictionConfidence: integer("prediction_confidence"),
  earlySignals: text("early_signals"),
  isHistorical: boolean("is_historical").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  predictionOutcome: predictionOutcomeEnum("prediction_outcome"),
  backtestStatus: backtestStatusEnum("backtest_status").default("pending"),
  initialPrices: text("initial_prices"),
});

export type RallyEvent = typeof rallyEvents.$inferSelect;
export type InsertRallyEvent = typeof rallyEvents.$inferInsert;

/**
 * User alerts and notifications
 */
export const alerts = pgTable("alerts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: alertTypeEnum("type").notNull(),
  severity: severityEnum("severity").default("medium").notNull(),
  title: varchar("title", { length: 256 }).notNull(),
  message: text("message").notNull(),
  metadata: text("metadata"),
  isRead: boolean("is_read").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type Alert = typeof alerts.$inferSelect;
export type InsertAlert = typeof alerts.$inferInsert;

export const userDefinedAlertTypeEnum = pgEnum("user_defined_alert_type", ["price_above", "price_below", "volume_increase"]);
export const userDefinedAlertStatusEnum = pgEnum("user_defined_alert_status", ["active", "triggered", "inactive"]);

/**
 * User-defined alerts
 */
export const userDefinedAlerts = pgTable("user_defined_alerts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  ticker: varchar("ticker", { length: 32 }).notNull(),
  type: userDefinedAlertTypeEnum("type").notNull(),
  value: varchar("value", { length: 64 }).notNull(), // The target price or volume percentage
  status: userDefinedAlertStatusEnum("status").default("active").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  triggeredAt: timestamp("triggered_at"),
});

export type UserDefinedAlert = typeof userDefinedAlerts.$inferSelect;
export type InsertUserDefinedAlert = typeof userDefinedAlerts.$inferInsert;

/**
 * User preferences and settings
 */
export const userPreferences = pgTable("user_preferences", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().unique().references(() => users.id, { onDelete: "cascade" }),
  refreshSchedule: varchar("refresh_schedule", { length: 64 }).default("4h").notNull(),
  alertThreshold: alertThresholdEnum("alert_threshold").default("medium_high").notNull(),
  enableEmailAlerts: boolean("enable_email_alerts").default(true).notNull(),
  watchedSectors: text("watched_sectors"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type UserPreference = typeof userPreferences.$inferSelect;
export type InsertUserPreference = typeof userPreferences.$inferInsert;

/**
 * Sector momentum tracking
 */
export const sectorMomentum = pgTable("sector_momentum", {
  id: serial("id").primaryKey(),
  sector: varchar("sector", { length: 128 }).notNull(),
  date: timestamp("date").notNull(),
  momentum: momentumEnum("momentum").notNull(),
  newsCount: integer("news_count").default(0).notNull(),
  sentimentScore: varchar("sentiment_score", { length: 16 }),
  topStocks: text("top_stocks"),
  rallyProbability: integer("rally_probability"),
  isEmerging: boolean("is_emerging").default(false).notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type SectorMomentum = typeof sectorMomentum.$inferSelect;
export type InsertSectorMomentum = typeof sectorMomentum.$inferInsert;

/**
 * Stock financials data (cached from Finnhub)
 */
export const stockFinancials = pgTable("stock_financials", {
  id: serial("id").primaryKey(),
  ticker: varchar("ticker", { length: 32 }).notNull().unique(),
  marketCap: varchar("market_cap", { length: 64 }),
  peRatio: varchar("pe_ratio", { length: 32 }),
  eps: varchar("eps", { length: 32 }),
  dividendYield: varchar("dividend_yield", { length: 32 }),
  beta: varchar("beta", { length: 32 }),
  high52Week: varchar("high_52_week", { length: 32 }),
  low52Week: varchar("low_52_week", { length: 32 }),
  lastUpdated: timestamp("last_updated").defaultNow().notNull(),
});

export type StockFinancials = typeof stockFinancials.$inferSelect;
export type InsertStockFinancials = typeof stockFinancials.$inferInsert;

/**
 * Stock historical candle data (cached from Finnhub)
 */
export const stockHistoricalCandles = pgTable("stock_historical_candles", {
  id: serial("id").primaryKey(),
  ticker: varchar("ticker", { length: 32 }).notNull(),
  resolution: varchar("resolution", { length: 8 }).notNull(),
  // Storing arrays as text; convert to/from JSON in service layer
  open: text("open"),
  high: text("high"),
  low: text("low"),
  close: text("close"),
  volume: text("volume"),
  timestamp: text("timestamp"),
  from: integer("from").notNull(),
  to: integer("to").notNull(),
  lastUpdated: timestamp("last_updated").defaultNow().notNull(),
});

export type StockHistoricalCandle = typeof stockHistoricalCandles.$inferSelect;
export type InsertStockHistoricalCandle = typeof stockHistoricalCandles.$inferInsert;


// Re-export YouTube tables
export { youtubeInfluencers, youtubeVideos } from "./schema_youtube";
export type { YoutubeInfluencer, InsertYoutubeInfluencer, YoutubeVideo, InsertYoutubeVideo } from "./schema_youtube";

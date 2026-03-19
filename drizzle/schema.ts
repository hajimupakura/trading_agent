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
  refreshSchedule: varchar("refresh_schedule", { length: 64 }).default("4h").notNull(),
  alertThreshold: mysqlEnum("alert_threshold", ["all", "medium_high", "high_only"]).default("medium_high").notNull(),
  enableEmailAlerts: int("enable_email_alerts").default(1).notNull(),
  watchedSectors: text("watched_sectors"), // JSON array of sectors to focus on
  // Risk management settings
  maxPositionPct: int("max_position_pct").default(10).notNull(),       // Max % of equity per position
  maxSectorPct: int("max_sector_pct").default(25).notNull(),           // Max % of equity in one sector
  stopLossPct: int("stop_loss_pct").default(5).notNull(),              // Default stop loss %
  takeProfitPct: int("take_profit_pct").default(15).notNull(),         // Default take profit %
  maxDrawdownPct: int("max_drawdown_pct").default(15).notNull(),       // Max portfolio drawdown %
  maxOpenPositions: int("max_open_positions").default(10).notNull(),    // Max concurrent positions
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

/**
 * Price snapshots for historical tracking and technical analysis.
 * Captured every 5 minutes during market hours from the WebSocket feed.
 */
export const priceSnapshots = mysqlTable("price_snapshots", {
  id: int("id").autoincrement().primaryKey(),
  symbol: varchar("symbol", { length: 16 }).notNull(),
  price: varchar("price", { length: 32 }).notNull(), // Stored as string for precision
  volume: int("volume").default(0),
  high: varchar("high", { length: 32 }),
  low: varchar("low", { length: 32 }),
  open: varchar("open", { length: 32 }),
  capturedAt: timestamp("captured_at").defaultNow().notNull(),
});

export type PriceSnapshot = typeof priceSnapshots.$inferSelect;
export type InsertPriceSnapshot = typeof priceSnapshots.$inferInsert;

/**
 * Portfolios — each user can have paper and (eventually) live portfolios.
 */
export const portfolios = mysqlTable("portfolios", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 128 }).notNull(),
  type: mysqlEnum("type", ["paper", "live"]).default("paper").notNull(),
  cashBalance: varchar("cash_balance", { length: 32 }).default("100000").notNull(), // String for precision
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type Portfolio = typeof portfolios.$inferSelect;
export type InsertPortfolio = typeof portfolios.$inferInsert;

/**
 * Open positions within a portfolio.
 */
export const positions = mysqlTable("positions", {
  id: int("id").autoincrement().primaryKey(),
  portfolioId: int("portfolio_id").notNull().references(() => portfolios.id, { onDelete: "cascade" }),
  symbol: varchar("symbol", { length: 16 }).notNull(),
  quantity: int("quantity").notNull(),
  avgEntryPrice: varchar("avg_entry_price", { length: 32 }).notNull(),
  side: mysqlEnum("side", ["long", "short"]).default("long").notNull(),
  stopLoss: varchar("stop_loss", { length: 32 }),
  takeProfit: varchar("take_profit", { length: 32 }),
  openedAt: timestamp("opened_at").defaultNow().notNull(),
});

export type Position = typeof positions.$inferSelect;
export type InsertPosition = typeof positions.$inferInsert;

/**
 * Trade log — every buy/sell action, linked back to predictions.
 */
export const tradesLog = mysqlTable("trades_log", {
  id: int("id").autoincrement().primaryKey(),
  portfolioId: int("portfolio_id").notNull().references(() => portfolios.id, { onDelete: "cascade" }),
  symbol: varchar("symbol", { length: 16 }).notNull(),
  side: mysqlEnum("side", ["buy", "sell"]).notNull(),
  quantity: int("quantity").notNull(),
  price: varchar("price", { length: 32 }).notNull(),
  total: varchar("total", { length: 32 }).notNull(), // quantity * price
  orderType: mysqlEnum("order_type", ["market", "limit"]).default("market").notNull(),
  status: mysqlEnum("status", ["filled", "cancelled"]).default("filled").notNull(),
  predictionId: int("prediction_id"), // Links to the rally prediction that triggered this trade
  notes: text("notes"),
  executedAt: timestamp("executed_at").defaultNow().notNull(),
});

export type TradeLog = typeof tradesLog.$inferSelect;
export type InsertTradeLog = typeof tradesLog.$inferInsert;

/**
 * Prediction outcomes — tracks whether predictions were accurate.
 * Evaluated after the prediction's timeframe expires.
 */
export const predictionOutcomes = mysqlTable("prediction_outcomes", {
  id: int("id").autoincrement().primaryKey(),
  predictionId: int("prediction_id").notNull().references(() => rallyEvents.id, { onDelete: "cascade" }),
  predictedDirection: mysqlEnum("predicted_direction", ["up", "down"]).notNull(),
  predictedConfidence: int("predicted_confidence").notNull(),
  predictedSector: varchar("predicted_sector", { length: 128 }).notNull(),
  predictedStocks: text("predicted_stocks"), // JSON array of tickers
  actualReturn: varchar("actual_return", { length: 32 }), // Average % return of predicted stocks
  wasCorrect: int("was_correct"), // 1 = correct direction, 0 = wrong
  evaluatedAt: timestamp("evaluated_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type PredictionOutcome = typeof predictionOutcomes.$inferSelect;
export type InsertPredictionOutcome = typeof predictionOutcomes.$inferInsert;

/**
 * Agent cycle logs — records every autonomous trading cycle.
 */
export const agentCycleLogs = mysqlTable("agent_cycle_logs", {
  id: int("id").autoincrement().primaryKey(),
  cycleNumber: int("cycle_number").notNull(),
  predictionsGenerated: int("predictions_generated").default(0).notNull(),
  tradesExecuted: int("trades_executed").default(0).notNull(),
  positionsClosed: int("positions_closed").default(0).notNull(),
  portfolioEquity: varchar("portfolio_equity", { length: 32 }),
  portfolioPnL: varchar("portfolio_pnl", { length: 32 }),
  riskWarnings: text("risk_warnings"),
  summary: text("summary"), // Full JSON of cycle summary
  reflection: text("reflection"), // Daily reflection text
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type AgentCycleLog = typeof agentCycleLogs.$inferSelect;
export type InsertAgentCycleLog = typeof agentCycleLogs.$inferInsert;

/**
 * Agent config — key-value store for persistent agent state.
 */
export const agentConfig = mysqlTable("agent_config", {
  id: int("id").autoincrement().primaryKey(),
  key: varchar("key", { length: 64 }).notNull().unique(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});

export type AgentConfig = typeof agentConfig.$inferSelect;
export type InsertAgentConfig = typeof agentConfig.$inferInsert;
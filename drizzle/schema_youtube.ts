import { int, mysqlEnum, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";
import { users } from "./schema";

/**
 * YouTube influencers to track
 */
export const youtubeInfluencers = mysqlTable("youtube_influencers", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  channelId: varchar("channel_id", { length: 128 }).notNull(),
  channelName: varchar("channel_name", { length: 256 }).notNull(),
  channelUrl: varchar("channel_url", { length: 512 }),
  isActive: int("is_active").default(1).notNull(),
  addedAt: timestamp("added_at").defaultNow().notNull(),
});

export type YoutubeInfluencer = typeof youtubeInfluencers.$inferSelect;
export type InsertYoutubeInfluencer = typeof youtubeInfluencers.$inferInsert;

/**
 * YouTube video summaries
 */
export const youtubeVideos = mysqlTable("youtube_videos", {
  id: int("id").autoincrement().primaryKey(),
  influencerId: int("influencer_id").notNull().references(() => youtubeInfluencers.id, { onDelete: "cascade" }),
  videoId: varchar("video_id", { length: 128 }).notNull().unique(),
  title: text("title").notNull(),
  description: text("description"),
  publishedAt: timestamp("published_at").notNull(),
  thumbnailUrl: varchar("thumbnail_url", { length: 512 }),
  videoUrl: varchar("video_url", { length: 512 }).notNull(),
  // AI-generated fields
  aiSummary: text("ai_summary"),
  keyTakeaways: text("key_takeaways"), // JSON array
  mentionedStocks: text("mentioned_stocks"), // JSON array
  sentiment: mysqlEnum("sentiment", ["bullish", "bearish", "neutral"]),
  sectors: text("sectors"), // JSON array
  tradingSignals: text("trading_signals"), // JSON array of specific calls/recommendations
  scrapedAt: timestamp("scraped_at").defaultNow().notNull(),
});

export type YoutubeVideo = typeof youtubeVideos.$inferSelect;
export type InsertYoutubeVideo = typeof youtubeVideos.$inferInsert;

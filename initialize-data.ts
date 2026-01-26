#!/usr/bin/env tsx

/**
 * Manual data initialization script
 * Run this to populate the database with initial data for testing
 */

import { syncRSSNews, analyzePendingNews } from "./server/services/rssNewsSync";
import { getMockNewsArticles, convertToNewsArticle } from "./server/services/newsScraper";
import { getMockYouTubeVideos } from "./server/services/youtubeTracker";
import { getMockArkTrades, convertToArkTrade } from "./server/services/arkTracker";
import { getDb } from "./server/db";
import { newsArticles, arkTrades, youtubeVideos } from "./drizzle/schema";

async function initializeData() {
  console.log("=".repeat(50));
  console.log("  Trading Agent - Data Initialization");
  console.log("=".repeat(50));
  console.log();

  const db = await getDb();
  if (!db) {
    console.error("❌ Database not available!");
    process.exit(1);
  }

  console.log("✅ Database connected");
  console.log();

  // 1. Try RSS sync first
  console.log("📰 Step 1: Syncing RSS feeds...");
  try {
    const rssResult = await syncRSSNews();
    console.log(`   ✅ Added ${rssResult.added} articles, skipped ${rssResult.skipped}`);
  } catch (error) {
    console.log(`   ⚠️  RSS sync failed:`, error);
    console.log("   ℹ️  Will use mock data instead");
  }
  console.log();

  // 2. Add mock news if RSS didn't work
  console.log("📰 Step 2: Adding mock news articles...");
  try {
    const mockArticles = getMockNewsArticles();
    let added = 0;
    
    for (const article of mockArticles) {
      try {
        await db.insert(newsArticles).values({
          ...convertToNewsArticle(article),
          isAnalyzed: false,
        });
        added++;
      } catch (error: any) {
        if (!error.message?.includes("duplicate") && !error.message?.includes("unique")) {
          console.log(`   ⚠️  Error adding article:`, error.message);
        }
      }
    }
    
    console.log(`   ✅ Added ${added} mock news articles`);
  } catch (error) {
    console.log(`   ❌ Failed to add mock news:`, error);
  }
  console.log();

  // 3. Add mock ARK trades
  console.log("📈 Step 3: Adding mock ARK trades...");
  try {
    const mockTrades = getMockArkTrades();
    let added = 0;
    
    for (const trade of mockTrades) {
      try {
        await db.insert(arkTrades).values(convertToArkTrade(trade));
        added++;
      } catch (error: any) {
        if (!error.message?.includes("duplicate") && !error.message?.includes("unique")) {
          console.log(`   ⚠️  Error adding trade:`, error.message);
        }
      }
    }
    
    console.log(`   ✅ Added ${added} mock ARK trades`);
  } catch (error) {
    console.log(`   ❌ Failed to add ARK trades:`, error);
  }
  console.log();

  // 4. Add mock YouTube videos
  console.log("🎥 Step 4: Adding mock YouTube videos...");
  try {
    const mockVideos = getMockYouTubeVideos();
    let added = 0;
    
    // Note: YouTube videos need a user/influencer first
    // For now, we'll skip this or you need to create an influencer first
    console.log(`   ℹ️  Skipping YouTube videos (requires influencer setup)`);
  } catch (error) {
    console.log(`   ❌ Failed to add YouTube videos:`, error);
  }
  console.log();

  // 5. Analyze pending news
  console.log("🤖 Step 5: Analyzing news with AI...");
  try {
    const analysisResult = await analyzePendingNews();
    console.log(`   ✅ Analyzed ${analysisResult.analyzed} articles, ${analysisResult.failed} failed`);
  } catch (error) {
    console.log(`   ⚠️  AI analysis failed:`, error);
  }
  console.log();

  // 6. Show summary
  console.log("=".repeat(50));
  console.log("  Summary");
  console.log("=".repeat(50));
  
  try {
    const newsCount = await db.select().from(newsArticles);
    const arkCount = await db.select().from(arkTrades);
    
    console.log(`📰 News articles: ${newsCount.length}`);
    console.log(`📈 ARK trades: ${arkCount.length}`);
    console.log();
    console.log("✅ Data initialization complete!");
    console.log();
    console.log("🌐 Visit: http://35.238.160.230:5005");
  } catch (error) {
    console.log("❌ Error getting summary:", error);
  }
  
  process.exit(0);
}

initializeData().catch(error => {
  console.error("Fatal error:", error);
  process.exit(1);
});

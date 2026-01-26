import { seedHistoricalRallies } from "./seedHistoricalRallies";
import { getMockNewsArticles, convertToNewsArticle } from "./newsScraper";
import { getMockArkTrades, convertToArkTrade } from "./arkTracker";
import { analyzeNewsArticle } from "./sentimentAnalysis";
import { insertNewsArticle, insertArkTrade, getRecentNews, getRecentArkTrades } from "../db";

/**
 * Initialize the database with sample data
 * This runs once to populate the dashboard with initial content
 */
export async function initializeData() {
  console.log("🚀 Initializing AI Trading Agent data...");

  try {
    // Check if data already exists
    const existingNews = await getRecentNews(1);
    const existingTrades = await getRecentArkTrades(1);

    if (existingNews.length > 0 && existingTrades.length > 0) {
      console.log("✓ Data already initialized, skipping...");
      return;
    }

    // 1. Seed historical rally events
    console.log("📊 Seeding historical rally events...");
    await seedHistoricalRallies();

    // 2. Add mock news articles with AI analysis
    console.log("📰 Adding news articles with AI analysis...");
    const mockArticles = getMockNewsArticles();
    
    for (const article of mockArticles) {
      try {
        console.log(`  Analyzing: ${article.title.substring(0, 50)}...`);
        const analysis = await analyzeNewsArticle(article);
        
        const newsArticle = {
          ...convertToNewsArticle(article),
          sentiment: analysis.sentiment,
          potentialTerm: analysis.potentialTerm,
          aiSummary: analysis.aiSummary,
          mentionedStocks: JSON.stringify(analysis.mentionedStocks),
          sectors: JSON.stringify(analysis.sectors),
          rallyIndicator: analysis.rallyIndicator,
        };
        
        await insertNewsArticle(newsArticle);
        console.log(`  ✓ Added: ${article.title.substring(0, 50)}...`);
        
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        console.error(`  ✗ Failed to add article: ${article.title}`, error);
      }
    }

    // 3. Add mock ARK trades
    console.log("💼 Adding ARK Invest trades...");
    const mockTrades = getMockArkTrades();
    
    for (const trade of mockTrades) {
      try {
        await insertArkTrade(convertToArkTrade(trade));
        console.log(`  ✓ Added: ${trade.fund} ${trade.direction} ${trade.ticker}`);
      } catch (error) {
        console.error(`  ✗ Failed to add trade: ${trade.ticker}`, error);
      }
    }

    console.log("✅ Data initialization complete!");
    console.log("🎯 Dashboard is ready with sample data.");
    
  } catch (error) {
    console.error("❌ Error initializing data:", error);
    throw error;
  }
}

/**
 * Run initialization if this file is executed directly
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  initializeData()
    .then(() => {
      console.log("Done!");
      process.exit(0);
    })
    .catch((error) => {
      console.error("Failed:", error);
      process.exit(1);
    });
}

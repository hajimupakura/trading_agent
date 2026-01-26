import { predictUpcomingRallies, extractHistoricalPatterns } from './server/services/rallyPrediction.ts';
import { getDb } from './server/db.ts';
import { newsArticles, rallyEvents } from './drizzle/schema.ts';

async function test() {
  console.log('🔍 Testing Rally Prediction Generation...\n');
  
  const db = await getDb();
  
  // Get recent news
  const recentNews = await db.select().from(newsArticles).limit(100);
  console.log('📰 Recent news articles:', recentNews.length);
  
  // Get historical rallies
  const historicalRallies = await db.select().from(rallyEvents);
  console.log('📊 Historical rallies:', historicalRallies.length);
  
  const patterns = extractHistoricalPatterns(historicalRallies);
  console.log('🧩 Extracted patterns:', patterns.length);
  
  console.log('\n🤖 Calling AI to generate predictions...\n');
  
  try {
    const predictions = await predictUpcomingRallies(recentNews, patterns);
    
    console.log('\n' + '='.repeat(60));
    console.log('✅ Predictions Generated:', predictions.length);
    console.log('='.repeat(60));
    
    if (predictions.length > 0) {
      predictions.forEach((pred, i) => {
        console.log(`\n[${i+1}] ${pred.sector}`);
        console.log(`    Type: ${pred.opportunityType.toUpperCase()} (${pred.direction})`);
        console.log(`    Confidence: ${pred.confidence}%`);
        console.log(`    Timeframe: ${pred.timeframe}`);
        console.log(`    Stocks: ${pred.recommendedStocks.join(', ')}`);
        console.log(`    Entry: ${pred.entryTiming}`);
      });
    } else {
      console.log('\n⚠️  No predictions generated (all below 55% confidence threshold)');
    }
    
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.error(error);
    process.exit(1);
  }
}

test();

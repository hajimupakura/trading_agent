import axios from "axios";
import { InsertNewsArticle } from "../../drizzle/schema";

/**
 * News scraping service for aggregating financial news from multiple sources
 * Uses free sources without API keys
 */

interface ScrapedArticle {
  title: string;
  summary?: string;
  content?: string;
  url: string;
  source: string;
  publishedAt: Date;
}

/**
 * Scrape Yahoo Finance news
 */
export async function scrapeYahooFinance(query: string = "stock market"): Promise<ScrapedArticle[]> {
  try {
    const searchUrl = `https://finance.yahoo.com/search?q=${encodeURIComponent(query)}`;
    const response = await axios.get(searchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      timeout: 10000,
    });

    // Parse HTML to extract news articles
    // This is a simplified version - in production, use a proper HTML parser like cheerio
    const articles: ScrapedArticle[] = [];
    
    // For now, return empty array - actual scraping would require HTML parsing
    return articles;
  } catch (error) {
    console.error("Error scraping Yahoo Finance:", error);
    return [];
  }
}

/**
 * Fetch news from Google News RSS (free, no API key required)
 */
export async function fetchGoogleNewsRSS(query: string = "stock market"): Promise<ScrapedArticle[]> {
  try {
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
    const response = await axios.get(rssUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      timeout: 10000,
    });

    // Parse RSS XML to extract articles
    // This is a placeholder - actual implementation would parse XML
    const articles: ScrapedArticle[] = [];
    
    return articles;
  } catch (error) {
    console.error("Error fetching Google News RSS:", error);
    return [];
  }
}

/**
 * Aggregate news from multiple sources
 */
export async function aggregateNews(queries: string[] = ["stock market", "AI stocks", "metals rally", "quantum computing"]): Promise<ScrapedArticle[]> {
  const allArticles: ScrapedArticle[] = [];

  for (const query of queries) {
    try {
      // Fetch from multiple sources
      const yahooArticles = await scrapeYahooFinance(query);
      const googleArticles = await fetchGoogleNewsRSS(query);

      allArticles.push(...yahooArticles, ...googleArticles);
    } catch (error) {
      console.error(`Error aggregating news for query "${query}":`, error);
    }
  }

  // Remove duplicates based on URL
  const uniqueArticles = Array.from(
    new Map(allArticles.map(article => [article.url, article])).values()
  );

  return uniqueArticles;
}

/**
 * Convert scraped article to database format
 */
export function convertToNewsArticle(scraped: ScrapedArticle): Omit<InsertNewsArticle, "id"> {
  return {
    title: scraped.title,
    summary: scraped.summary || null,
    content: scraped.content || null,
    url: scraped.url,
    source: scraped.source,
    publishedAt: scraped.publishedAt,
    scrapedAt: new Date(),
    // AI fields will be populated by sentiment analysis service
    sentiment: null,
    potentialTerm: null,
    aiSummary: null,
    mentionedStocks: null,
    sectors: null,
    rallyIndicator: "none",
  };
}

/**
 * Mock news data for development/testing
 * In production, this would be replaced with actual scraping
 */
export function getMockNewsArticles(): ScrapedArticle[] {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);

  return [
    {
      title: "NVIDIA Stock Surges on New AI Chip Announcement",
      summary: "NVIDIA announces breakthrough in AI chip technology, stock rises 5% in pre-market trading",
      content: "NVIDIA Corporation announced today a new generation of AI chips that promise to revolutionize machine learning capabilities...",
      url: "https://example.com/nvidia-ai-chip-1",
      source: "Yahoo Finance",
      publishedAt: now,
    },
    {
      title: "Gold Prices Hit New Highs Amid Economic Uncertainty",
      summary: "Gold and silver rally continues as investors seek safe-haven assets",
      content: "Precious metals continue their upward trajectory as economic uncertainty drives investors toward traditional safe-haven assets...",
      url: "https://example.com/gold-rally-1",
      source: "MarketWatch",
      publishedAt: yesterday,
    },
    {
      title: "Quantum Computing Stocks See Massive Gains",
      summary: "IonQ and Rigetti lead quantum computing rally after major breakthrough announcement",
      content: "Quantum computing stocks experienced significant gains today following announcements of technological breakthroughs...",
      url: "https://example.com/quantum-rally-1",
      source: "Bloomberg",
      publishedAt: yesterday,
    },
    {
      title: "Google Announces Major AI Investment",
      summary: "Alphabet Inc. commits $10 billion to AI research and development",
      content: "Google's parent company Alphabet announced a major investment in artificial intelligence research...",
      url: "https://example.com/google-ai-investment-1",
      source: "Reuters",
      publishedAt: twoDaysAgo,
    },
    {
      title: "Tesla Stock Volatility Continues Amid Production Updates",
      summary: "Tesla shares fluctuate as company provides quarterly production figures",
      content: "Tesla Inc. released its quarterly production numbers today, leading to mixed reactions from investors...",
      url: "https://example.com/tesla-production-1",
      source: "Yahoo Finance",
      publishedAt: twoDaysAgo,
    },
  ];
}

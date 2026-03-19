import Parser from "rss-parser";

/**
 * RSS Feed Service for near real-time news fetching
 * Fetches news from major financial sources without API costs
 */

export interface RSSFeedItem {
  title: string;
  link: string;
  pubDate: Date;
  content?: string;
  summary?: string;
  source: string;
}

// 12 high-quality financial news RSS feeds, organized by category
const RSS_FEEDS = [
  // ── Breaking News & Markets (fastest, highest signal) ────────────────
  {
    name: "Reuters Business",
    url: "https://www.reutersagency.com/feed/?taxonomy=best-topics&post_type=best",
  },
  {
    name: "CNBC Markets",
    url: "https://www.cnbc.com/id/10000664/device/rss/rss.html",
  },
  {
    name: "MarketWatch Top Stories",
    url: "https://www.marketwatch.com/rss/topstories",
  },
  {
    name: "MarketWatch Stocks",
    url: "https://www.marketwatch.com/rss/stockstowatch",
  },

  // ── Institutional & Analysis ─────────────────────────────────────────
  {
    name: "Financial Times",
    url: "https://www.ft.com/rss/home",
  },
  {
    name: "Bloomberg Markets",
    url: "https://feeds.bloomberg.com/markets/news.rss",
  },
  {
    name: "Barrons",
    url: "https://www.barrons.com/feed",
  },

  // ── Pre-market & Earnings (critical for the agent) ──────────────────
  {
    name: "Benzinga",
    url: "https://www.benzinga.com/feed",
  },
  {
    name: "Investing.com News",
    url: "https://www.investing.com/rss/news.rss",
  },

  // ── Macro & Policy (rate decisions, FOMC, economic data) ────────────
  {
    name: "Federal Reserve",
    url: "https://www.federalreserve.gov/feeds/press_all.xml",
  },
  {
    name: "CNBC Economy",
    url: "https://www.cnbc.com/id/20910258/device/rss/rss.html",
  },

  // ── Regulatory Filings (8-K, insider activity) ──────────────────────
  {
    name: "SEC EDGAR Filings",
    url: "https://efts.sec.gov/LATEST/search-index?q=%22Form+8-K%22&dateRange=custom&startdt=" +
      new Date(Date.now() - 86400000).toISOString().split("T")[0] +
      "&enddt=" + new Date().toISOString().split("T")[0] +
      "&forms=8-K",
  },
];

const parser = new Parser({
  timeout: 10000,
  headers: {
    "User-Agent": "Mozilla/5.0 (compatible; TradingAgent/1.0)",
  },
});

/**
 * Fetch news from a single RSS feed
 */
async function fetchFeed(feedUrl: string, sourceName: string): Promise<RSSFeedItem[]> {
  try {
    const feed = await parser.parseURL(feedUrl);
    
    return feed.items.map(item => ({
      title: item.title || "Untitled",
      link: item.link || "",
      pubDate: item.pubDate ? new Date(item.pubDate) : new Date(),
      content: item.content || item["content:encoded"] || "",
      summary: item.contentSnippet || item.summary || "",
      source: sourceName,
    }));
  } catch (error) {
    console.error(`Error fetching RSS feed ${sourceName}:`, error);
    return [];
  }
}

/**
 * Fetch news from all configured RSS feeds
 */
export async function fetchAllRSSFeeds(): Promise<RSSFeedItem[]> {
  const allItems: RSSFeedItem[] = [];

  // Fetch all feeds in parallel
  const results = await Promise.allSettled(
    RSS_FEEDS.map(feed => fetchFeed(feed.url, feed.name))
  );

  for (const result of results) {
    if (result.status === "fulfilled") {
      allItems.push(...result.value);
    }
  }

  // Sort by publication date (newest first)
  allItems.sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());

  // Remove duplicates by URL
  const seen = new Set<string>();
  const unique = allItems.filter(item => {
    if (seen.has(item.link)) {
      return false;
    }
    seen.add(item.link);
    return true;
  });

  return unique;
}

/**
 * Fetch news published after a specific date
 */
export async function fetchRecentRSSNews(since: Date): Promise<RSSFeedItem[]> {
  const allNews = await fetchAllRSSFeeds();
  return allNews.filter(item => item.pubDate > since);
}

/**
 * Filter news by keywords (for specific sectors or stocks)
 */
export function filterNewsByKeywords(
  news: RSSFeedItem[],
  keywords: string[]
): RSSFeedItem[] {
  const lowerKeywords = keywords.map(k => k.toLowerCase());
  
  return news.filter(item => {
    const text = `${item.title} ${item.summary}`.toLowerCase();
    return lowerKeywords.some(keyword => text.includes(keyword));
  });
}

/**
 * Get RSS feeds configuration (for admin/settings)
 */
export function getRSSFeedsConfig() {
  return RSS_FEEDS;
}

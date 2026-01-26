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

// Major financial news RSS feeds
const RSS_FEEDS = [
  {
    name: "Reuters Business",
    url: "https://www.reutersagency.com/feed/?taxonomy=best-topics&post_type=best",
  },
  {
    name: "Yahoo Finance",
    url: "https://finance.yahoo.com/news/rssindex",
  },
  {
    name: "MarketWatch",
    url: "https://www.marketwatch.com/rss/topstories",
  },
  {
    name: "CNBC Markets",
    url: "https://www.cnbc.com/id/10000664/device/rss/rss.html",
  },
  {
    name: "Seeking Alpha",
    url: "https://seekingalpha.com/feed.xml",
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

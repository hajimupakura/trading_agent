import axios from "axios";

/**
 * Social Sentiment Service
 * Aggregates retail investor sentiment from Reddit (public JSON feeds)
 * and options flow data from public sources.
 *
 * No API keys required — uses Reddit's public .json endpoints.
 */

const redditClient = axios.create({
  headers: {
    "User-Agent": "TradingAgent/1.0",
  },
  timeout: 10_000,
});

// ── Types ────────────────────────────────────────────────────────────────────

export interface RedditPost {
  title: string;
  score: number;
  numComments: number;
  subreddit: string;
  url: string;
  created: Date;
  selfText: string;
}

export interface StockMention {
  ticker: string;
  count: number;
  totalScore: number;
  avgSentiment: "bullish" | "bearish" | "neutral";
  posts: Array<{ title: string; score: number; subreddit: string }>;
}

export interface SocialSentimentResult {
  trendingStocks: StockMention[];
  subredditSentiment: Record<string, { bullish: number; bearish: number; neutral: number }>;
  rawPosts: number;
  scrapedAt: Date;
}

// ── Reddit Scraping ──────────────────────────────────────────────────────────

const FINANCE_SUBREDDITS = [
  "wallstreetbets",
  "stocks",
  "investing",
  "options",
  "StockMarket",
];

/**
 * Fetch recent posts from a subreddit using Reddit's public JSON API.
 */
async function fetchSubredditPosts(
  subreddit: string,
  sort: "hot" | "new" | "top" = "hot",
  limit: number = 25,
): Promise<RedditPost[]> {
  try {
    const res = await redditClient.get(
      `https://www.reddit.com/r/${subreddit}/${sort}.json?limit=${limit}&t=day`
    );

    if (!res.data?.data?.children) return [];

    return res.data.data.children
      .filter((child: any) => child.kind === "t3")
      .map((child: any) => {
        const d = child.data;
        return {
          title: d.title || "",
          score: d.score || 0,
          numComments: d.num_comments || 0,
          subreddit: d.subreddit || subreddit,
          url: `https://reddit.com${d.permalink}`,
          created: new Date(d.created_utc * 1000),
          selfText: (d.selftext || "").slice(0, 500), // Truncate
        };
      });
  } catch (error: any) {
    console.error(`[Social] Error fetching r/${subreddit}:`, error.message);
    return [];
  }
}

/**
 * Extract stock ticker mentions from text.
 * Looks for $TICKER patterns and common ticker formats.
 */
function extractTickers(text: string): string[] {
  const tickers = new Set<string>();

  // Match $TICKER pattern
  const dollarMatches = text.match(/\$([A-Z]{1,5})\b/g);
  if (dollarMatches) {
    dollarMatches.forEach(m => tickers.add(m.replace("$", "")));
  }

  // Match standalone uppercase tickers (2-5 chars) that look like tickers
  // Filter out common words
  const COMMON_WORDS = new Set([
    "THE", "AND", "FOR", "ARE", "BUT", "NOT", "YOU", "ALL", "CAN", "HER",
    "WAS", "ONE", "OUR", "OUT", "DAY", "HAD", "HAS", "HIS", "HOW", "ITS",
    "MAY", "NEW", "NOW", "OLD", "SEE", "WAY", "WHO", "BOY", "DID", "GET",
    "LET", "SAY", "SHE", "TOO", "USE", "CEO", "IPO", "ATH", "DD", "YOLO",
    "IMO", "FOMO", "LOL", "WSB", "EPS", "PE", "ETF", "SEC", "FDA", "GDP",
    "CPI", "FOMC", "FED", "PUT", "CALL", "ITM", "OTM", "ATM", "IV",
    "EDIT", "JUST", "LIKE", "WHAT", "THIS", "THAT", "WITH", "FROM",
    "BEEN", "HAVE", "WILL", "MORE", "WHEN", "THAN", "THEM", "INTO",
    "SOME", "VERY", "MUCH", "MOST", "ALSO", "NEXT", "HOLD", "SELL", "BUY",
  ]);

  const words = text.split(/[\s,.\-!?()[\]{}:;"']+/);
  words.forEach(word => {
    if (word.length >= 2 && word.length <= 5 && /^[A-Z]+$/.test(word) && !COMMON_WORDS.has(word)) {
      tickers.add(word);
    }
  });

  return Array.from(tickers);
}

/**
 * Simple rule-based sentiment from title/text.
 */
function analyzeSentiment(text: string): "bullish" | "bearish" | "neutral" {
  const lower = text.toLowerCase();

  const bullishWords = [
    "moon", "rocket", "buy", "calls", "bullish", "squeeze", "breakout",
    "undervalued", "long", "green", "pump", "tendies", "gain", "profit",
    "rally", "soar", "surge", "beat", "upgrade",
  ];
  const bearishWords = [
    "crash", "puts", "bearish", "overvalued", "short", "red", "dump",
    "loss", "sell", "tank", "plunge", "drop", "downgrade", "miss",
    "bankrupt", "recession", "bubble", "fraud",
  ];

  let bullCount = 0;
  let bearCount = 0;

  bullishWords.forEach(w => { if (lower.includes(w)) bullCount++; });
  bearishWords.forEach(w => { if (lower.includes(w)) bearCount++; });

  if (bullCount > bearCount + 1) return "bullish";
  if (bearCount > bullCount + 1) return "bearish";
  return "neutral";
}

// ── Main Functions ───────────────────────────────────────────────────────────

/**
 * Scan financial subreddits for trending stocks and sentiment.
 */
export async function scanRedditSentiment(): Promise<SocialSentimentResult> {
  const allPosts: RedditPost[] = [];

  // Fetch from all subreddits with small delay between
  for (const sub of FINANCE_SUBREDDITS) {
    const posts = await fetchSubredditPosts(sub, "hot", 25);
    allPosts.push(...posts);
    await new Promise(r => setTimeout(r, 500)); // Rate limit courtesy
  }

  // Extract and count ticker mentions
  const tickerMentions = new Map<string, {
    count: number;
    totalScore: number;
    sentiments: Array<"bullish" | "bearish" | "neutral">;
    posts: Array<{ title: string; score: number; subreddit: string }>;
  }>();

  for (const post of allPosts) {
    const text = `${post.title} ${post.selfText}`;
    const tickers = extractTickers(text);
    const sentiment = analyzeSentiment(text);

    for (const ticker of tickers) {
      const existing = tickerMentions.get(ticker) || {
        count: 0, totalScore: 0, sentiments: [], posts: [],
      };
      existing.count++;
      existing.totalScore += post.score;
      existing.sentiments.push(sentiment);
      existing.posts.push({ title: post.title, score: post.score, subreddit: post.subreddit });
      tickerMentions.set(ticker, existing);
    }
  }

  // Convert to sorted array (by mention count)
  const trendingStocks: StockMention[] = Array.from(tickerMentions.entries())
    .filter(([_, data]) => data.count >= 2) // At least 2 mentions
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 20)
    .map(([ticker, data]) => {
      const bullish = data.sentiments.filter(s => s === "bullish").length;
      const bearish = data.sentiments.filter(s => s === "bearish").length;
      const avgSentiment: "bullish" | "bearish" | "neutral" =
        bullish > bearish ? "bullish" : bearish > bullish ? "bearish" : "neutral";

      return {
        ticker,
        count: data.count,
        totalScore: data.totalScore,
        avgSentiment,
        posts: data.posts.slice(0, 3),
      };
    });

  // Subreddit-level sentiment
  const subredditSentiment: Record<string, { bullish: number; bearish: number; neutral: number }> = {};
  for (const post of allPosts) {
    if (!subredditSentiment[post.subreddit]) {
      subredditSentiment[post.subreddit] = { bullish: 0, bearish: 0, neutral: 0 };
    }
    const sent = analyzeSentiment(`${post.title} ${post.selfText}`);
    subredditSentiment[post.subreddit]![sent]++;
  }

  return {
    trendingStocks,
    subredditSentiment,
    rawPosts: allPosts.length,
    scrapedAt: new Date(),
  };
}

/**
 * Format social sentiment as a concise string for LLM prompts.
 */
export function formatSentimentForPrompt(result: SocialSentimentResult): string {
  if (result.trendingStocks.length === 0) return "";

  const lines: string[] = [
    `SOCIAL SENTIMENT (Reddit — ${result.rawPosts} posts from ${FINANCE_SUBREDDITS.join(", ")}):`,
    "",
    "Trending stocks by mention count:",
  ];

  for (const stock of result.trendingStocks.slice(0, 10)) {
    lines.push(
      `  ${stock.ticker}: ${stock.count} mentions, sentiment=${stock.avgSentiment}, score=${stock.totalScore}`
    );
  }

  // Overall subreddit mood
  lines.push("");
  lines.push("Subreddit mood:");
  for (const [sub, sent] of Object.entries(result.subredditSentiment)) {
    const total = sent.bullish + sent.bearish + sent.neutral;
    if (total === 0) continue;
    const bullPct = Math.round((sent.bullish / total) * 100);
    lines.push(`  r/${sub}: ${bullPct}% bullish (${total} posts)`);
  }

  return lines.join("\n");
}

/**
 * Get sentiment for specific tickers from Reddit.
 */
export async function getTickerSentiment(tickers: string[]): Promise<Map<string, "bullish" | "bearish" | "neutral">> {
  const result = await scanRedditSentiment();
  const sentimentMap = new Map<string, "bullish" | "bearish" | "neutral">();

  for (const ticker of tickers) {
    const found = result.trendingStocks.find(s => s.ticker === ticker.toUpperCase());
    sentimentMap.set(ticker.toUpperCase(), found?.avgSentiment || "neutral");
  }

  return sentimentMap;
}

import { invokeLLM } from "../_core/llm";
import Parser from "rss-parser";

/**
 * Geopolitical Event Detection & Classification Engine
 *
 * Scans geopolitical news feeds, classifies events into categories,
 * and maps them to ETF trade templates for the trading agent.
 *
 * Uses existing LLM infrastructure — no additional API keys needed.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type EventCategory =
  | "WAR_ESCALATION"
  | "WAR_DE_ESCALATION"
  | "SANCTIONS_NEW"
  | "SANCTIONS_LIFTED"
  | "FED_HAWKISH"
  | "FED_DOVISH"
  | "TRADE_WAR_ESCALATION"
  | "TRADE_WAR_DE_ESCALATION"
  | "BLACK_SWAN"
  | "POLITICAL_CRISIS"
  | "NONE";

export interface GeopoliticalEvent {
  category: EventCategory;
  headline: string;
  summary: string;
  confidence: number; // 0-100
  sentiment: "risk_on" | "risk_off" | "neutral";
  affectedRegions: string[];
  timestamp: Date;
  source: string;
  tradeTemplate: TradeTemplate | null;
}

export interface TradeTemplate {
  name: string;
  longETFs: string[];
  shortETFs: string[]; // inverse ETFs to buy
  sizing: number; // % of portfolio per leg
  stopLoss: number; // % below entry
  targets: number[]; // scale-out levels (% above entry)
}

// ── Trade Templates ──────────────────────────────────────────────────────────

const TRADE_TEMPLATES: Record<string, TradeTemplate> = {
  WAR_ESCALATION: {
    name: "Geopolitical Escalation",
    longETFs: ["GLD", "USO"],
    shortETFs: ["SQQQ"],
    sizing: 2,
    stopLoss: 1.5,
    targets: [2, 4],
  },
  WAR_DE_ESCALATION: {
    name: "Geopolitical De-escalation",
    longETFs: ["SPY", "QQQ"],
    shortETFs: [],
    sizing: 3,
    stopLoss: 1.5,
    targets: [2, 3],
  },
  SANCTIONS_NEW: {
    name: "New Sanctions",
    longETFs: ["GLD"],
    shortETFs: ["SQQQ"],
    sizing: 1.5,
    stopLoss: 1.5,
    targets: [2, 3],
  },
  SANCTIONS_LIFTED: {
    name: "Sanctions Relief",
    longETFs: ["SPY", "QQQ"],
    shortETFs: [],
    sizing: 2,
    stopLoss: 1.5,
    targets: [2, 3],
  },
  FED_HAWKISH: {
    name: "Fed Hawkish Surprise",
    longETFs: [],
    shortETFs: ["SQQQ"],
    sizing: 2,
    stopLoss: 1,
    targets: [1.5, 3],
  },
  FED_DOVISH: {
    name: "Fed Dovish Surprise",
    longETFs: ["SPY", "QQQ", "TLT"],
    shortETFs: [],
    sizing: 2,
    stopLoss: 1,
    targets: [1.5, 3],
  },
  TRADE_WAR_ESCALATION: {
    name: "Trade War Escalation",
    longETFs: ["GLD"],
    shortETFs: ["SQQQ"],
    sizing: 2,
    stopLoss: 1.5,
    targets: [2, 3],
  },
  TRADE_WAR_DE_ESCALATION: {
    name: "Trade War De-escalation",
    longETFs: ["SPY", "QQQ"],
    shortETFs: [],
    sizing: 3,
    stopLoss: 1.5,
    targets: [2, 3],
  },
  BLACK_SWAN: {
    name: "Black Swan Event",
    longETFs: ["GLD", "TLT"],
    shortETFs: ["SQQQ"],
    sizing: 1.5,
    stopLoss: 2,
    targets: [3, 5],
  },
  POLITICAL_CRISIS: {
    name: "Political Crisis",
    longETFs: ["GLD"],
    shortETFs: ["SQQQ"],
    sizing: 1.5,
    stopLoss: 1.5,
    targets: [2, 4],
  },
};

// ── Geopolitical RSS Feeds ───────────────────────────────────────────────────

const GEO_FEEDS = [
  { name: "Reuters World", url: "https://www.reutersagency.com/feed/?taxonomy=best-regions&post_type=best" },
  { name: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  { name: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml" },
  { name: "AP World", url: "https://rsshub.app/apnews/topics/world-news" },
  { name: "CNBC World", url: "https://www.cnbc.com/id/100727362/device/rss/rss.html" },
  { name: "Defense One", url: "https://www.defenseone.com/rss/all/" },
];

const parser = new Parser({
  timeout: 8000,
  headers: { "User-Agent": "Mozilla/5.0 (compatible; TradingAgent/1.0)" },
});

// ── Cache ────────────────────────────────────────────────────────────────────

let cachedEvents: GeopoliticalEvent[] = [];
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ── Core Functions ───────────────────────────────────────────────────────────

/**
 * Fetch geopolitical news from RSS feeds and classify events.
 * Returns only events with confidence ≥ 50.
 */
export async function scanGeopoliticalEvents(): Promise<GeopoliticalEvent[]> {
  const now = Date.now();
  if (cachedEvents.length > 0 && now - cacheTime < CACHE_TTL) return cachedEvents;

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000); // last 24h
  const headlines: Array<{ title: string; summary: string; source: string; date: Date }> = [];

  // Fetch all feeds in parallel
  const feedResults = await Promise.allSettled(
    GEO_FEEDS.map(async (feed) => {
      try {
        const parsed = await parser.parseURL(feed.url);
        return (parsed.items || [])
          .filter((item) => {
            const pubDate = item.pubDate ? new Date(item.pubDate) : new Date();
            return pubDate >= cutoff;
          })
          .slice(0, 10)
          .map((item) => ({
            title: item.title || "",
            summary: (item.contentSnippet || item.content || "").slice(0, 200),
            source: feed.name,
            date: item.pubDate ? new Date(item.pubDate) : new Date(),
          }));
      } catch {
        return [];
      }
    }),
  );

  for (const result of feedResults) {
    if (result.status === "fulfilled") headlines.push(...result.value);
  }

  if (headlines.length === 0) {
    cachedEvents = [];
    cacheTime = now;
    return [];
  }

  // Sort by recency, take top 30
  headlines.sort((a, b) => b.date.getTime() - a.date.getTime());
  const topHeadlines = headlines.slice(0, 30);

  // Classify via LLM
  const events = await classifyEvents(topHeadlines);
  cachedEvents = events.filter((e) => e.confidence >= 50);
  cacheTime = now;

  console.log(`[GeoEngine] Scanned ${headlines.length} headlines, detected ${cachedEvents.length} events`);
  return cachedEvents;
}

async function classifyEvents(
  headlines: Array<{ title: string; summary: string; source: string; date: Date }>,
): Promise<GeopoliticalEvent[]> {
  const headlineText = headlines
    .map((h, i) => `${i + 1}. [${h.source}] ${h.title} — ${h.summary}`)
    .join("\n");

  try {
    const result = await invokeLLM({
      messages: [
        {
          role: "system",
          content: `You are a geopolitical event classifier for a trading system. Analyze news headlines and identify market-moving geopolitical events.

For each significant event, output a JSON array with objects:
{
  "index": <headline number>,
  "category": "WAR_ESCALATION" | "WAR_DE_ESCALATION" | "SANCTIONS_NEW" | "SANCTIONS_LIFTED" | "FED_HAWKISH" | "FED_DOVISH" | "TRADE_WAR_ESCALATION" | "TRADE_WAR_DE_ESCALATION" | "BLACK_SWAN" | "POLITICAL_CRISIS" | "NONE",
  "confidence": 0-100,
  "sentiment": "risk_on" | "risk_off" | "neutral",
  "regions": ["country/region names"],
  "summary": "1-sentence market impact"
}

RULES:
- Only include events with confidence ≥ 40. Skip routine/non-impactful news.
- WAR_ESCALATION: military action, invasion, bombing, troop deployment
- WAR_DE_ESCALATION: ceasefire, peace talks, withdrawal, treaty
- SANCTIONS_NEW: new sanctions, trade restrictions, asset freezes
- FED_HAWKISH: rate hike, hawkish language, tightening signals
- FED_DOVISH: rate cut, dovish language, stimulus, QE
- TRADE_WAR: tariffs, trade barriers, retaliatory measures
- BLACK_SWAN: unexpected catastrophic events, pandemic, financial crisis
- POLITICAL_CRISIS: coups, regime change, election crisis
- Respond with ONLY a JSON array. No markdown.`,
        },
        { role: "user", content: `Classify these headlines:\n\n${headlineText}` },
      ],
      maxTokens: 1500,
    });

    const text = (result.text || "").trim();
    // Extract JSON array
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const parsed: any[] = JSON.parse(jsonMatch[0]);
    return parsed
      .filter((e: any) => e.category && e.category !== "NONE")
      .map((e: any) => {
        const headline = headlines[e.index - 1];
        const category = e.category as EventCategory;
        return {
          category,
          headline: headline?.title || "",
          summary: e.summary || "",
          confidence: e.confidence || 0,
          sentiment: e.sentiment || "neutral",
          affectedRegions: e.regions || [],
          timestamp: headline?.date || new Date(),
          source: headline?.source || "",
          tradeTemplate: TRADE_TEMPLATES[category] || null,
        };
      });
  } catch (error: any) {
    console.error("[GeoEngine] Classification failed:", error.message);
    return [];
  }
}

/**
 * Get the highest-confidence event suitable for immediate trading.
 * Returns null if no event meets the rapid execution threshold.
 */
export async function getHighConfidenceEvent(
  minConfidence: number = 80,
): Promise<GeopoliticalEvent | null> {
  const events = await scanGeopoliticalEvents();
  const candidates = events
    .filter((e) => e.confidence >= minConfidence && e.tradeTemplate)
    .sort((a, b) => b.confidence - a.confidence);
  return candidates[0] || null;
}

/**
 * Get a text summary of current geopolitical events for the trading agent.
 */
export async function getGeopoliticalSummaryForAgent(): Promise<string> {
  const events = await scanGeopoliticalEvents();
  if (events.length === 0) return "No significant geopolitical events detected in the last 24 hours.";

  const lines = events.map(
    (e) =>
      `- [${e.category}] (conf=${e.confidence}%) ${e.headline} — ${e.summary} | Sentiment: ${e.sentiment} | Template: ${e.tradeTemplate?.name || "none"}`,
  );
  return `GEOPOLITICAL EVENTS (${events.length} detected):\n${lines.join("\n")}`;
}

/**
 * Get trade template for a specific event category.
 */
export function getTradeTemplate(category: EventCategory): TradeTemplate | null {
  return TRADE_TEMPLATES[category] || null;
}

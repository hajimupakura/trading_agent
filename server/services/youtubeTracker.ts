import { invokeLLM } from "../_core/llm";

/**
 * YouTube influencer tracking service
 * Aggregates and summarizes trading YouTube content
 */

export interface YouTubeVideo {
  videoId: string;
  title: string;
  description: string;
  publishedAt: Date;
  thumbnailUrl: string;
  videoUrl: string;
  channelName: string;
}

export interface VideoAnalysis {
  aiSummary: string;
  keyTakeaways: string[];
  mentionedStocks: string[];
  sentiment: "bullish" | "bearish" | "neutral";
  sectors: string[];
  tradingSignals: string[];
}

/**
 * Fetch recent videos from a YouTube channel (mock implementation)
 * In production, this would use YouTube Data API or web scraping
 */
export async function fetchChannelVideos(channelId: string, maxResults: number = 10): Promise<YouTubeVideo[]> {
  // Mock data for demonstration
  // In production, implement actual YouTube API integration
  return [
    {
      videoId: "mock_video_1",
      title: "NVDA Stock Analysis - AI Boom Continues",
      description: "Deep dive into NVIDIA's latest earnings and AI chip demand...",
      publishedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
      thumbnailUrl: "https://i.ytimg.com/vi/mock_video_1/default.jpg",
      videoUrl: `https://www.youtube.com/watch?v=mock_video_1`,
      channelName: "Tech Trader",
    },
    {
      videoId: "mock_video_2",
      title: "Gold Rally - Why Metals Are Surging",
      description: "Analysis of the current gold and silver rally...",
      publishedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      thumbnailUrl: "https://i.ytimg.com/vi/mock_video_2/default.jpg",
      videoUrl: `https://www.youtube.com/watch?v=mock_video_2`,
      channelName: "Market Insights",
    },
  ];
}

/**
 * Analyze YouTube video content using AI
 */
export async function analyzeYouTubeVideo(video: YouTubeVideo): Promise<VideoAnalysis> {
  try {
    const response = await invokeLLM({
      messages: [
        {
          role: "system",
          content: `You are a financial analyst extracting trading insights from YouTube video content.

Your task: Analyze the video title and description to extract:
1. Key takeaways and main points
2. Mentioned stock tickers
3. Overall sentiment (bullish/bearish/neutral)
4. Relevant sectors
5. Specific trading signals or recommendations

Be specific and actionable. Extract concrete trading ideas, not generic commentary.`,
        },
        {
          role: "user",
          content: `Analyze this YouTube video:

Title: ${video.title}
Description: ${video.description}
Channel: ${video.channelName}
Published: ${video.publishedAt.toISOString()}

Extract trading insights and recommendations.`,
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "video_analysis",
          strict: true,
          schema: {
            type: "object",
            properties: {
              aiSummary: {
                type: "string",
                description: "Concise summary of the video content (2-3 sentences)",
              },
              keyTakeaways: {
                type: "array",
                items: { type: "string" },
                description: "3-5 key points from the video",
              },
              mentionedStocks: {
                type: "array",
                items: { type: "string" },
                description: "Stock tickers mentioned",
              },
              sentiment: {
                type: "string",
                enum: ["bullish", "bearish", "neutral"],
                description: "Overall market sentiment",
              },
              sectors: {
                type: "array",
                items: { type: "string" },
                description: "Sectors discussed",
              },
              tradingSignals: {
                type: "array",
                items: { type: "string" },
                description: "Specific buy/sell recommendations or trading ideas",
              },
            },
            required: ["aiSummary", "keyTakeaways", "mentionedStocks", "sentiment", "sectors", "tradingSignals"],
            additionalProperties: false,
          },
        },
      },
    });

    const content = response.choices[0]?.message?.content;
    if (!content || typeof content !== "string") {
      throw new Error("Invalid LLM response");
    }

    return JSON.parse(content) as VideoAnalysis;
  } catch (error) {
    console.error("Error analyzing YouTube video:", error);
    // Return default analysis on error
    return {
      aiSummary: `Video about ${video.title}`,
      keyTakeaways: ["Unable to analyze video content"],
      mentionedStocks: [],
      sentiment: "neutral",
      sectors: [],
      tradingSignals: [],
    };
  }
}

/**
 * Get mock YouTube videos for demonstration
 */
export function getMockYouTubeVideos(): YouTubeVideo[] {
  return [
    {
      videoId: "demo_1",
      title: "NVIDIA Earnings Beat - AI Demand Explodes",
      description: "NVIDIA just reported incredible earnings. AI chip demand is through the roof. Here's my analysis and price targets for NVDA stock.",
      publishedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
      thumbnailUrl: "https://i.ytimg.com/vi/demo_1/default.jpg",
      videoUrl: "https://www.youtube.com/watch?v=demo_1",
      channelName: "Tech Stock Trader",
    },
    {
      videoId: "demo_2",
      title: "Gold & Silver Breaking Out - Metals Rally Just Starting",
      description: "Gold hit new all-time highs and silver is catching up fast. I'm buying mining stocks. Here are my top picks: GOLD, NEM, AG.",
      publishedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      thumbnailUrl: "https://i.ytimg.com/vi/demo_2/default.jpg",
      videoUrl: "https://www.youtube.com/watch?v=demo_2",
      channelName: "Commodity Investor",
    },
    {
      videoId: "demo_3",
      title: "Tesla Stock WARNING - Production Issues Ahead",
      description: "Tesla's production numbers are concerning. I'm bearish on TSLA short-term. Consider buying puts or staying on the sidelines.",
      publishedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      thumbnailUrl: "https://i.ytimg.com/vi/demo_3/default.jpg",
      videoUrl: "https://www.youtube.com/watch?v=demo_3",
      channelName: "EV Stock Analysis",
    },
    {
      videoId: "demo_4",
      title: "Quantum Computing Stocks EXPLODING - IONQ, RGTI, QUBT",
      description: "Quantum computing stocks are having a massive rally. IONQ up 150% this month. Here's why this sector is just getting started.",
      publishedAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000),
      thumbnailUrl: "https://i.ytimg.com/vi/demo_4/default.jpg",
      videoUrl: "https://www.youtube.com/watch?v=demo_4",
      channelName: "Future Tech Investor",
    },
  ];
}

/**
 * Convert mock video to database format
 */
export function convertToYouTubeVideo(video: YouTubeVideo, influencerId: number) {
  return {
    influencerId,
    videoId: video.videoId,
    title: video.title,
    description: video.description,
    publishedAt: video.publishedAt,
    thumbnailUrl: video.thumbnailUrl,
    videoUrl: video.videoUrl,
  };
}

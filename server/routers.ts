import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { z } from "zod";
import { syncRSSNews, analyzePendingNews } from "./services/rssNewsSync";
import { getStockQuote, getMultipleStockQuotes, searchStocks } from "./services/stockPriceService";

export const appRouter = router({
    // if you need to use socket.io, read and register route in server/_core/index.ts, all api should start with '/api/' so that the gateway can route correctly
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),

  // News feed
  news: router({
    recent: publicProcedure.query(async () => {
      const { getRecentNews } = await import("./db");
      return await getRecentNews(50);
    }),
    analyze: protectedProcedure.mutation(async () => {
      // Trigger news analysis for recent articles
      const { getRecentNews, insertNewsArticle } = await import("./db");
      const { getMockNewsArticles, convertToNewsArticle } = await import("./services/newsScraper");
      const { analyzeNewsArticle } = await import("./services/sentimentAnalysis");
      
      const mockArticles = getMockNewsArticles();
      const results = [];
      
      for (const article of mockArticles) {
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
        
        try {
          await insertNewsArticle(newsArticle);
          results.push(newsArticle);
        } catch (error) {
          console.error("Error inserting news article:", error);
        }
      }
      
      return { success: true, count: results.length };
    }),
  }),
  
  // Watchlist management
  watchlist: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      const { getUserWatchlist } = await import("./db");
      return await getUserWatchlist(ctx.user.id);
    }),
    add: protectedProcedure
      .input(z.object({
        ticker: z.string(),
        name: z.string().optional(),
        isPriority: z.boolean().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const { addToWatchlist } = await import("./db");
        await addToWatchlist({
          userId: ctx.user.id,
          ticker: input.ticker,
          name: input.name || null,
          isPriority: input.isPriority ? 1 : 0,
        });
        return { success: true };
      }),
    remove: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        const { removeFromWatchlist } = await import("./db");
        await removeFromWatchlist(input.id, ctx.user.id);
        return { success: true };
      }),
  }),
  
  // ARK Invest trades
  ark: router({
    recentTrades: publicProcedure.query(async () => {
      const { getRecentArkTrades } = await import("./db");
      return await getRecentArkTrades(100);
    }),
    syncTrades: protectedProcedure.mutation(async () => {
      const { getMockArkTrades, convertToArkTrade } = await import("./services/arkTracker");
      const { insertArkTrade } = await import("./db");
      
      const trades = getMockArkTrades();
      let count = 0;
      
      for (const trade of trades) {
        try {
          await insertArkTrade(convertToArkTrade(trade));
          count++;
        } catch (error) {
          console.error("Error inserting ARK trade:", error);
        }
      }
      
      return { success: true, count };
    }),
  }),
  
  // Alerts
  alerts: router({
    list: protectedProcedure
      .input(z.object({ unreadOnly: z.boolean().optional() }).optional())
      .query(async ({ ctx, input }) => {
        const { getUserAlerts } = await import("./db");
        return await getUserAlerts(ctx.user.id, input?.unreadOnly || false);
      }),
    markRead: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        const { markAlertAsRead } = await import("./db");
        await markAlertAsRead(input.id, ctx.user.id);
        return { success: true };
      }),
  }),
  
  // Rally events
  rallies: router({
    list: publicProcedure
      .input(z.object({ status: z.enum(["ongoing", "ended", "potential"]).optional() }).optional())
      .query(async ({ input }) => {
        const { getRallyEvents } = await import("./db");
        return await getRallyEvents(input?.status);
      }),
    seed: protectedProcedure.mutation(async () => {
      const { seedHistoricalRallies } = await import("./services/seedHistoricalRallies");
      await seedHistoricalRallies();
      return { success: true };
    }),
    insights: publicProcedure
      .input(z.object({ sector: z.string() }))
      .query(async ({ input }) => {
        const { getRallyInsights } = await import("./services/seedHistoricalRallies");
        return { insights: getRallyInsights(input.sector) };
      }),
  }),
  
  // Sector momentum
  sectors: router({
    momentum: publicProcedure.query(async () => {
      const { getLatestSectorMomentum } = await import("./db");
      return await getLatestSectorMomentum();
    }),
    discover: protectedProcedure.mutation(async () => {
      const { discoverEmergingSectors } = await import("./services/sectorDiscovery");
      const { getRecentNews } = await import("./db");
      const recentNews = await getRecentNews(50);
      const sectors = await discoverEmergingSectors(recentNews);
      return { sectors, count: sectors.length };
    }),
  }),
  
  // Rally predictions
  predictions: router({
    upcoming: publicProcedure.query(async () => {
      const { getPredictedRallies } = await import("./db");
      return await getPredictedRallies();
    }),
    generate: publicProcedure.mutation(async () => {
      const { predictUpcomingRallies, extractHistoricalPatterns } = await import("./services/rallyPrediction");
      const { getRecentNews, getHistoricalRallies, insertRallyPrediction } = await import("./db");
      
      console.log("[Rally Predictions] Starting generation...");
      
      const recentNews = await getRecentNews(100);
      console.log("[Rally Predictions] Fetched", recentNews.length, "news articles");
      
      const historicalRallies = await getHistoricalRallies();
      console.log("[Rally Predictions] Fetched", historicalRallies.length, "historical rallies");
      
      const patterns = extractHistoricalPatterns(historicalRallies);
      console.log("[Rally Predictions] Extracted", patterns.length, "patterns");
      
      console.log("[Rally Predictions] Calling AI...");
      const predictions = await predictUpcomingRallies(recentNews, patterns);
      console.log("[Rally Predictions] AI generated", predictions.length, "predictions");
      
      // Save predictions to database
      for (const pred of predictions) {
        const isPut = pred.opportunityType === "put" || pred.direction === "down";
        const opportunityLabel = isPut ? "Decline" : "Rally";
        
        await insertRallyPrediction({
          sector: pred.sector,
          name: `Predicted ${pred.sector} ${opportunityLabel}`,
          startDate: new Date(),
          description: pred.reasoning,
          predictionConfidence: Math.round(pred.confidence),
          earlySignals: JSON.stringify(pred.earlySignals),
          keyStocks: JSON.stringify(pred.recommendedStocks),
          // Store additional fields in catalysts as JSON
          catalysts: JSON.stringify({
            opportunityType: pred.opportunityType || (isPut ? "put" : "call"),
            direction: pred.direction || (isPut ? "down" : "up"),
            timeframe: pred.timeframe,
            entryTiming: pred.entryTiming,
            exitStrategy: pred.exitStrategy,
            reasoning: pred.reasoning, // Also store here for easy access
          }),
        });
      }
      
      console.log("[Rally Predictions] Saved", predictions.length, "predictions to database");
      
      return { success: true, count: predictions.length, predictions };
    }),
  }),
  
  // YouTube influencers
  youtube: router({
    influencers: protectedProcedure
      .input(z.object({ userId: z.number() }))
      .query(async ({ input }) => {
        const { getUserYoutubeInfluencers } = await import("./db");
        return await getUserYoutubeInfluencers(input.userId);
      }),
    addInfluencer: protectedProcedure
      .input(z.object({
        userId: z.number(),
        channelId: z.string(),
        channelName: z.string(),
        channelUrl: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        const { insertYoutubeInfluencer } = await import("./db");
        await insertYoutubeInfluencer(input);
        return { success: true };
      }),
    recentVideos: publicProcedure.query(async () => {
      const { getRecentYoutubeVideos } = await import("./db");
      return await getRecentYoutubeVideos(20);
    }),
    syncVideos: protectedProcedure.mutation(async () => {
      const { getMockYouTubeVideos, analyzeYouTubeVideo } = await import("./services/youtubeTracker");
      const { insertYoutubeVideo } = await import("./db");
      
      const videos = getMockYouTubeVideos();
      let count = 0;
      
      for (const video of videos) {
        try {
          const analysis = await analyzeYouTubeVideo(video);
          await insertYoutubeVideo({
            influencerId: 1, // Default influencer for demo
            videoId: video.videoId,
            title: video.title,
            description: video.description,
            publishedAt: video.publishedAt,
            thumbnailUrl: video.thumbnailUrl,
            videoUrl: video.videoUrl,
            aiSummary: analysis.aiSummary,
            keyTakeaways: JSON.stringify(analysis.keyTakeaways),
            mentionedStocks: JSON.stringify(analysis.mentionedStocks),
            sentiment: analysis.sentiment,
            sectors: JSON.stringify(analysis.sectors),
            tradingSignals: JSON.stringify(analysis.tradingSignals),
          });
          count++;
        } catch (error) {
          console.error(`Failed to sync video ${video.videoId}:`, error);
        }
      }
      
      return { success: true, count };
    }),
  }),

  // Stock prices
  stocks: router({
    getQuote: publicProcedure
      .input(z.object({ symbol: z.string() }))
      .query(async ({ input }) => {
        return await getStockQuote(input.symbol);
      }),
    
    getMultipleQuotes: publicProcedure
      .input(z.object({ symbols: z.array(z.string()) }))
      .query(async ({ input }) => {
        const quotes = await getMultipleStockQuotes(input.symbols);
        return Object.fromEntries(quotes);
      }),
    
    search: publicProcedure
      .input(z.object({ query: z.string() }))
      .query(async ({ input }) => {
        return await searchStocks(input.query);
      }),
  }),

  // Manual sync triggers
  sync: router({
    rssNews: protectedProcedure
      .mutation(async () => {
        const result = await syncRSSNews();
        return result;
      }),
    
    analyzeNews: protectedProcedure
      .mutation(async () => {
        const result = await analyzePendingNews();
        return result;
      }),
  }),
});

export type AppRouter = typeof appRouter;

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

    scrapeNews: publicProcedure
      .input(z.object({ topics: z.array(z.string()) }))
      .mutation(async ({ input }) => {
        const { scrapeFinancialNews } = await import("./services/aiBrowserAgent");
        const { analyzeNewsArticle } = await import("./services/sentimentAnalysis");
        const { insertNewsArticle } = await import("./db");

        console.log("[News AI Scraper] Starting scrape for topics:", input.topics);
        try {
          const articles = await scrapeFinancialNews(input.topics);
          console.log("[News AI Scraper] Found", articles.length, "articles");

          if (articles.length === 0) {
            throw new Error("No articles found. The AI scraper may have failed to extract data from news sources.");
          }

          let count = 0;

          for (const article of articles) {
            try {
              // Normalize the data structure
              const normalizedArticle = {
                title: article.title,
                description: article.description || article.summary || "",
                url: article.url || article.link || "",
                source: article.source || "AI Scraped",
                publishedAt: article.date ? new Date(article.date) : (article.publishedAt ? new Date(article.publishedAt) : new Date()),
              };

              const analysis = await analyzeNewsArticle(normalizedArticle);

              await insertNewsArticle({
                ...normalizedArticle,
                sentiment: analysis.sentiment,
                potentialTerm: analysis.potentialTerm,
                aiSummary: analysis.aiSummary,
                mentionedStocks: JSON.stringify(analysis.mentionedStocks),
                sectors: JSON.stringify(analysis.sectors),
                rallyIndicator: analysis.rallyIndicator,
              });
              count++;
              console.log(`[News AI Scraper] Analyzed and saved: ${normalizedArticle.title}`);
            } catch (error) {
              console.error("[News AI Scraper] Failed to process article:", error);
            }
          }

          return { success: true, count, articles };
        } catch (error: any) {
          console.error("[News AI Scraper] Scraping failed:", error);
          throw new Error(`Failed to scrape news: ${error.message}`);
        }
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

    scrapeTrades: publicProcedure.mutation(async () => {
      const { scrapeARKTrades } = await import("./services/aiBrowserAgent");
      const { insertArkTrade } = await import("./db");

      console.log("[ARK AI Scraper] Starting scrape...");
      try {
        const trades = await scrapeARKTrades();
        console.log("[ARK AI Scraper] Found", trades.length, "trades");

        if (trades.length === 0) {
          throw new Error("No trades found. The AI scraper may have failed to extract data from ark-funds.com");
        }

        let count = 0;

        for (const trade of trades) {
          try {
            // Normalize the data structure from AI Browser Agent
            const normalizedTrade = {
              ticker: trade.ticker || trade.symbol,
              fund: trade.fund || trade.fundName || "ARKK",
              direction: trade.direction?.toLowerCase() || trade.type?.toLowerCase() || "buy",
              shares: trade.shares || trade.quantity || 0,
              date: trade.date ? new Date(trade.date) : new Date(),
              percentOfEtf: trade.percentOfEtf || trade.weight || null,
            };

            await insertArkTrade(normalizedTrade);
            count++;
            console.log(`[ARK AI Scraper] Saved trade: ${normalizedTrade.ticker} - ${normalizedTrade.direction}`);
          } catch (error) {
            console.error("[ARK AI Scraper] Failed to process trade:", error);
          }
        }

        return { success: true, count, trades };
      } catch (error: any) {
        console.error("[ARK AI Scraper] Scraping failed:", error);
        throw new Error(`Failed to scrape ARK trades: ${error.message}`);
      }
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
        
        // Fetch initial prices for backtesting
        let initialPrices: { [key: string]: number } = {};
        if (pred.recommendedStocks && pred.recommendedStocks.length > 0) {
          const quotes = await getMultipleStockQuotes(pred.recommendedStocks);
          for (const [symbol, quote] of quotes.entries()) {
            initialPrices[symbol] = quote.currentPrice;
          }
        }

        await insertRallyPrediction({
          sector: pred.sector,
          name: `Predicted ${pred.sector} ${opportunityLabel}`,
          startDate: new Date(),
          description: pred.reasoning,
          predictionConfidence: Math.round(pred.confidence),
          earlySignals: JSON.stringify(pred.earlySignals),
          keyStocks: JSON.stringify(pred.recommendedStocks),
          initialPrices: JSON.stringify(initialPrices),
          backtestStatus: 'pending',
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
    
    getPerformance: publicProcedure.query(async () => {
      const { getPredictionPerformanceStats } = await import("./db");
      return await getPredictionPerformanceStats();
    }),
  }),

  // User-defined alerts
  userAlerts: router({
    list: protectedProcedure
      .query(async ({ ctx }) => {
        const { getUserDefinedAlerts } = await import("./db");
        return await getUserDefinedAlerts(ctx.user.id, "active");
      }),
    create: protectedProcedure
      .input(z.object({
        ticker: z.string(),
        type: z.enum(["price_above", "price_below", "volume_increase"]),
        value: z.string(),
      }))
      .mutation(async ({ ctx, input }) => {
        const { insertUserDefinedAlert } = await import("./db");
        await insertUserDefinedAlert({
          userId: ctx.user.id,
          ticker: input.ticker,
          type: input.type,
          value: input.value,
        });
        return { success: true };
      }),
    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        const { updateUserDefinedAlertStatus } = await import("./db");
        await updateUserDefinedAlertStatus(input.id, "inactive");
        return { success: true };
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

    scrapeVideos: publicProcedure
      .input(z.object({ channelNames: z.array(z.string()) }))
      .mutation(async ({ input }) => {
        console.log("[YouTube AI Scraper] RECEIVED INPUT:", JSON.stringify(input));
        const { scrapeYouTubeVideos } = await import("./services/aiBrowserAgent");
        const { analyzeYouTubeVideo } = await import("./services/youtubeTracker");
        const { insertYoutubeVideo } = await import("./db");

        console.log("[YouTube AI Scraper] Starting scrape for channels:", input.channelNames);
        try {
          const videos = await scrapeYouTubeVideos(input.channelNames);
          console.log("[YouTube AI Scraper] Found", videos.length, "videos");

          if (videos.length === 0) {
            throw new Error("No videos found. The AI scraper may have failed to extract data from YouTube.");
          }

          let count = 0;

          for (const video of videos) {
            try {
              // AI Browser Agent returns different field names, normalize them
              const normalizedVideo = {
                videoId: video.id || video.videoId || `yt-${Date.now()}-${count}`,
                title: video.title,
                description: video.description || "",
                publishedAt: video.date ? new Date(video.date) : (video.publishedAt ? new Date(video.publishedAt) : new Date()),
                thumbnailUrl: video.thumbnail || video.thumbnailUrl || "",
                videoUrl: video.url || video.videoUrl || "",
              };

              const analysis = await analyzeYouTubeVideo(normalizedVideo);
              await insertYoutubeVideo({
                influencerId: 1, // Default influencer for demo
                videoId: normalizedVideo.videoId,
                title: normalizedVideo.title,
                description: normalizedVideo.description,
                publishedAt: normalizedVideo.publishedAt,
                thumbnailUrl: normalizedVideo.thumbnailUrl,
                videoUrl: normalizedVideo.videoUrl,
                aiSummary: analysis.aiSummary,
                keyTakeaways: JSON.stringify(analysis.keyTakeaways),
                mentionedStocks: JSON.stringify(analysis.mentionedStocks),
                sentiment: analysis.sentiment,
                sectors: JSON.stringify(analysis.sectors),
                tradingSignals: JSON.stringify(analysis.tradingSignals),
              });
              count++;
              console.log(`[YouTube AI Scraper] Analyzed and saved: ${normalizedVideo.title}`);
            } catch (error) {
              console.error(`[YouTube AI Scraper] Failed to process video:`, error);
            }
          }

          return { success: true, count, videos };
        } catch (error: any) {
          console.error("[YouTube AI Scraper] Scraping failed:", error);
          throw new Error(`Failed to scrape YouTube videos: ${error.message}`);
        }
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

    getFinancials: publicProcedure
      .input(z.object({ symbol: z.string() }))
      .query(async ({ input }) => {
        const { getStockFinancials, insertStockFinancials } = await import("./db");
        const { getFinnhubBasicFinancials } = await import("./services/finnhubService");
        
        // 1. Check for cached data (e.g., less than 7 days old)
        const cachedFinancials = await getStockFinancials(input.symbol);
        if (cachedFinancials) {
          const sevenDaysAgo = new Date(new Date().getTime() - 7 * 24 * 60 * 60 * 1000);
          if (new Date(cachedFinancials.lastUpdated) > sevenDaysAgo) {
            return cachedFinancials;
          }
        }
        
        // 2. If no fresh cache, fetch from Finnhub
        const newFinancials = await getFinnhubBasicFinancials(input.symbol);
        if (!newFinancials) {
          return null;
        }
        
        // 3. Store in our database
        const dataToInsert = {
          ticker: newFinancials.symbol,
          marketCap: String(newFinancials.marketCap),
          peRatio: String(newFinancials.peRatio),
          eps: String(newFinancials.eps),
          dividendYield: String(newFinancials.dividendYield),
          beta: String(newFinancials.beta),
          high52Week: String(newFinancials.high52Week),
          low52Week: String(newFinancials.low52Week),
          lastUpdated: new Date(),
        };

        await insertStockFinancials(dataToInsert);
        
        return dataToInsert;
      }),
      
    getHistoricalData: publicProcedure
      .input(z.object({
        symbol: z.string(),
        resolution: z.string(), // e.g., 'D', 'W', 'M', '60'
        from: z.number(), // Unix timestamp
        to: z.number(), // Unix timestamp
      }))
      .query(async ({ input }) => {
        const { getStockHistoricalCandles, insertStockHistoricalCandles } = await import("./db");
        const { getFinnhubHistoricalCandles } = await import("./services/finnhubService");

        // 1. Check for cached data
        const cachedCandles = await getStockHistoricalCandles(input.symbol, input.resolution, input.from, input.to);
        if (cachedCandles) {
          // Determine freshness based on resolution. For daily, check if last updated today.
          // For intraday, check if last updated recently (e.g., last hour)
          const now = new Date();
          let isFresh = false;
          if (input.resolution === 'D' || input.resolution === 'W' || input.resolution === 'M') {
            isFresh = cachedCandles.lastUpdated.toDateString() === now.toDateString();
          } else { // Intraday resolutions
            const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
            isFresh = cachedCandles.lastUpdated > oneHourAgo;
          }
          
          if (isFresh) {
            return {
              open: JSON.parse(cachedCandles.open || "[]"),
              high: JSON.parse(cachedCandles.high || "[]"),
              low: JSON.parse(cachedCandles.low || "[]"),
              close: JSON.parse(cachedCandles.close || "[]"),
              volume: JSON.parse(cachedCandles.volume || "[]"),
              timestamp: JSON.parse(cachedCandles.timestamp || "[]"),
              symbol: cachedCandles.ticker,
              resolution: cachedCandles.resolution,
            };
          }
        }

        // 2. If no fresh cache, fetch from Finnhub
        const newCandles = await getFinnhubHistoricalCandles(input.symbol, input.resolution, input.from, input.to);
        if (!newCandles) {
          return null;
        }

        // 3. Store in our database
        await insertStockHistoricalCandles({
          ticker: newCandles.symbol,
          resolution: newCandles.resolution,
          open: JSON.stringify(newCandles.open),
          high: JSON.stringify(newCandles.high),
          low: JSON.stringify(newCandles.low),
          close: JSON.stringify(newCandles.close),
          volume: JSON.stringify(newCandles.volume),
          timestamp: JSON.stringify(newCandles.timestamp),
          from: input.from,
          to: input.to,
          lastUpdated: new Date(),
        });

        return newCandles;
      }),
      
    screener: publicProcedure
      .input(z.object({
        minMarketCap: z.number().optional(),
        maxPeRatio: z.number().optional(),
        sector: z.string().optional(),
      }).optional())
      .query(async ({ input }) => {
        const { getScreenerResults } = await import("./db");
        return await getScreenerResults(input || {});
      }),

    scrapePrice: publicProcedure
      .input(z.object({ ticker: z.string() }))
      .mutation(async ({ input }) => {
        const { getStockPrice } = await import("./services/aiBrowserAgent");

        console.log("[Stock Price AI Scraper] Scraping price for:", input.ticker);
        try {
          const priceData = await getStockPrice(input.ticker);
          console.log("[Stock Price AI Scraper] Result:", priceData);

          if (!priceData || priceData === null) {
            throw new Error("Failed to extract stock price data. The AI scraper may have failed to extract data from Yahoo Finance.");
          }

          return { success: true, data: priceData };
        } catch (error: any) {
          console.error("[Stock Price AI Scraper] Scraping failed:", error);
          throw new Error(`Failed to scrape stock price: ${error.message}`);
        }
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
    
    // Data retention management
    runRetentionCleanup: protectedProcedure
      .mutation(async () => {
        const { runDataRetentionCleanup } = await import("./services/dataRetentionService");
        const stats = await runDataRetentionCleanup();
        return stats;
      }),
    
    getDatabaseStats: protectedProcedure
      .query(async () => {
        const { getDatabaseStats } = await import("./services/dataRetentionService");
        const stats = await getDatabaseStats();
        return stats;
      }),
  }),

  // Technical Analysis
  ta: router({
    getSMA: publicProcedure
      .input(z.object({
        symbol: z.string(),
        interval: z.string(),
        period: z.number(),
        from: z.number(),
        to: z.number(),
      }))
      .query(async ({ input }) => {
        const { getSMA } = await import("./services/technicalAnalysisService");
        return await getSMA(input.symbol, input.interval, input.period, input.from, input.to);
      }),
    
    getRSI: publicProcedure
      .input(z.object({
        symbol: z.string(),
        interval: z.string(),
        period: z.number(),
        from: z.number(),
        to: z.number(),
      }))
      .query(async ({ input }) => {
        const { getRSI } = await import("./services/technicalAnalysisService");
        return await getRSI(input.symbol, input.interval, input.period, input.from, input.to);
      }),
  }),
});

export type AppRouter = typeof appRouter;

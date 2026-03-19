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
      // Analyze pending RSS articles with AI (uses real data from RSS sync)
      const result = await analyzePendingNews();
      return { success: true, count: result.analyzed, failed: result.failed };
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
      // TODO: Connect to real ARK Invest API (https://arkfunds.io/api) for live trade data
      throw new Error("ARK trade sync not yet connected to live data source. Set up ARK API integration to enable this feature.");
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
    generate: protectedProcedure.mutation(async () => {
      const { predictWithTechnicalValidation, extractHistoricalPatterns } = await import("./services/rallyPrediction");
      const { getRecentNews, getHistoricalRallies, insertRallyPrediction } = await import("./db");

      const recentNews = await getRecentNews(100);
      const historicalRallies = await getHistoricalRallies();
      const patterns = extractHistoricalPatterns(historicalRallies);

      const predictions = await predictWithTechnicalValidation(recentNews, patterns);
      
      // Save predictions to database
      for (const pred of predictions) {
        await insertRallyPrediction({
          sector: pred.sector,
          name: `Predicted ${pred.sector} Rally`,
          startDate: new Date(),
          description: pred.reasoning,
          predictionConfidence: pred.confidence,
          earlySignals: JSON.stringify(pred.earlySignals),
          keyStocks: JSON.stringify(pred.recommendedStocks),
        });
      }
      
      return { success: true, count: predictions.length, predictions };
    }),

    // Generate with multi-model consensus (requires OPENROUTER_API_KEY)
    generateConsensus: protectedProcedure.mutation(async () => {
      const { extractHistoricalPatterns, extractMentionedStocks } = await import("./services/rallyPrediction");
      const { getRecentNews, getHistoricalRallies, insertRallyPrediction } = await import("./db");
      const { validateWithConsensus, isMultiModelAvailable } = await import("./services/multiModelValidator");
      const { computeMultipleIndicators, formatIndicatorsForPrompt } = await import("./services/technicalAnalysis");
      const { getInsiderSummaryForPrompt, getMaterialEventsSummary } = await import("./services/secEdgar");
      const { scanRedditSentiment, formatSentimentForPrompt } = await import("./services/socialSentiment");

      const recentNews = await getRecentNews(100);
      const historicalRallies = await getHistoricalRallies();
      const patterns = extractHistoricalPatterns(historicalRallies);
      const mentionedStocks = extractMentionedStocks(recentNews);

      // Gather enrichment data
      const newsData = recentNews.map(n => ({
        title: n.title,
        summary: n.aiSummary || n.summary,
        sentiment: n.sentiment,
        sectors: n.sectors ? JSON.parse(n.sectors) : [],
        stocks: n.mentionedStocks ? JSON.parse(n.mentionedStocks) : [],
        rallyIndicator: n.rallyIndicator,
      }));

      // Build the same prompt that predictUpcomingRallies uses, for multi-model
      const systemPrompt = `You are an expert market analyst specializing in predicting MONEY-MAKING OPPORTUNITIES 2-3 weeks early. Analyze news patterns, technical data, insider trading, and social sentiment to predict both upside (calls) and downside (puts) opportunities. Be specific about entry timing and exit strategy. Historical patterns: ${JSON.stringify(patterns)}`;

      const userPrompt = `Analyze these ${recentNews.length} recent news articles:\n${JSON.stringify(newsData.slice(0, 50))}\n\nIdentify BOTH upside (calls) and downside (puts) opportunities.`;

      // Import the prediction schema from rallyPrediction
      const predictionSchema = {
        type: "json_schema" as const,
        json_schema: {
          name: "rally_predictions",
          strict: true,
          schema: {
            type: "object",
            properties: {
              predictions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    sector: { type: "string" },
                    opportunityType: { type: "string", enum: ["call", "put"] },
                    direction: { type: "string", enum: ["up", "down"] },
                    confidence: { type: "number" },
                    timeframe: { type: "string", enum: ["2-3 weeks", "1-2 months", "3-6 months"] },
                    earlySignals: { type: "array", items: { type: "string" } },
                    recommendedStocks: { type: "array", items: { type: "string" } },
                    reasoning: { type: "string" },
                    entryTiming: { type: "string" },
                    exitStrategy: { type: "string" },
                  },
                  required: ["sector", "opportunityType", "direction", "confidence", "timeframe", "earlySignals", "recommendedStocks", "reasoning", "entryTiming", "exitStrategy"],
                  additionalProperties: false,
                },
              },
            },
            required: ["predictions"],
            additionalProperties: false,
          },
        },
      };

      const consensus = await validateWithConsensus({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        response_format: predictionSchema,
      });

      // Save consensus predictions
      for (const pred of consensus.consensusPredictions.filter(p => p.confidence >= 55)) {
        await insertRallyPrediction({
          sector: pred.sector,
          name: `Predicted ${pred.sector} Rally`,
          startDate: new Date(),
          description: pred.reasoning,
          predictionConfidence: pred.confidence,
          earlySignals: JSON.stringify([]),
          keyStocks: JSON.stringify(pred.recommendedStocks),
        });
      }

      return {
        success: true,
        count: consensus.consensusPredictions.length,
        agreement: consensus.agreement,
        modelsUsed: consensus.modelsUsed,
        multiModelEnabled: isMultiModelAvailable(),
        predictions: consensus.consensusPredictions,
      };
    }),

    // Model configuration status
    modelConfig: publicProcedure.query(async () => {
      const { isMultiModelAvailable } = await import("./services/multiModelValidator");
      return {
        primaryModel: process.env.LLM_MODEL || "google/gemini-2.5-flash",
        secondaryModel: process.env.SECONDARY_LLM_MODEL || "openai/gpt-4o",
        multiModelEnabled: isMultiModelAvailable(),
        openrouterConfigured: !!process.env.OPENROUTER_API_KEY,
      };
    }),

    // Prediction accuracy scorecard
    scorecard: publicProcedure.query(async () => {
      const { getPredictionScorecard } = await import("./services/backtester");
      return await getPredictionScorecard();
    }),

    // Evaluate all pending predictions that are old enough
    evaluate: protectedProcedure.mutation(async () => {
      const { evaluateAllPendingPredictions } = await import("./services/backtester");
      return await evaluateAllPendingPredictions();
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
      // TODO: Connect to YouTube Data API v3 for live video fetching
      throw new Error("YouTube video sync not yet connected to live data source. Set YOUTUBE_API_KEY and configure channel tracking to enable this feature.");
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

    // Price history from snapshots (for charts and technical analysis)
    history: publicProcedure
      .input(z.object({
        symbol: z.string(),
        limit: z.number().min(1).max(2000).optional(),
      }))
      .query(async ({ input }) => {
        const { getPriceHistory } = await import("./db");
        return await getPriceHistory(input.symbol, input.limit ?? 288);
      }),

    // Real-time WebSocket status
    wsStatus: publicProcedure.query(async () => {
      const { priceWS } = await import("./services/priceWebSocket");
      return {
        connected: priceWS.connected,
        subscribedSymbols: priceWS.getSubscribedSymbols(),
        cachedPrices: Object.fromEntries(
          Array.from(priceWS.getAllPrices()).map(([k, v]) => [k, { price: v.price, timestamp: v.timestamp }])
        ),
      };
    }),

    // Subscribe to symbols via WebSocket
    subscribe: protectedProcedure
      .input(z.object({ symbols: z.array(z.string()) }))
      .mutation(async ({ input }) => {
        const { priceWS } = await import("./services/priceWebSocket");
        priceWS.subscribeMany(input.symbols);
        return { subscribed: priceWS.getSubscribedSymbols() };
      }),
  }),

  // SEC EDGAR data
  sec: router({
    insiderTransactions: publicProcedure
      .input(z.object({ ticker: z.string(), limit: z.number().optional() }))
      .query(async ({ input }) => {
        const { getInsiderTransactions } = await import("./services/secEdgar");
        return await getInsiderTransactions(input.ticker, input.limit ?? 20);
      }),

    recentFilings: publicProcedure
      .input(z.object({ ticker: z.string(), forms: z.string().optional() }))
      .query(async ({ input }) => {
        const { getRecentFilings } = await import("./services/secEdgar");
        return await getRecentFilings(input.ticker, input.forms ?? "10-K,10-Q,8-K");
      }),
  }),

  // Social sentiment
  sentiment: router({
    reddit: publicProcedure.query(async () => {
      const { scanRedditSentiment } = await import("./services/socialSentiment");
      return await scanRedditSentiment();
    }),

    tickerSentiment: publicProcedure
      .input(z.object({ tickers: z.array(z.string()).max(10) }))
      .query(async ({ input }) => {
        const { getTickerSentiment } = await import("./services/socialSentiment");
        const result = await getTickerSentiment(input.tickers);
        return Object.fromEntries(result);
      }),
  }),

  // Alpaca broker integration
  alpaca: router({
    status: publicProcedure.query(async () => {
      const { isAlpacaAvailable, getAccount } = await import("./services/alpacaService");
      const available = await isAlpacaAvailable();
      if (!available) return { connected: false, account: null };
      const account = await getAccount();
      return { connected: true, account };
    }),

    positions: protectedProcedure.query(async () => {
      const { getPositions } = await import("./services/alpacaService");
      return await getPositions();
    }),

    orders: protectedProcedure
      .input(z.object({ status: z.enum(["open", "closed", "all"]).optional() }).optional())
      .query(async ({ input }) => {
        const { getOrders } = await import("./services/alpacaService");
        return await getOrders(input?.status ?? "all");
      }),

    placeOrder: protectedProcedure
      .input(z.object({
        symbol: z.string(),
        qty: z.number().int().min(1),
        side: z.enum(["buy", "sell"]),
        type: z.enum(["market", "limit", "stop", "stop_limit"]),
        limitPrice: z.number().positive().optional(),
        stopPrice: z.number().positive().optional(),
        timeInForce: z.enum(["day", "gtc", "ioc"]).optional(),
      }))
      .mutation(async ({ input }) => {
        const { placeOrder } = await import("./services/alpacaService");
        const order = await placeOrder(input);
        if (!order) throw new Error("Failed to place order. Check Alpaca credentials.");
        return order;
      }),
  }),

  // Technical analysis
  technicals: router({
    indicators: publicProcedure
      .input(z.object({ symbol: z.string() }))
      .query(async ({ input }) => {
        const { computeIndicators } = await import("./services/technicalAnalysis");
        return await computeIndicators(input.symbol);
      }),

    chartData: publicProcedure
      .input(z.object({
        symbol: z.string(),
        interval: z.enum(["5m","15m","30m","1h","4h","1d"]).default("1d"),
      }))
      .query(async ({ input }) => {
        const YahooFinance = (await import("yahoo-finance2")).default;
        const yf = new (YahooFinance as any)();
        const { RSI, MACD, SMA, BollingerBands } = await import("technicalindicators");

        // Map interval → period1 lookback
        const lookbackDays: Record<string, number> = {
          "5m": 5, "15m": 7, "30m": 14, "1h": 30, "4h": 60, "1d": 365,
        };
        const days = lookbackDays[input.interval] ?? 365;
        const period1 = new Date(Date.now() - days * 86_400_000);

        // Yahoo Finance interval strings
        const yfInterval: Record<string, string> = {
          "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1h", "4h": "1h", "1d": "1d",
        };

        let bars: any[] = [];
        try {
          const result = await yf.chart(input.symbol, {
            period1,
            period2: new Date(),
            interval: yfInterval[input.interval] ?? "1d",
          });
          bars = (result?.quotes ?? []).filter((q: any) => q.close != null);
        } catch {
          return { bars: [], indicators: {} };
        }

        if (bars.length < 2) return { bars: [], indicators: {} };

        const closes = bars.map((b: any) => b.close as number);
        const highs  = bars.map((b: any) => (b.high  ?? b.close) as number);
        const lows   = bars.map((b: any) => (b.low   ?? b.close) as number);

        // RSI
        const rsiVals = RSI.calculate({ values: closes, period: 14 });
        const rsiPad  = Array(closes.length - rsiVals.length).fill(null).concat(rsiVals);

        // MACD
        const macdRaw = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });
        const macdPad    = Array(closes.length - macdRaw.length).fill(null).concat(macdRaw.map((m: any) => m.MACD ?? null));
        const signalPad  = Array(closes.length - macdRaw.length).fill(null).concat(macdRaw.map((m: any) => m.signal ?? null));
        const histPad    = Array(closes.length - macdRaw.length).fill(null).concat(macdRaw.map((m: any) => m.histogram ?? null));

        // SMAs
        const sma20Vals  = SMA.calculate({ values: closes, period: 20 });
        const sma50Vals  = SMA.calculate({ values: closes, period: 50 });
        const sma200Vals = SMA.calculate({ values: closes, period: 200 });
        const sma20Pad   = Array(closes.length - sma20Vals.length).fill(null).concat(sma20Vals);
        const sma50Pad   = Array(closes.length - sma50Vals.length).fill(null).concat(sma50Vals);
        const sma200Pad  = Array(closes.length - sma200Vals.length).fill(null).concat(sma200Vals);

        // Bollinger Bands
        const bbRaw  = BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 });
        const bbPad  = Array(closes.length - bbRaw.length).fill(null).concat(bbRaw);

        const result = bars.map((b: any, i: number) => ({
          t:     new Date(b.date).getTime(),
          open:  b.open  ?? b.close,
          high:  b.high  ?? b.close,
          low:   b.low   ?? b.close,
          close: b.close,
          volume: b.volume ?? 0,
          rsi:   rsiPad[i] ?? null,
          macd:  macdPad[i] ?? null,
          macdSignal: signalPad[i] ?? null,
          macdHist:   histPad[i] ?? null,
          sma20:  sma20Pad[i] ?? null,
          sma50:  sma50Pad[i] ?? null,
          sma200: sma200Pad[i] ?? null,
          bbUpper:  bbPad[i]?.upper ?? null,
          bbMiddle: bbPad[i]?.middle ?? null,
          bbLower:  bbPad[i]?.lower ?? null,
        }));

        return { bars: result, symbol: input.symbol, interval: input.interval };
      }),

    multipleIndicators: publicProcedure
      .input(z.object({ symbols: z.array(z.string()).max(20) }))
      .query(async ({ input }) => {
        const { computeMultipleIndicators } = await import("./services/technicalAnalysis");
        const results = await computeMultipleIndicators(input.symbols);
        // Flatten nested objects to match dashboard field names
        const flat: Record<string, any> = {};
        for (const [symbol, ind] of results) {
          flat[symbol] = {
            price: ind.price,
            rsi: ind.rsi14,
            macd: ind.macd?.macd ?? null,
            macdSignal: ind.macd?.signal ?? null,
            macdHistogram: ind.macd?.histogram ?? null,
            sma20: ind.sma20,
            sma50: ind.sma50,
            sma200: ind.sma200,
            bollingerUpper: ind.bollingerBands?.upper ?? null,
            bollingerMiddle: ind.bollingerBands?.middle ?? null,
            bollingerLower: ind.bollingerBands?.lower ?? null,
            signals: ind.signals,
          };
        }
        return flat;
      }),
  }),

  // Portfolio management
  portfolio: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      const { getUserPortfolios } = await import("./db");
      return await getUserPortfolios(ctx.user.id);
    }),

    create: protectedProcedure
      .input(z.object({
        name: z.string().min(1).max(128),
        initialCash: z.number().min(1000).max(10_000_000).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const { createPortfolio } = await import("./db");
        await createPortfolio({
          userId: ctx.user.id,
          name: input.name,
          type: "paper",
          cashBalance: (input.initialCash ?? 100_000).toFixed(2),
        });
        return { success: true };
      }),

    summary: protectedProcedure
      .input(z.object({ portfolioId: z.number() }))
      .query(async ({ ctx, input }) => {
        const { getPortfolioSummary } = await import("./services/paperTrading");
        return await getPortfolioSummary(input.portfolioId, ctx.user.id);
      }),

    tradeHistory: protectedProcedure
      .input(z.object({ portfolioId: z.number(), limit: z.number().optional() }))
      .query(async ({ input }) => {
        const { getPortfolioTradeHistory } = await import("./db");
        return await getPortfolioTradeHistory(input.portfolioId, input.limit ?? 100);
      }),
  }),

  // Paper trading
  trade: router({
    // Pre-trade risk check — call before execute to show warnings to user
    riskCheck: protectedProcedure
      .input(z.object({
        portfolioId: z.number(),
        symbol: z.string().min(1).max(10),
        side: z.enum(["buy", "sell"]),
        quantity: z.number().int().min(1),
      }))
      .query(async ({ ctx, input }) => {
        const { checkTradeRisk } = await import("./services/riskManager");
        const { getUserPreferences } = await import("./db");
        const prefs = await getUserPreferences(ctx.user.id);
        const riskSettings = prefs ? {
          maxPositionPct: prefs.maxPositionPct,
          maxSectorPct: prefs.maxSectorPct,
          stopLossPct: prefs.stopLossPct,
          takeProfitPct: prefs.takeProfitPct,
          maxDrawdownPct: prefs.maxDrawdownPct,
          maxOpenPositions: prefs.maxOpenPositions,
        } : {};
        return await checkTradeRisk(
          input.portfolioId, ctx.user.id, input.symbol, input.side, input.quantity, riskSettings,
        );
      }),

    execute: protectedProcedure
      .input(z.object({
        portfolioId: z.number(),
        symbol: z.string().min(1).max(10),
        side: z.enum(["buy", "sell"]),
        quantity: z.number().int().min(1),
        orderType: z.enum(["market", "limit"]).optional(),
        limitPrice: z.number().positive().optional(),
        stopLoss: z.number().positive().optional(),
        takeProfit: z.number().positive().optional(),
        predictionId: z.number().optional(),
        notes: z.string().optional(),
        skipRiskCheck: z.boolean().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        // Run risk check unless explicitly skipped
        if (!input.skipRiskCheck && input.side === "buy") {
          const { checkTradeRisk } = await import("./services/riskManager");
          const { getUserPreferences } = await import("./db");
          const prefs = await getUserPreferences(ctx.user.id);
          const riskSettings = prefs ? {
            maxPositionPct: prefs.maxPositionPct,
            maxSectorPct: prefs.maxSectorPct,
            stopLossPct: prefs.stopLossPct,
            takeProfitPct: prefs.takeProfitPct,
            maxDrawdownPct: prefs.maxDrawdownPct,
            maxOpenPositions: prefs.maxOpenPositions,
          } : {};
          const risk = await checkTradeRisk(
            input.portfolioId, ctx.user.id, input.symbol, input.side, input.quantity, riskSettings,
          );
          if (!risk.allowed) {
            return {
              success: false,
              message: `Trade blocked by risk manager: ${risk.blocked.join("; ")}`,
            };
          }
        }

        const { executePaperTrade } = await import("./services/paperTrading");
        return await executePaperTrade({
          portfolioId: input.portfolioId,
          userId: ctx.user.id,
          symbol: input.symbol,
          side: input.side,
          quantity: input.quantity,
          orderType: input.orderType ?? "market",
          limitPrice: input.limitPrice,
          stopLoss: input.stopLoss,
          takeProfit: input.takeProfit,
          predictionId: input.predictionId,
          notes: input.notes,
        });
      }),

    // Check stop loss / take profit triggers across all positions
    checkTriggers: protectedProcedure
      .input(z.object({ portfolioId: z.number() }))
      .query(async ({ input }) => {
        const { checkStopLossTakeProfit } = await import("./services/riskManager");
        return await checkStopLossTakeProfit(input.portfolioId);
      }),
  }),

  // Risk settings
  risk: router({
    settings: protectedProcedure.query(async ({ ctx }) => {
      const { getUserPreferences } = await import("./db");
      const prefs = await getUserPreferences(ctx.user.id);
      if (!prefs) {
        const { DEFAULT_RISK_SETTINGS } = await import("./services/riskManager");
        return DEFAULT_RISK_SETTINGS;
      }
      return {
        maxPositionPct: prefs.maxPositionPct,
        maxSectorPct: prefs.maxSectorPct,
        stopLossPct: prefs.stopLossPct,
        takeProfitPct: prefs.takeProfitPct,
        maxDrawdownPct: prefs.maxDrawdownPct,
        maxOpenPositions: prefs.maxOpenPositions,
        initialEquity: 100_000,
      };
    }),

    updateSettings: protectedProcedure
      .input(z.object({
        maxPositionPct: z.number().min(1).max(100).optional(),
        maxSectorPct: z.number().min(1).max(100).optional(),
        stopLossPct: z.number().min(1).max(50).optional(),
        takeProfitPct: z.number().min(1).max(100).optional(),
        maxDrawdownPct: z.number().min(1).max(50).optional(),
        maxOpenPositions: z.number().min(1).max(50).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const { upsertUserPreferences, getUserPreferences } = await import("./db");
        const existing = await getUserPreferences(ctx.user.id);
        await upsertUserPreferences({
          userId: ctx.user.id,
          refreshSchedule: existing?.refreshSchedule ?? "4h",
          alertThreshold: existing?.alertThreshold ?? "medium_high",
          enableEmailAlerts: existing?.enableEmailAlerts ?? 1,
          watchedSectors: existing?.watchedSectors ?? null,
          maxPositionPct: input.maxPositionPct ?? existing?.maxPositionPct ?? 10,
          maxSectorPct: input.maxSectorPct ?? existing?.maxSectorPct ?? 25,
          stopLossPct: input.stopLossPct ?? existing?.stopLossPct ?? 5,
          takeProfitPct: input.takeProfitPct ?? existing?.takeProfitPct ?? 15,
          maxDrawdownPct: input.maxDrawdownPct ?? existing?.maxDrawdownPct ?? 15,
          maxOpenPositions: input.maxOpenPositions ?? existing?.maxOpenPositions ?? 10,
        });
        return { success: true };
      }),
  }),

  // Autonomous trading agent
  agent: router({
    status: publicProcedure.query(async () => {
      const { getAgentStatus } = await import("./services/tradingAgent");
      return getAgentStatus();
    }),

    pause: protectedProcedure.mutation(async () => {
      const { pauseAgent } = await import("./services/tradingAgent");
      await pauseAgent();
      return { success: true, paused: true };
    }),

    resume: protectedProcedure.mutation(async () => {
      const { resumeAgent } = await import("./services/tradingAgent");
      await resumeAgent();
      return { success: true, paused: false };
    }),

    cycleLogs: protectedProcedure
      .input(z.object({ limit: z.number().min(1).max(100).optional() }).optional())
      .query(async ({ input }) => {
        const { getAgentCycleLogs } = await import("./db");
        return await getAgentCycleLogs(input?.limit ?? 20);
      }),

    runNow: protectedProcedure.mutation(async () => {
      const { runAgentCycle } = await import("./services/tradingAgent");
      const userId = parseInt(process.env.AGENT_USER_ID || "1");

      // Resolve portfolio: use AGENT_PORTFOLIO_ID if set, otherwise first portfolio for the agent user
      const { getUserPortfolios, createPortfolio } = await import("./db");
      let portfolios = await getUserPortfolios(userId);
      if (portfolios.length === 0) {
        await createPortfolio({ userId, name: "Agent Portfolio", type: "paper", cashBalance: "100000.00" });
        portfolios = await getUserPortfolios(userId);
      }
      const envPortfolioId = process.env.AGENT_PORTFOLIO_ID ? parseInt(process.env.AGENT_PORTFOLIO_ID) : null;
      const portfolioId = envPortfolioId ?? portfolios[0]!.id;

      return await runAgentCycle(portfolioId, userId, true); // force=true bypasses market hours check
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

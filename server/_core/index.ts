import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  // OAuth callback under /api/oauth/callback
  registerOAuthRoutes(app);

  // Dev-only: auto-login route to bypass external OAuth server
  if (process.env.NODE_ENV === "development") {
    const { sdk } = await import("./sdk");
    const { COOKIE_NAME, ONE_YEAR_MS } = await import("@shared/const");
    const { getSessionCookieOptions } = await import("./cookies");
    const devDb = await import("../db");

    app.get("/api/dev-login", async (req, res) => {
      const openId = process.env.OWNER_OPEN_ID || "dev-user";
      await devDb.upsertUser({
        openId,
        name: "Dev User",
        email: null,
        loginMethod: "dev",
        lastSignedIn: new Date(),
      });
      const sessionToken = await sdk.createSessionToken(openId, {
        name: "Dev User",
        expiresInMs: ONE_YEAR_MS,
      });
      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });
      res.redirect(302, "/");
    });
    console.log("[Dev] Dev login available at /api/dev-login");
  }
  // SSE endpoint for real-time price streaming
  app.get("/api/prices/stream", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // Send initial cached prices
    const { priceWS } = require("../services/priceWebSocket") as typeof import("../services/priceWebSocket");
    const cached = priceWS.getAllPrices();
    if (cached.size > 0) {
      const snapshot = Object.fromEntries(cached);
      res.write(`data: ${JSON.stringify({ type: "snapshot", prices: snapshot })}\n\n`);
    }

    // Stream live updates
    const onPrice = (update: import("../services/priceWebSocket").PriceUpdate) => {
      res.write(`data: ${JSON.stringify({ type: "update", ...update })}\n\n`);
    };

    priceWS.on("price", onPrice);

    // Keep-alive ping every 30 seconds
    const keepAlive = setInterval(() => {
      res.write(": keepalive\n\n");
    }, 30_000);

    req.on("close", () => {
      priceWS.off("price", onPrice);
      clearInterval(keepAlive);
    });
  });

  // REST endpoint to manage price subscriptions
  app.post("/api/prices/subscribe", express.json(), (req, res) => {
    const { symbols } = req.body as { symbols?: string[] };
    if (!Array.isArray(symbols) || symbols.length === 0) {
      res.status(400).json({ error: "symbols array required" });
      return;
    }
    const { priceWS } = require("../services/priceWebSocket") as typeof import("../services/priceWebSocket");
    priceWS.subscribeMany(symbols);
    res.json({ subscribed: priceWS.getSubscribedSymbols() });
  });

  // REST endpoint to get cached prices
  app.get("/api/prices/current", (_req, res) => {
    const { priceWS } = require("../services/priceWebSocket") as typeof import("../services/priceWebSocket");
    const prices = Object.fromEntries(priceWS.getAllPrices());
    res.json({ prices, connected: priceWS.connected });
  });

  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });

  // Start real-time price WebSocket feed
  startPriceWebSocket();

  // Start scheduled jobs
  startScheduledJobs();
}

async function startPriceWebSocket() {
  try {
    const { priceWS } = await import("../services/priceWebSocket");
    priceWS.connect();

    // Auto-subscribe to watchlist symbols after a short delay
    setTimeout(async () => {
      try {
        const { getDb } = await import("../db");
        const { watchlistStocks } = await import("../../drizzle/schema");
        const db = await getDb();
        if (db) {
          const stocks = await db.selectDistinct({ ticker: watchlistStocks.ticker }).from(watchlistStocks);
          const symbols = stocks.map(s => s.ticker);
          if (symbols.length > 0) {
            priceWS.subscribeMany(symbols);
            console.log(`[PriceWS] Auto-subscribed to ${symbols.length} watchlist symbols`);
          }
        }
      } catch (error) {
        console.error("[PriceWS] Error auto-subscribing:", error);
      }
    }, 5_000);
  } catch (error) {
    console.error("[PriceWS] Failed to start:", error);
  }
}

function startScheduledJobs() {
  const RSS_SYNC_INTERVAL = 15 * 60 * 1000; // 15 minutes
  const AI_ANALYSIS_INTERVAL = 30 * 60 * 1000; // 30 minutes
  const PRICE_SNAPSHOT_INTERVAL = 5 * 60 * 1000; // 5 minutes

  console.log("[Scheduler] Starting scheduled jobs...");
  console.log(`[Scheduler] RSS sync: every ${RSS_SYNC_INTERVAL / 60000} minutes`);
  console.log(`[Scheduler] AI analysis: every ${AI_ANALYSIS_INTERVAL / 60000} minutes (market hours only)`);
  console.log(`[Scheduler] Price snapshots: every ${PRICE_SNAPSHOT_INTERVAL / 60000} minutes (market hours only)`);

  // RSS feed sync - runs every 15 minutes
  setInterval(async () => {
    try {
      const { scheduledNewsSync } = await import("../services/rssNewsSync");
      await scheduledNewsSync(false);
    } catch (error) {
      console.error("[Scheduler] RSS sync error:", error);
    }
  }, RSS_SYNC_INTERVAL);

  // AI analysis - runs every 30 minutes (market hours check is inside scheduledNewsSync)
  setInterval(async () => {
    try {
      const { scheduledNewsSync } = await import("../services/rssNewsSync");
      await scheduledNewsSync(true);
    } catch (error) {
      console.error("[Scheduler] AI analysis error:", error);
    }
  }, AI_ANALYSIS_INTERVAL);

  // Price snapshots - capture every 5 minutes during market hours
  setInterval(async () => {
    try {
      const { isMarketHours } = await import("../services/rssNewsSync");
      if (!isMarketHours()) return;

      const { priceWS } = await import("../services/priceWebSocket");
      const { insertPriceSnapshots } = await import("../db");

      const prices = priceWS.getAllPrices();
      if (prices.size === 0) return;

      const snapshots = Array.from(prices.values()).map(p => ({
        symbol: p.symbol,
        price: p.price.toString(),
        volume: p.volume,
        capturedAt: new Date(p.timestamp),
      }));

      await insertPriceSnapshots(snapshots);
      console.log(`[Scheduler] Captured ${snapshots.length} price snapshots`);
    } catch (error) {
      console.error("[Scheduler] Price snapshot error:", error);
    }
  }, PRICE_SNAPSHOT_INTERVAL);

  // Run initial RSS sync 10 seconds after startup
  setTimeout(async () => {
    try {
      console.log("[Scheduler] Running initial RSS sync...");
      const { syncRSSNews } = await import("../services/rssNewsSync");
      await syncRSSNews();
    } catch (error) {
      console.error("[Scheduler] Initial sync error:", error);
    }
  }, 10_000);
}

startServer().catch(console.error);

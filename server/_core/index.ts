import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { syncRSSNews, analyzePendingNews } from "../services/rssNewsSync";
import { runBacktest } from "../services/backtestingService";
import { runAlertChecks } from "../services/alertingService";
import { runDataRetentionCleanup } from "../services/dataRetentionService";
import cron from "node-cron";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    
    const timeout = setTimeout(() => {
      server.close();
      resolve(false);
    }, 1000);
    
    server.once("error", (err: any) => {
      clearTimeout(timeout);
      if (err.code === "EADDRINUSE" || err.code === "EACCES") {
        resolve(false);
      } else {
        // Other errors might be temporary, try again
        resolve(false);
      }
    });
    
    server.listen(port, "0.0.0.0", () => {
      clearTimeout(timeout);
      server.close(() => resolve(true));
    });
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  // First, try the preferred port directly
  if (await isPortAvailable(startPort)) {
    return startPort;
  }
  
  // If preferred port is busy, try nearby ports
  for (let port = startPort + 1; port < startPort + 20; port++) {
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
  
  // If PORT is explicitly set, use it directly (skip port checking which can fail)
  // Otherwise, try to find an available port
  let port = preferredPort;
  if (!process.env.PORT) {
    // No PORT env var, find any available port
    try {
      port = await findAvailablePort(preferredPort);
    } catch (error) {
      console.warn(`Port finding failed, using default port ${preferredPort}`);
      port = preferredPort;
    }
  }

  // Bind to all interfaces in production, localhost if BIND_LOCALHOST is set
  const host = process.env.NODE_ENV === "production" && !process.env.BIND_LOCALHOST ? "0.0.0.0" : "127.0.0.1";
  server.listen(port, host, () => {
    console.log(`Server running on http://${host === "0.0.0.0" ? "localhost" : host}:${port}/`);

    // --- Automated Job Scheduler ---
    console.log("[Scheduler] Initializing background jobs...");

    // 1. Sync RSS feeds every 15 minutes
    cron.schedule("*/15 * * * *", async () => {
      console.log("[Scheduler] Running RSS news sync job...");
      try {
        const result = await syncRSSNews();
        console.log(`[Scheduler] RSS news sync completed. Found: ${result.found}, Inserted: ${result.inserted}, Skipped: ${result.skipped}`);
      } catch (error) {
        console.error("[Scheduler] Error during RSS news sync:", error);
      }
    });

    // 2. Analyze pending news every 30 minutes during market hours (8am - 4pm EST, Mon-Fri)
    // This schedule '*/30 12-20 * * 1-5' corresponds to 8am-4pm EST assuming server is in UTC.
    cron.schedule("*/30 12-20 * * 1-5", async () => {
      console.log("[Scheduler] Running pending news analysis job...");
      try {
        const result = await analyzePendingNews();
        console.log(`[Scheduler] News analysis completed. Analyzed: ${result.analyzedCount}, Errors: ${result.errorCount}`);
      } catch (error) {
        console.error("[Scheduler] Error during news analysis:", error);
      }
    }, {
      timezone: "UTC"
    });
    
    // 3. Run backtesting job daily at 5pm EST
    // This schedule '0 21 * * *' corresponds to 5pm EST (21:00 UTC)
    cron.schedule("0 21 * * *", async () => {
      console.log("[Scheduler] Running daily prediction backtest job...");
      try {
        await runBacktest();
      } catch (error) {
        console.error("[Scheduler] Error during prediction backtest:", error);
      }
    }, {
      timezone: "UTC"
    });

    console.log("[Scheduler] Background jobs initialized.");
    console.log("- RSS Sync scheduled for every 15 minutes.");
    console.log("- News Analysis scheduled for every 30 minutes (8am-4pm EST, Mon-Fri).");
    console.log("- Prediction Backtesting scheduled for daily at 5pm EST.");

    // 4. Run user-defined alert checks every 5 minutes during market hours
    cron.schedule("*/5 12-20 * * 1-5", async () => {
      console.log("[Scheduler] Running user-defined alert checks...");
      try {
        await runAlertChecks();
      } catch (error) {
        console.error("[Scheduler] Error during user-defined alert checks:", error);
      }
    }, {
      timezone: "UTC"
    });
    
    // 5. Run data retention cleanup daily at 2am EST (6:00 UTC) to keep database lean
    cron.schedule("0 6 * * *", async () => {
      console.log("[Scheduler] Running data retention cleanup...");
      try {
        const stats = await runDataRetentionCleanup();
        console.log(`[Scheduler] Retention cleanup completed. Deleted ${
          stats.newsArticles.deleted + stats.arkTrades.deleted + 
          stats.alerts.deleted + stats.sectorMomentum.deleted + 
          stats.stockCandles.deleted + stats.rallyEvents.deleted
        } total records.`);
      } catch (error) {
        console.error("[Scheduler] Error during data retention cleanup:", error);
      }
    }, {
      timezone: "UTC"
    });
    
    console.log("- User Alert Checks scheduled for every 5 minutes (8am-4pm EST, Mon-Fri).");
    console.log("- Data Retention Cleanup scheduled for daily at 2am EST.");
  });
}

startServer().catch(console.error);

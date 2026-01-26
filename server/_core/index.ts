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
import cron from "node-cron";

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
    
    console.log("- User Alert Checks scheduled for every 5 minutes (8am-4pm EST, Mon-Fri).");
  });
}

startServer().catch(console.error);

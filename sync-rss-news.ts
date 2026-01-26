#!/usr/bin/env node
/**
 * RSS News Sync Script
 * Can be run directly or via cron job
 * Usage: npx tsx sync-rss-news.ts
 */

import { syncRSSNews } from "./server/services/rssNewsSync";
import { config } from "dotenv";
import { resolve } from "path";

// Load environment variables
// Default to production if NODE_ENV is not set (for cron jobs)
const envFile = process.env.NODE_ENV === "development" 
  ? ".env" 
  : ".env.production";

const envPath = resolve(process.cwd(), envFile);
config({ path: envPath });
console.log(`[Cron] Loading environment from: ${envFile}`);

async function main() {
  console.log(`[Cron] Starting RSS news sync at ${new Date().toISOString()}`);
  
  try {
    const result = await syncRSSNews();
    console.log(`[Cron] RSS sync completed: ${result.added} added, ${result.skipped} skipped`);
    process.exit(0);
  } catch (error) {
    console.error("[Cron] RSS sync failed:", error);
    process.exit(1);
  }
}

main();


import cron from "node-cron";
import { syncRSSNews, analyzePendingNews } from "./server/services/rssNewsSync";

// Schedule the RSS news sync to run every 15 minutes
cron.schedule("*/15 * * * *", async () => {
  console.log("Running scheduled RSS news sync...");
  try {
    await syncRSSNews();
    console.log("RSS news sync completed.");
  } catch (error) {
    console.error("Error running scheduled RSS news sync:", error);
  }
});

// Schedule the news analysis to run every 15 minutes
cron.schedule("*/15 * * * *", async () => {
  console.log("Running scheduled news analysis...");
  try {
    await analyzePendingNews();
    console.log("News analysis completed.");
  } catch (error) {
    console.error("Error running scheduled news analysis:", error);
  }
});

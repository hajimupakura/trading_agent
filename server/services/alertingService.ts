import { getDb } from "../db";
import { getMultipleStockQuotes } from "./stockPriceService";
import { userDefinedAlerts, alerts, InsertAlert } from "../../drizzle/schema";
import { eq } from "drizzle-orm";

export async function runAlertChecks() {
  const db = await getDb();
  if (!db) {
    console.error("[Alerts] Database not available.");
    return { triggered: 0, errors: 1 };
  }

  const activeUserAlerts = await db.select().from(userDefinedAlerts)
    .where(eq(userDefinedAlerts.status, "active"));

  if (activeUserAlerts.length === 0) {
    console.log("[Alerts] No active user-defined alerts to check.");
    return { triggered: 0, errors: 0 };
  }

  console.log(`[Alerts] Checking ${activeUserAlerts.length} active user-defined alerts.`);
  let triggeredCount = 0;
  let errorCount = 0;

  // Group alerts by ticker to fetch quotes efficiently
  const tickersToCheck = [...new Set(activeUserAlerts.map(a => a.ticker))];
  const currentQuotes = await getMultipleStockQuotes(tickersToCheck);

  for (const alert of activeUserAlerts) {
    try {
      const quote = currentQuotes.get(alert.ticker);
      if (!quote) continue;

      const targetValue = parseFloat(alert.value);
      let isTriggered = false;
      let message = "";

      switch (alert.type) {
        case "price_above":
          if (quote.price >= targetValue) {
            isTriggered = true;
            message = `${alert.ticker} price has risen above your target of $${targetValue}. Current price: $${quote.price.toFixed(2)}.`;
          }
          break;
        case "price_below":
          if (quote.price <= targetValue) {
            isTriggered = true;
            message = `${alert.ticker} price has fallen below your target of $${targetValue}. Current price: $${quote.price.toFixed(2)}.`;
          }
          break;
        // Note: Volume increase check would require historical volume data to compare against.
        // This is a simplified check against the day's volume, which might not be what users expect.
        // A more robust implementation would compare to average volume over a period.
        case "volume_increase":
            // This is a placeholder as we don't have volume data in the quote object.
            // This would need to be implemented properly with historical data.
          break;
      }

      if (isTriggered) {
        // Create a notification for the user
        await db.insert(alerts).values({
          userId: alert.userId,
          type: "watchlist_update", // Using existing type for simplicity
          severity: "medium",
          title: `Alert Triggered: ${alert.ticker}`,
          message: message,
          isRead: false,
        });

        // Deactivate the user-defined alert
        await db.update(userDefinedAlerts)
          .set({ status: "triggered", triggeredAt: new Date() })
          .where(eq(userDefinedAlerts.id, alert.id));
        
        triggeredCount++;
        console.log(`[Alerts] Triggered alert #${alert.id} for user #${alert.userId}: ${message}`);
      }
    } catch (error) {
      console.error(`[Alerts] Error checking alert #${alert.id}:`, error);
      errorCount++;
    }
  }

  console.log(`[Alerts] Finished checks. Triggered: ${triggeredCount}, Errors: ${errorCount}`);
  return { triggered: triggeredCount, errors: errorCount };
}

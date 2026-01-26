import { getDb } from "../db";
import { getMultipleStockQuotes } from "./stockPriceService";
import { rallyEvents, InsertRallyEvent } from "../../drizzle/schema";
import { eq } from "drizzle-orm";

// Helper to determine evaluation date based on timeframe
function getEvaluationDate(prediction: InsertRallyEvent): Date | null {
  const timeframe = (JSON.parse(prediction.catalysts || "{}")).timeframe;
  if (!timeframe) return null;

  const startDate = new Date(prediction.startDate);
  const match = timeframe.match(/(\d+)\s*(day|week|month)s?/i);
  if (!match) return null;

  const value = parseInt(match[1]);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case "day":
      startDate.setDate(startDate.getDate() + value);
      break;
    case "week":
      startDate.setDate(startDate.getDate() + value * 7);
      break;
    case "month":
      startDate.setMonth(startDate.getMonth() + value);
      break;
    default:
      return null;
  }
  return startDate;
}

export async function runBacktest() {
  const db = await getDb();
  if (!db) {
    console.error("[Backtest] Database not available.");
    return { evaluated: 0, errors: 1 };
  }

  const pendingPredictions = await db.select().from(rallyEvents)
    .where(eq(rallyEvents.backtestStatus, "pending"));

  if (pendingPredictions.length === 0) {
    console.log("[Backtest] No pending predictions to evaluate.");
    return { evaluated: 0, errors: 0 };
  }

  console.log(`[Backtest] Found ${pendingPredictions.length} pending predictions to evaluate.`);
  let evaluatedCount = 0;
  let errorCount = 0;

  for (const prediction of pendingPredictions) {
    try {
      const evaluationDate = getEvaluationDate(prediction);
      if (!evaluationDate || new Date() < evaluationDate) {
        continue; // Not yet time to evaluate
      }

      const keyStocks = JSON.parse(prediction.keyStocks || "[]");
      if (keyStocks.length === 0) {
        await db.update(rallyEvents)
          .set({ backtestStatus: "completed", predictionOutcome: "neutral" })
          .where(eq(rallyEvents.id, prediction.id));
        evaluatedCount++;
        continue;
      }
      
      const initialPrices = JSON.parse(prediction.initialPrices || "{}");
      const currentQuotes = await getMultipleStockQuotes(keyStocks);
      
      let totalReturn = 0;
      let stocksEvaluated = 0;
      
      for (const [symbol, quote] of currentQuotes.entries()) {
        const initialPrice = initialPrices[symbol];
        if (initialPrice) {
          totalReturn += (quote.currentPrice - initialPrice) / initialPrice;
          stocksEvaluated++;
        }
      }

      if (stocksEvaluated === 0) {
        await db.update(rallyEvents)
          .set({ backtestStatus: "completed", predictionOutcome: "neutral" })
          .where(eq(rallyEvents.id, prediction.id));
        evaluatedCount++;
        continue;
      }

      const averageReturn = totalReturn / stocksEvaluated;
      const catalysts = JSON.parse(prediction.catalysts || "{}");
      const isUpPrediction = catalysts.direction === 'up';

      let outcome: "success" | "failure" | "neutral" = "neutral";
      if (isUpPrediction && averageReturn > 0.02) { // 2% gain for success
        outcome = "success";
      } else if (!isUpPrediction && averageReturn < -0.02) { // 2% loss for success on a 'down' prediction
        outcome = "success";
      } else if (Math.abs(averageReturn) <= 0.02) {
        outcome = "neutral";
      } else {
        outcome = "failure";
      }
      
      await db.update(rallyEvents)
        .set({ backtestStatus: "completed", predictionOutcome: outcome, performance: `${(averageReturn * 100).toFixed(2)}%` })
        .where(eq(rallyEvents.id, prediction.id));
        
      evaluatedCount++;
      console.log(`[Backtest] Evaluated prediction #${prediction.id} for ${prediction.sector}. Outcome: ${outcome}, Avg Return: ${(averageReturn * 100).toFixed(2)}%`);

    } catch (error) {
      console.error(`[Backtest] Error evaluating prediction #${prediction.id}:`, error);
      await db.update(rallyEvents)
        .set({ backtestStatus: "completed", predictionOutcome: "neutral" }) // Mark as completed to avoid retrying
        .where(eq(rallyEvents.id, prediction.id));
      errorCount++;
    }
  }

  console.log(`[Backtest] Finished evaluation. Evaluated: ${evaluatedCount}, Errors: ${errorCount}`);
  return { evaluated: evaluatedCount, errors: errorCount };
}

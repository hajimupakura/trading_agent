import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { rallyEvents, predictionOutcomes } from "../../drizzle/schema";
import { getHistoricalPrices } from "./stockPriceService";
import type { InsertPredictionOutcome } from "../../drizzle/schema";

/**
 * Backtester Service
 * Evaluates past predictions against actual price movements.
 * Tracks hit rate, average return, and generates a prediction scorecard.
 */

export interface PredictionScorecard {
  totalPredictions: number;
  evaluated: number;
  pending: number; // Not yet expired
  correct: number;
  incorrect: number;
  hitRate: number; // % correct out of evaluated
  avgReturnCorrect: number; // Average return when prediction was right
  avgReturnIncorrect: number; // Average return when prediction was wrong
  byConfidenceTier: {
    tier: string; // "high" (75-100), "medium" (55-74)
    total: number;
    correct: number;
    hitRate: number;
  }[];
  byDirection: {
    direction: string;
    total: number;
    correct: number;
    hitRate: number;
  }[];
}

/**
 * Evaluate a single prediction against actual price data.
 * Checks if the predicted direction matched reality for the recommended stocks.
 */
export async function evaluatePrediction(predictionId: number): Promise<{
  wasCorrect: boolean;
  avgReturn: number;
  stockReturns: Array<{ symbol: string; returnPct: number }>;
} | null> {
  const db = await getDb();
  if (!db) return null;

  const result = await db.select().from(rallyEvents)
    .where(eq(rallyEvents.id, predictionId))
    .limit(1);

  const prediction = result[0];
  if (!prediction) return null;

  // Parse key stocks
  const keyStocks: string[] = prediction.keyStocks
    ? JSON.parse(prediction.keyStocks)
    : [];

  if (keyStocks.length === 0) return null;

  // Determine evaluation window based on prediction age
  const createdAt = prediction.createdAt;
  const now = new Date();
  const daysSince = (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24);

  // Need at least 14 days for meaningful evaluation
  if (daysSince < 14) return null;

  // Get price changes for each stock since prediction
  const stockReturns: Array<{ symbol: string; returnPct: number }> = [];

  for (const symbol of keyStocks.slice(0, 5)) { // Cap at 5 stocks
    try {
      const history = await getHistoricalPrices(symbol, "3mo");
      if (!history || history.length < 2) continue;

      // Find the price closest to prediction date
      const predDate = createdAt.getTime();
      let entryPrice: number | null = null;
      let currentPrice: number | null = null;

      for (const bar of history) {
        const barDate = new Date(bar.date).getTime();
        if (barDate >= predDate && !entryPrice) {
          entryPrice = bar.close;
        }
      }

      // Latest price is last in the array
      if (history.length > 0) {
        currentPrice = history[history.length - 1]!.close;
      }

      if (entryPrice && currentPrice) {
        const returnPct = ((currentPrice - entryPrice) / entryPrice) * 100;
        stockReturns.push({ symbol, returnPct });
      }
    } catch {
      // Skip stocks that fail to fetch
    }
  }

  if (stockReturns.length === 0) return null;

  const avgReturn = stockReturns.reduce((sum, s) => sum + s.returnPct, 0) / stockReturns.length;

  // Determine if prediction was correct
  // For "up" predictions: correct if avg return > 0
  // For "down" predictions: correct if avg return < 0
  const predictedUp = prediction.status === "predicted"; // All predictions stored as "predicted"
  // Infer direction from earlySignals or default to "up"
  const earlySignals = prediction.earlySignals ? JSON.parse(prediction.earlySignals) : [];
  const signalText = earlySignals.join(" ").toLowerCase();
  const predictedDown = signalText.includes("put") || signalText.includes("downside") || signalText.includes("bearish");

  const wasCorrect = predictedDown ? avgReturn < -2 : avgReturn > 2; // 2% threshold

  return { wasCorrect, avgReturn, stockReturns };
}

/**
 * Evaluate all pending predictions that are old enough.
 */
export async function evaluateAllPendingPredictions(): Promise<{ evaluated: number; skipped: number }> {
  const db = await getDb();
  if (!db) return { evaluated: 0, skipped: 0 };

  // Get all predicted rally events that haven't been evaluated
  const predictions = await db.select().from(rallyEvents)
    .where(eq(rallyEvents.status, "predicted"));

  let evaluated = 0;
  let skipped = 0;

  for (const pred of predictions) {
    // Check if already evaluated
    const existing = await db.select().from(predictionOutcomes)
      .where(eq(predictionOutcomes.predictionId, pred.id))
      .limit(1);

    if (existing.length > 0) {
      skipped++;
      continue;
    }

    const result = await evaluatePrediction(pred.id);
    if (!result) {
      skipped++; // Not enough time or data
      continue;
    }

    const keyStocks = pred.keyStocks ? JSON.parse(pred.keyStocks) : [];
    const earlySignals = pred.earlySignals ? JSON.parse(pred.earlySignals) : [];
    const signalText = earlySignals.join(" ").toLowerCase();
    const direction = signalText.includes("put") || signalText.includes("bearish") ? "down" : "up";

    const outcome: InsertPredictionOutcome = {
      predictionId: pred.id,
      predictedDirection: direction as "up" | "down",
      predictedConfidence: pred.predictionConfidence ?? 50,
      predictedSector: pred.sector,
      predictedStocks: JSON.stringify(keyStocks),
      actualReturn: result.avgReturn.toFixed(2),
      wasCorrect: result.wasCorrect ? 1 : 0,
      evaluatedAt: new Date(),
    };

    await db.insert(predictionOutcomes).values(outcome);
    evaluated++;
  }

  return { evaluated, skipped };
}

/**
 * Generate the prediction scorecard from evaluated outcomes.
 */
export async function getPredictionScorecard(): Promise<PredictionScorecard> {
  const db = await getDb();
  const empty: PredictionScorecard = {
    totalPredictions: 0,
    evaluated: 0,
    pending: 0,
    correct: 0,
    incorrect: 0,
    hitRate: 0,
    avgReturnCorrect: 0,
    avgReturnIncorrect: 0,
    byConfidenceTier: [],
    byDirection: [],
  };

  if (!db) return empty;

  // Count total predictions
  const allPredictions = await db.select().from(rallyEvents)
    .where(eq(rallyEvents.status, "predicted"));
  const totalPredictions = allPredictions.length;

  // Get all outcomes
  const outcomes = await db.select().from(predictionOutcomes);
  const evaluated = outcomes.length;
  const pending = totalPredictions - evaluated;

  if (evaluated === 0) {
    return { ...empty, totalPredictions, pending };
  }

  const correct = outcomes.filter(o => o.wasCorrect === 1).length;
  const incorrect = evaluated - correct;
  const hitRate = (correct / evaluated) * 100;

  // Average returns
  const correctOutcomes = outcomes.filter(o => o.wasCorrect === 1 && o.actualReturn);
  const incorrectOutcomes = outcomes.filter(o => o.wasCorrect === 0 && o.actualReturn);

  const avgReturnCorrect = correctOutcomes.length > 0
    ? correctOutcomes.reduce((sum, o) => sum + parseFloat(o.actualReturn!), 0) / correctOutcomes.length
    : 0;
  const avgReturnIncorrect = incorrectOutcomes.length > 0
    ? incorrectOutcomes.reduce((sum, o) => sum + parseFloat(o.actualReturn!), 0) / incorrectOutcomes.length
    : 0;

  // By confidence tier
  const highConf = outcomes.filter(o => o.predictedConfidence >= 75);
  const medConf = outcomes.filter(o => o.predictedConfidence >= 55 && o.predictedConfidence < 75);

  const byConfidenceTier = [
    {
      tier: "high (75-100)",
      total: highConf.length,
      correct: highConf.filter(o => o.wasCorrect === 1).length,
      hitRate: highConf.length > 0
        ? (highConf.filter(o => o.wasCorrect === 1).length / highConf.length) * 100
        : 0,
    },
    {
      tier: "medium (55-74)",
      total: medConf.length,
      correct: medConf.filter(o => o.wasCorrect === 1).length,
      hitRate: medConf.length > 0
        ? (medConf.filter(o => o.wasCorrect === 1).length / medConf.length) * 100
        : 0,
    },
  ];

  // By direction
  const upPreds = outcomes.filter(o => o.predictedDirection === "up");
  const downPreds = outcomes.filter(o => o.predictedDirection === "down");

  const byDirection = [
    {
      direction: "up (calls)",
      total: upPreds.length,
      correct: upPreds.filter(o => o.wasCorrect === 1).length,
      hitRate: upPreds.length > 0
        ? (upPreds.filter(o => o.wasCorrect === 1).length / upPreds.length) * 100
        : 0,
    },
    {
      direction: "down (puts)",
      total: downPreds.length,
      correct: downPreds.filter(o => o.wasCorrect === 1).length,
      hitRate: downPreds.length > 0
        ? (downPreds.filter(o => o.wasCorrect === 1).length / downPreds.length) * 100
        : 0,
    },
  ];

  return {
    totalPredictions,
    evaluated,
    pending,
    correct,
    incorrect,
    hitRate,
    avgReturnCorrect,
    avgReturnIncorrect,
    byConfidenceTier,
    byDirection,
  };
}

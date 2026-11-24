import model from "./models/exit-advisor-v1.json" with { type: "json" };
import { predictProba, type HistGbtModel } from "./histgbt.js";
import { easternClock } from "./exit-engine.js";
import { stampAdvisorRow } from "./store.js";
import type { ManagedPosition } from "./types.js";

// EXIT ADVISOR — ADVISORY STAMPS ONLY (tournament verdict 2026-11-24: hybrid =
// V0 floor + this tree above it captured 30-35% of peak value vs V0's 19.3% on
// six unseen months; threshold 0.55 tuned on validation months, never on test).
// Every held minute each same-day position gets the model's opinion journaled to
// exit_advisor_stamps. NOTHING here sells: the stamps earn (or lose) trust against
// real exits for a few weeks before the hybrid gets hands. Multi-day holds
// (trend/thesis/convexity carried overnight) are skipped — the model was trained
// on same-day fire tapes and has no business opining outside its distribution.

const MODEL = model as HistGbtModel;
const lastStampMinute = new Map<string, string>(); // occ -> `${dateKey}:${minute}`

// Scores a position with the exit advisor and journals the opinion once a minute.
// Returns {prob, threshold} for the manager to hand evaluateExit (the HYBRID: ML
// replaces trail/ratchet on plain same-day paper positions, V0 floor keeps the last
// word), or null when the position is outside the model's training distribution
// (not burst mode, held overnight, outside RTH) — then V0 rules apply untouched.
export function adviseExit(position: ManagedPosition, bid: number, now: number): { prob: number; threshold: number } | null {
  try {
    if (position.exitMode !== "burst") return null; // model trained on the burst fire family
    if (bid <= 0 || position.entryPrice <= 0) return null;
    const clock = easternClock(new Date(now));
    if (clock.minutes < 570 || clock.minutes > 960) return null;
    const opened = easternClock(new Date(position.openedAt));
    if (opened.dateKey !== clock.dateKey) return null; // same-day positions only
    const entry = position.entryPrice;
    const peak = Math.max(position.peakBid, bid);
    const features = [
      bid / entry - 1,                                   // gain
      peak / entry - 1,                                  // peakGain
      1 - bid / Math.max(peak, 1e-9),                    // drawdownFromPeak
      clock.minutes - Math.max(opened.minutes, 570),     // minutesHeld
      clock.minutes,                                     // minuteOfDay
      entry,                                             // entryPrem
      position.side === "call" ? 1 : -1,                 // dir
    ];
    const prob = predictProba(MODEL, features);
    const key = `${clock.dateKey}:${clock.minutes}`;
    if (lastStampMinute.get(position.alpacaSymbol) !== key) {
      lastStampMinute.set(position.alpacaSymbol, key);
      // Journal fire-and-forget: the exit path never waits on the stamp insert, but a
      // dead stamp writer stays visible in logs instead of vanishing (blind-gap doctrine).
      void stampAdvisorRow({
        occ: position.alpacaSymbol, minuteEt: clock.minutes, prob,
        opinion: prob >= MODEL.threshold ? "hold" : "exit",
        features: { gain: features[0], peakGain: features[1], drawdown: features[2], held: features[3], minute: features[4], entry: features[5], dir: features[6] },
      }).catch(error => console.error("exit advisor stamp failed", error instanceof Error ? error.message : error));
    }
    return { prob, threshold: MODEL.threshold };
  } catch (error) {
    console.error("exit advisor failed", error instanceof Error ? error.message : error);
    return null; // a broken advisor degrades to pure V0, never to a blocked exit path
  }
}

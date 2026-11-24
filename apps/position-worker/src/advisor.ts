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

export async function stampExitAdvisor(position: ManagedPosition, bid: number, now: number): Promise<void> {
  try {
    if (bid <= 0 || position.entryPrice <= 0) return;
    const clock = easternClock(new Date(now));
    if (clock.minutes < 570 || clock.minutes > 960) return;
    const opened = easternClock(new Date(position.openedAt));
    if (opened.dateKey !== clock.dateKey) return; // same-day positions only (training distribution)
    const key = `${clock.dateKey}:${clock.minutes}`;
    if (lastStampMinute.get(position.alpacaSymbol) === key) return; // one stamp per minute
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
    lastStampMinute.set(position.alpacaSymbol, key);
    await stampAdvisorRow({
      occ: position.alpacaSymbol, minuteEt: clock.minutes, prob,
      opinion: prob >= MODEL.threshold ? "hold" : "exit",
      features: { gain: features[0], peakGain: features[1], drawdown: features[2], held: features[3], minute: features[4], entry: features[5], dir: features[6] },
    });
  } catch (error) {
    // Advisory lane must never disturb the exit path — but a dead stamp writer is a
    // blind gap, so it stays visible in logs rather than vanishing.
    console.error("exit advisor stamp failed", error instanceof Error ? error.message : error);
  }
}

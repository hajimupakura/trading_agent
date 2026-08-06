// Entry-order management: buys are submitted at the option midpoint (see the app's
// paper-trading route); this engine escalates the working limit toward the ask if
// unfilled, and cancels a stale entry — the signal that justified it is gone by then.
export const ENTRY_RULES = { stepOneMs: 15_000, stepTwoMs: 30_000, cancelMs: 75_000 } as const;

export type EntryPlan = { action: "hold" } | { action: "cancel" } | { action: "reprice"; price: number };

export function planEntryOrder(input: { ageMs: number; ask: number; midpoint: number; currentLimit: number }): EntryPlan {
  if (input.ageMs >= ENTRY_RULES.cancelMs) return { action: "cancel" };
  const target = input.ageMs >= ENTRY_RULES.stepTwoMs ? input.ask
    : input.ageMs >= ENTRY_RULES.stepOneMs ? (input.midpoint + input.ask) / 2
    : input.midpoint;
  const price = Math.max(.01, Number(target.toFixed(2)));
  // Only ever raise a buy limit, and only when the move is at least a cent.
  return price > input.currentLimit + .009 ? { action: "reprice", price } : { action: "hold" };
}

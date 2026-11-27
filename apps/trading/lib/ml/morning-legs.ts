// Morning 30-minute legs — the lottery-day stamp's inputs (see lottery-stamp.ts).
// Pure and dependency-free so it can be unit-tested and reused by a future detector.
export const MIN_LEG_PCT = 1.5;

const etMinuteOf = (timestamp: number) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(timestamp)).map(part => [part.type, part.value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
};

export type MorningLeg = { sym: string; dir: 1 | -1; legPct: number; startMin: number };

// Each name's strongest COMPLETED 30-bar move per direction between 9:30 and 11:00
// (same 30-bar step the historical scan uses). Pure: bars in, legs out.
export function morningLegs(sym: string, bars: Array<{ timestamp: number; close: number }>): MorningLeg[] {
  const session = bars.map(bar => ({ min: etMinuteOf(bar.timestamp), close: bar.close })).filter(bar => bar.min >= 570 && bar.min < 660 && bar.close > 0);
  const legs: MorningLeg[] = [];
  for (const dir of [1, -1] as const) {
    let best = 0; let startMin = 0;
    for (let i = 0; i + 30 < session.length; i++) {
      const move = dir * (session[i + 30].close - session[i].close) / session[i].close * 100;
      if (move > best) { best = move; startMin = session[i].min; }
    }
    if (best >= MIN_LEG_PCT) legs.push({ sym, dir, legPct: Number(best.toFixed(2)), startMin });
  }
  return legs;
}


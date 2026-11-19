// Trend-continuation path replay over sampled SPX days, old vs loosened gates.
// Per day: OR = first 15 bars; from bar 45: persistence (30 bars beyond OR +
// right side of session mean), consolidation = prior 9 closes, tightness and
// fresh-break measured in ATR (mean abs 1-min move, 14 bars). Entry on fire,
// exit on invalidation (close back across the consolidation boundary) or last
// bar. P&L in SPX points on the underlying. 20-bar same-side cooldown.
import { readFileSync, readdirSync } from "fs";
const DIR = process.argv[2];
const CONFIGS = { putOnly: { tight: 3.0, brk: 1.5, rsiPut: [15, 50], rsiCall: [50, 80], callTight: 1.5, callBrk: 0.65 }, old: { tight: 1.5, brk: 0.65, rsiPut: [20, 50], rsiCall: [50, 80] },
                  loose: { tight: 3.0, brk: 1.5, rsiPut: [15, 50], rsiCall: [50, 85] } };
const ema = (p, s) => { const k = 2 / (p + 1); let e = s[0]; const out = [e]; for (let i = 1; i < s.length; i++) { e = s[i] * k + e * (1 - k); out.push(e); } return out; };
function replayDay(closes, cfg) {
  const ema12 = ema(12, closes), ema26 = ema(26, closes);
  const macdLine = closes.map((_, i) => ema12[i] - ema26[i]); const macdSig = ema(9, macdLine);
  const atr = i => { let s = 0; for (let k = i - 13; k <= i; k++) s += Math.abs(closes[k] - closes[k - 1]); return s / 14; };
  const rsi = i => { let g = 0, l = 0; for (let k = i - 13; k <= i; k++) { const d = closes[k] - closes[k - 1]; if (d > 0) g += d; else l -= d; } return g + l === 0 ? 50 : 100 * g / (g + l); };
  let meanSum = 0; const means = closes.map((c, i) => (meanSum += c) / (i + 1));
  const ORH = Math.max(...closes.slice(0, 15)), ORL = Math.min(...closes.slice(0, 15));
  const trades = []; let pos = null; let cooldownUntil = { put: -1, call: -1 };
  for (let i = 45; i < closes.length; i++) {
    const c = closes[i];
    if (pos) { // manage
      const inval = pos.side === "put" ? c > pos.invalidation : c < pos.invalidation;
      if (inval || i === closes.length - 1) {
        const pts = pos.side === "put" ? pos.entry - c : c - pos.entry;
        trades.push({ side: pos.side, entryBar: pos.bar, exitBar: i, entry: pos.entry, exit: c, pts: +pts.toFixed(2), reason: inval ? "invalidation" : "eod" });
        cooldownUntil[pos.side] = i + 20; pos = null;
      }
      continue;
    }
    const a = atr(i); if (!(a > 0)) continue;
    const last30 = closes.slice(i - 29, i + 1);
    const cons = closes.slice(i - 9, i);
    const consLow = Math.min(...cons), consHigh = Math.max(...cons);
    const tightPut = consHigh - consLow <= a * cfg.tight; const tightCall = consHigh - consLow <= a * (cfg.callTight ?? cfg.tight);
    const r = rsi(i); const macdUp = macdLine[i] > macdSig[i];
    const slopeUp = means[i] - means[i - 5] > 0;
    const putOk = i > cooldownUntil.put && last30.every(x => x < ORL) && c < means[i] && tightPut
      && c < consLow && consLow - c <= a * cfg.brk && r >= cfg.rsiPut[0] && r <= cfg.rsiPut[1] && !macdUp && !slopeUp;
    const callOk = i > cooldownUntil.call && last30.every(x => x > ORH) && c > means[i] && tightCall
      && c > consHigh && c - consHigh <= a * (cfg.callBrk ?? cfg.brk) && r >= cfg.rsiCall[0] && r <= cfg.rsiCall[1] && macdUp && slopeUp;
    if (putOk) pos = { side: "put", bar: i, entry: c, invalidation: consHigh };
    else if (callOk) pos = { side: "call", bar: i, entry: c, invalidation: consLow };
  }
  return trades;
}
const files = readdirSync(DIR).filter(f => f.endsWith(".csv")).sort();
for (const [name, cfg] of Object.entries(CONFIGS)) {
  let total = 0, wins = 0, n = 0; const lines = [];
  for (const file of files) {
    const closes = readFileSync(`${DIR}/${file}`, "utf8").trim().split(",").map(Number);
    if (closes.length < 60 || Math.max(...closes) - Math.min(...closes) < 1) continue; // flat/stale day
    const trades = replayDay(closes, cfg);
    for (const t of trades) { total += t.pts; wins += t.pts > 0 ? 1 : 0; n++; }
    if (trades.length) lines.push(`  ${file.replace(".csv","")}: ` + trades.map(t => `${t.side}@${t.entry}(${t.pts > 0 ? "+" : ""}${t.pts}pts,${t.reason})`).join(" "));
  }
  console.log(`== ${name} (tight<=${cfg.tight} ATR, brk<=${cfg.brk} ATR, RSI put ${cfg.rsiPut}, call ${cfg.rsiCall}) ==`);
  console.log(lines.join("\n") || "  no trades");
  console.log(`  TOTAL: ${n} trades, ${wins} wins (${n ? Math.round(100 * wins / n) : 0}%), ${total >= 0 ? "+" : ""}${total.toFixed(1)} SPX pts\n`);
}

// USAGE: node trend-path-replay.mjs <dir-of-day-csvs>
// Each CSV = one session's comma-separated SPX minute closes (from index_bar_samples:
//   SELECT string_agg(round(price::numeric,2)::text, ',' ORDER BY bar_time) ... GROUP BY day).
// This script decided the 2026-11-19 put-side-only SPX loosening (commit da6e31f):
// old gates 2 trades -3.5 pts / both loose 23 @ 30% +33.9 / putOnly 14 @ 43% +64.9.

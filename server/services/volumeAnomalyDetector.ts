/**
 * Volume Anomaly Detector
 *
 * Tracks real-time volume from the Finnhub WebSocket feed and detects
 * anomalous volume spikes relative to rolling averages.
 *
 * Alert Levels:
 *   L1 (Noise): 1-2x average — log only
 *   L2 (Notable): 2-3x average — alert + monitor
 *   L3 (Unusual): 3-5x average — alert + prepare execution
 *   L4 (Whale): 5x+ average — alert + auto-queue trade
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type AlertLevel = "L1" | "L2" | "L3" | "L4";

export interface VolumeAnomaly {
  symbol: string;
  level: AlertLevel;
  currentVolume: number;
  averageVolume: number;
  ratio: number; // currentVolume / averageVolume
  timestamp: Date;
}

interface VolumeBar {
  volume: number;
  timestamp: number; // minute-aligned Unix ms
}

// ── State ────────────────────────────────────────────────────────────────────

// Rolling 1-min volume bars per symbol (up to 20 days of market hours = ~7800 bars)
const volumeHistory = new Map<string, VolumeBar[]>();
// Current minute accumulator
const currentMinute = new Map<string, { volume: number; minuteTs: number }>();
// Recent anomalies (last hour)
const recentAnomalies: VolumeAnomaly[] = [];
const MAX_HISTORY_BARS = 8000; // ~20 trading days of 1-min bars
const MAX_ANOMALIES = 100;

// ── Core Functions ───────────────────────────────────────────────────────────

/**
 * Ingest a trade event from the WebSocket.
 * Call this from the priceWebSocket 'price' event handler.
 */
export function ingestTrade(symbol: string, volume: number, timestamp: number): void {
  const minuteTs = Math.floor(timestamp / 60000) * 60000;

  const current = currentMinute.get(symbol);
  if (current && current.minuteTs === minuteTs) {
    // Same minute — accumulate
    current.volume += volume;
  } else {
    // New minute — finalize previous and start new
    if (current) {
      finalizeBar(symbol, current.volume, current.minuteTs);
    }
    currentMinute.set(symbol, { volume, minuteTs });
  }
}

function finalizeBar(symbol: string, volume: number, minuteTs: number): void {
  if (!volumeHistory.has(symbol)) volumeHistory.set(symbol, []);
  const history = volumeHistory.get(symbol)!;
  history.push({ volume, timestamp: minuteTs });

  // Trim old bars
  if (history.length > MAX_HISTORY_BARS) {
    history.splice(0, history.length - MAX_HISTORY_BARS);
  }

  // Check for anomaly
  checkAnomaly(symbol, volume, history);
}

function checkAnomaly(symbol: string, currentVolume: number, history: VolumeBar[]): void {
  if (history.length < 20) return; // Need at least 20 bars for meaningful average

  // Compute average volume (exclude current bar)
  const avgBars = history.slice(-101, -1); // last 100 bars
  if (avgBars.length < 10) return;

  const avgVolume = avgBars.reduce((sum, b) => sum + b.volume, 0) / avgBars.length;
  if (avgVolume <= 0) return;

  const ratio = currentVolume / avgVolume;

  if (ratio < 2) return; // Below L2, ignore

  const level: AlertLevel = ratio >= 5 ? "L4" : ratio >= 3 ? "L3" : "L2";

  const anomaly: VolumeAnomaly = {
    symbol,
    level,
    currentVolume,
    averageVolume: Math.round(avgVolume),
    ratio: Math.round(ratio * 10) / 10,
    timestamp: new Date(),
  };

  recentAnomalies.push(anomaly);
  if (recentAnomalies.length > MAX_ANOMALIES) recentAnomalies.shift();

  if (level === "L3" || level === "L4") {
    console.log(
      `[VolumeAnomaly] ${level} ALERT: ${symbol} volume ${currentVolume.toLocaleString()} ` +
      `(${ratio.toFixed(1)}x avg ${Math.round(avgVolume).toLocaleString()})`,
    );
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Get all recent anomalies (last hour), optionally filtered by minimum level.
 */
export function getRecentAnomalies(minLevel: AlertLevel = "L2"): VolumeAnomaly[] {
  const levelOrder: Record<AlertLevel, number> = { L1: 1, L2: 2, L3: 3, L4: 4 };
  const minOrd = levelOrder[minLevel];
  const cutoff = Date.now() - 60 * 60 * 1000; // last hour

  return recentAnomalies
    .filter((a) => levelOrder[a.level] >= minOrd && a.timestamp.getTime() >= cutoff)
    .sort((a, b) => b.ratio - a.ratio);
}

/**
 * Get a text summary for the trading agent.
 */
export function getVolumeAnomalySummary(): string {
  const anomalies = getRecentAnomalies("L2");
  if (anomalies.length === 0) return "No unusual volume activity detected.";

  const lines = anomalies.slice(0, 10).map(
    (a) =>
      `- ${a.level} ${a.symbol}: ${a.currentVolume.toLocaleString()} vol (${a.ratio}x avg) at ${a.timestamp.toISOString().slice(11, 19)}`,
  );
  return `VOLUME ANOMALIES (${anomalies.length} detected):\n${lines.join("\n")}`;
}

/**
 * Get anomalies formatted for dashboard alerts.
 */
export function getVolumeAlertsForDashboard(): Array<{
  category: "volume";
  type: string;
  ticker: string;
  headline: string;
  detail: string;
  context: string;
  sentiment: "bullish" | "bearish" | "neutral";
  timestamp: string;
  value: number | null;
}> {
  const anomalies = getRecentAnomalies("L3"); // Only L3+ for dashboard
  return anomalies.slice(0, 5).map((a) => {
    const levelDesc = a.level === "L4" ? "whale-tier (5x+)" : "unusual (3-5x)";
    return {
      category: "volume" as const,
      type: `volume_${a.level.toLowerCase()}`,
      ticker: a.symbol,
      headline: `${a.symbol} ${a.level} volume spike — ${a.ratio}x average`,
      detail: `${a.currentVolume.toLocaleString()} vs avg ${a.averageVolume.toLocaleString()}`,
      context: `${a.symbol} traded ${a.currentVolume.toLocaleString()} shares in the last minute vs its 20-day average of ${a.averageVolume.toLocaleString()} — a ${a.ratio}x spike classified as ${levelDesc}. Volume anomalies of this magnitude often precede major news, earnings surprises, or large institutional positioning. Watch for price confirmation in the next 5-15 minutes.`,
      sentiment: "neutral" as const,
      timestamp: a.timestamp.toISOString(),
      value: a.ratio,
    };
  });
}

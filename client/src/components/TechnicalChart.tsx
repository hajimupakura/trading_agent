import { useState, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import {
  ComposedChart, LineChart, BarChart,
  Line, Bar, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, Legend,
} from "recharts";
import { X, Loader2, TrendingUp, TrendingDown } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

type Interval = "5m" | "15m" | "30m" | "1h" | "4h" | "1d";

const INTERVALS: { label: string; value: Interval }[] = [
  { label: "5m",  value: "5m"  },
  { label: "15m", value: "15m" },
  { label: "30m", value: "30m" },
  { label: "1h",  value: "1h"  },
  { label: "4h",  value: "4h"  },
  { label: "1D",  value: "1d"  },
];

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtTime(ts: number, interval: Interval) {
  const d = new Date(ts);
  if (interval === "1d") {
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function fmtPrice(n: number | null) {
  if (n == null) return "—";
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtN(n: number | null, dp = 2) {
  if (n == null) return "—";
  return n.toFixed(dp);
}

// Candlestick-style bar (green/red open-close range)
function CandleBar(props: any) {
  const { x, y, width, height, payload } = props;
  if (!payload || payload.open == null) return null;
  const isUp = payload.close >= payload.open;
  const color = isUp ? "#22c55e" : "#ef4444";
  const bodyTop    = isUp ? payload.close : payload.open;
  const bodyBottom = isUp ? payload.open  : payload.close;
  const range = bodyTop - bodyBottom;

  // We get y/height from the chart scale for the "close" value
  // Compute pixel positions using the scale passed via props
  const { yScale } = props;
  if (!yScale) return null;

  const wickTop    = yScale(payload.high);
  const wickBottom = yScale(payload.low);
  const bTop       = yScale(bodyTop);
  const bBottom    = yScale(bodyBottom);
  const bodyH      = Math.max(1, bBottom - bTop);
  const cx         = x + width / 2;

  return (
    <g>
      {/* Wick */}
      <line x1={cx} x2={cx} y1={wickTop} y2={wickBottom} stroke={color} strokeWidth={1} />
      {/* Body */}
      <rect x={x + 1} y={bTop} width={Math.max(2, width - 2)} height={bodyH} fill={color} />
    </g>
  );
}

// Custom tooltip
function ChartTooltip({ active, payload, label, interval }: any) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;
  return (
    <div className="bg-background border border-border rounded-lg p-3 text-xs shadow-lg min-w-[180px]">
      <div className="font-mono text-muted-foreground mb-2">{fmtTime(d.t, interval)}</div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        <span className="text-muted-foreground">O</span><span className="font-mono">{fmtPrice(d.open)}</span>
        <span className="text-muted-foreground">H</span><span className="font-mono text-profit">{fmtPrice(d.high)}</span>
        <span className="text-muted-foreground">L</span><span className="font-mono text-loss">{fmtPrice(d.low)}</span>
        <span className="text-muted-foreground">C</span><span className={`font-mono font-bold ${d.close >= d.open ? "text-profit" : "text-loss"}`}>{fmtPrice(d.close)}</span>
        {d.volume > 0 && <><span className="text-muted-foreground">Vol</span><span className="font-mono">{(d.volume / 1000).toFixed(0)}K</span></>}
      </div>
      {d.rsi != null && <div className="mt-2 pt-2 border-t border-border grid grid-cols-2 gap-x-4 gap-y-1">
        <span className="text-muted-foreground">RSI</span><span className={`font-mono font-semibold ${d.rsi >= 70 ? "text-loss" : d.rsi <= 30 ? "text-profit" : "text-foreground"}`}>{fmtN(d.rsi)}</span>
        {d.macd != null && <><span className="text-muted-foreground">MACD</span><span className="font-mono">{fmtN(d.macd)}</span></>}
        {d.macdSignal != null && <><span className="text-muted-foreground">Signal</span><span className="font-mono">{fmtN(d.macdSignal)}</span></>}
      </div>}
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────

interface Props {
  symbol: string;
  onClose: () => void;
}

export function TechnicalChart({ symbol, onClose }: Props) {
  const [interval, setInterval] = useState<Interval>("1d");

  const { data, isLoading } = trpc.technicals.chartData.useQuery(
    { symbol, interval },
    { staleTime: 2 * 60_000 }
  );

  const bars = data?.bars ?? [];

  // Thin out bars for display if too many (keep last 200)
  const display = useMemo(() => bars.slice(-200), [bars]);

  const priceMin = useMemo(() => {
    if (!display.length) return 0;
    return Math.min(...display.map(b => b.low ?? b.close).filter(Boolean)) * 0.995;
  }, [display]);

  const priceMax = useMemo(() => {
    if (!display.length) return 0;
    return Math.max(...display.map(b => b.high ?? b.close).filter(Boolean)) * 1.005;
  }, [display]);

  const lastBar = display[display.length - 1];
  const prevBar = display[display.length - 2];
  const priceChange = lastBar && prevBar ? lastBar.close - prevBar.close : null;
  const pricePct    = lastBar && prevBar ? ((lastBar.close - prevBar.close) / prevBar.close) * 100 : null;
  const isUp        = priceChange != null && priceChange >= 0;

  const xTick = (ts: number) => fmtTime(ts, interval);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="bg-background border border-border rounded-xl w-full max-w-5xl max-h-[90vh] flex flex-col shadow-2xl">
        {/* ── Header ── */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <div className="flex items-center gap-4">
            <div>
              <span className="text-lg font-mono font-bold">{symbol}</span>
              {lastBar && (
                <span className="ml-3 text-xl font-mono font-bold">{fmtPrice(lastBar.close)}</span>
              )}
              {priceChange != null && (
                <span className={`ml-2 text-sm font-mono font-semibold flex-inline items-center gap-1 ${isUp ? "text-profit" : "text-loss"}`}>
                  {isUp ? "▲" : "▼"} {Math.abs(priceChange).toFixed(2)} ({pricePct != null ? (pricePct >= 0 ? "+" : "") + pricePct.toFixed(2) : ""}%)
                </span>
              )}
            </div>
          </div>

          {/* Interval selector */}
          <div className="flex items-center gap-2">
            <div className="flex gap-1 bg-secondary rounded-lg p-1">
              {INTERVALS.map(iv => (
                <button
                  key={iv.value}
                  onClick={() => setInterval(iv.value)}
                  className={`px-3 py-1 text-xs font-mono rounded-md transition-colors ${
                    interval === iv.value
                      ? "bg-primary text-primary-foreground font-bold"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {iv.label}
                </button>
              ))}
            </div>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* ── Body ── */}
        {isLoading ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : display.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
            No chart data available for {symbol} at {interval}
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-4 space-y-3 min-h-0">

            {/* ── Price + BB + SMAs ── */}
            <div>
              <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1 px-1">
                Price · Bollinger Bands · SMA20/50/200
              </div>
              <ResponsiveContainer width="100%" height={280}>
                <ComposedChart data={display} margin={{ left: 0, right: 56, top: 4, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.4} />
                  <XAxis dataKey="t" tickFormatter={xTick} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} minTickGap={40} />
                  <YAxis domain={[priceMin, priceMax]} orientation="right" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickFormatter={v => "$" + v.toFixed(0)} width={56} />
                  <Tooltip content={<ChartTooltip interval={interval} />} />

                  {/* Bollinger band fill */}
                  <Area dataKey="bbUpper" stroke="none" fill="hsl(var(--primary))" fillOpacity={0.06} dot={false} connectNulls />
                  <Area dataKey="bbLower" stroke="none" fill="hsl(var(--background))" fillOpacity={1} dot={false} connectNulls />

                  {/* BB lines */}
                  <Line dataKey="bbUpper"  stroke="hsl(var(--primary))" strokeWidth={1} dot={false} strokeDasharray="3 3" connectNulls name="BB Upper" />
                  <Line dataKey="bbMiddle" stroke="hsl(var(--primary))" strokeWidth={1} dot={false} strokeOpacity={0.4} connectNulls name="BB Mid" />
                  <Line dataKey="bbLower"  stroke="hsl(var(--primary))" strokeWidth={1} dot={false} strokeDasharray="3 3" connectNulls name="BB Lower" />

                  {/* SMAs */}
                  <Line dataKey="sma20"  stroke="#f59e0b" strokeWidth={1.5} dot={false} connectNulls name="SMA20" />
                  <Line dataKey="sma50"  stroke="#3b82f6" strokeWidth={1.5} dot={false} connectNulls name="SMA50" />
                  <Line dataKey="sma200" stroke="#8b5cf6" strokeWidth={1.5} dot={false} connectNulls name="SMA200" />

                  {/* Close price line (bold, colored by direction) */}
                  <Line
                    dataKey="close"
                    stroke={isUp ? "#22c55e" : "#ef4444"}
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                    name="Close"
                  />

                  <Legend
                    wrapperStyle={{ fontSize: 10, paddingTop: 4 }}
                    formatter={(value) => <span style={{ color: "hsl(var(--muted-foreground))" }}>{value}</span>}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {/* ── Volume ── */}
            <div>
              <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1 px-1">Volume</div>
              <ResponsiveContainer width="100%" height={60}>
                <BarChart data={display} margin={{ left: 0, right: 56, top: 0, bottom: 0 }}>
                  <XAxis dataKey="t" hide />
                  <YAxis orientation="right" tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} tickFormatter={v => (v / 1000000).toFixed(1) + "M"} width={56} />
                  <Bar dataKey="volume" fill="hsl(var(--primary))" opacity={0.5} radius={[1, 1, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* ── RSI ── */}
            <div>
              <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1 px-1">
                RSI (14) · Last: {lastBar?.rsi != null ? <span className={lastBar.rsi >= 70 ? "text-loss" : lastBar.rsi <= 30 ? "text-profit" : "text-foreground"}>{lastBar.rsi.toFixed(1)}</span> : "—"}
              </div>
              <ResponsiveContainer width="100%" height={90}>
                <LineChart data={display} margin={{ left: 0, right: 56, top: 4, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.4} />
                  <XAxis dataKey="t" hide />
                  <YAxis domain={[0, 100]} orientation="right" ticks={[30, 50, 70]} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} width={56} />
                  <ReferenceLine y={70} stroke="#ef4444" strokeDasharray="3 3" strokeWidth={1} label={{ value: "OB", position: "right", fontSize: 9, fill: "#ef4444" }} />
                  <ReferenceLine y={30} stroke="#22c55e" strokeDasharray="3 3" strokeWidth={1} label={{ value: "OS", position: "right", fontSize: 9, fill: "#22c55e" }} />
                  <ReferenceLine y={50} stroke="hsl(var(--border))" strokeWidth={1} />
                  <Line dataKey="rsi" stroke="#f59e0b" strokeWidth={2} dot={false} connectNulls name="RSI(14)" />
                  <Tooltip content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const rsi = payload[0]?.payload?.rsi;
                    if (rsi == null) return null;
                    return (
                      <div className="bg-background border border-border rounded px-2 py-1 text-xs font-mono">
                        RSI: <span className={rsi >= 70 ? "text-loss" : rsi <= 30 ? "text-profit" : "text-foreground"}>{rsi.toFixed(1)}</span>
                      </div>
                    );
                  }} />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* ── MACD ── */}
            <div>
              <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1 px-1">
                MACD (12,26,9) · Line: {fmtN(lastBar?.macd)} · Signal: {fmtN(lastBar?.macdSignal)} · Hist: {fmtN(lastBar?.macdHist)}
              </div>
              <ResponsiveContainer width="100%" height={90}>
                <ComposedChart data={display} margin={{ left: 0, right: 56, top: 4, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.4} />
                  <XAxis dataKey="t" tickFormatter={xTick} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} minTickGap={40} />
                  <YAxis orientation="right" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickFormatter={v => v.toFixed(1)} width={56} />
                  <ReferenceLine y={0} stroke="hsl(var(--border))" strokeWidth={1} />
                  <Bar
                    dataKey="macdHist"
                    name="Histogram"
                    fill="#6b7280"
                    radius={[1, 1, 0, 0]}
                    // color each bar green/red based on value
                    isAnimationActive={false}
                  >
                    {display.map((entry, index) => (
                      <rect
                        key={index}
                        fill={(entry.macdHist ?? 0) >= 0 ? "#22c55e" : "#ef4444"}
                        fillOpacity={0.6}
                      />
                    ))}
                  </Bar>
                  <Line dataKey="macd"       stroke="#3b82f6" strokeWidth={1.5} dot={false} connectNulls name="MACD" />
                  <Line dataKey="macdSignal" stroke="#f97316" strokeWidth={1.5} dot={false} connectNulls name="Signal" />
                  <Tooltip content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const d = payload[0]?.payload;
                    return (
                      <div className="bg-background border border-border rounded px-2 py-1 text-xs font-mono space-y-0.5">
                        <div>MACD: {fmtN(d?.macd)}</div>
                        <div>Sig: {fmtN(d?.macdSignal)}</div>
                        <div>Hist: <span className={(d?.macdHist ?? 0) >= 0 ? "text-profit" : "text-loss"}>{fmtN(d?.macdHist)}</span></div>
                      </div>
                    );
                  }} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

          </div>
        )}

        {/* ── Footer ── */}
        <div className="px-5 py-2 border-t border-border flex items-center justify-between text-[10px] text-muted-foreground">
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-amber-400 inline-block" /> SMA20</span>
            <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-blue-500 inline-block" /> SMA50</span>
            <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-violet-500 inline-block" /> SMA200</span>
            <span className="flex items-center gap-1"><span className="w-3 h-0.5 border-t border-primary border-dashed inline-block" style={{height:0}} /> BB (20,2)</span>
          </div>
          <div>Data via Yahoo Finance · {display.length} bars</div>
        </div>
      </div>
    </div>
  );
}

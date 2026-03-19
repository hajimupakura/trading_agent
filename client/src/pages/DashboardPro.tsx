import { useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { trpc } from "@/lib/trpc";
import { getLoginUrl } from "@/const";
import { toast } from "sonner";
import {
  Bell, RefreshCw, Loader2, Target, Sparkles,
  Activity, Shield, Zap, BarChart3, Bot, Pause, Play,
  ChevronUp, ChevronDown, Eye,
  Briefcase, Radio, AlertTriangle, BookOpen,
  Settings, LogOut, RotateCcw,
} from "lucide-react";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number | null | undefined, decimals = 2) {
  if (n == null) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtUSD(n: number | null | undefined) {
  if (n == null) return "—";
  return "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPct(n: number | null | undefined) {
  if (n == null) return "—";
  const sign = n >= 0 ? "+" : "";
  return sign + n.toFixed(2) + "%";
}

function rsiLabel(rsi: number | null | undefined) {
  if (rsi == null) return { label: "—", color: "text-muted-foreground" };
  if (rsi >= 70) return { label: `${rsi.toFixed(0)} OB`, color: "text-loss" };
  if (rsi <= 30) return { label: `${rsi.toFixed(0)} OS`, color: "text-profit" };
  return { label: `${rsi.toFixed(0)}`, color: "text-foreground" };
}

function timeAgo(date: string | Date) {
  const ms = Date.now() - new Date(date).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ─── Unauthenticated landing ───────────────────────────────────────────────

function UnauthScreen() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background p-4">
      <div className="max-w-sm w-full text-center space-y-6">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20">
          <Activity className="h-8 w-8 text-primary" />
        </div>
        <div>
          <h1 className="text-3xl font-bold text-foreground mb-2">Trading Agent</h1>
          <p className="text-sm text-muted-foreground">AI-powered autonomous trading intelligence</p>
        </div>
        <div className="space-y-3 text-left">
          {[
            { icon: Bot, text: "6 specialist AI agents analyzing in parallel" },
            { icon: Shield, text: "Risk-managed paper trading with P&L tracking" },
            { icon: Zap, text: "Insider, Congress, Reddit & technical signals" },
          ].map(({ icon: Icon, text }) => (
            <div key={text} className="flex items-center gap-3 text-sm text-muted-foreground bg-secondary/40 rounded-lg px-4 py-2.5">
              <Icon className="h-4 w-4 text-primary shrink-0" />
              <span>{text}</span>
            </div>
          ))}
        </div>
        <Button asChild className="w-full h-11">
          <a href={getLoginUrl()}>Sign In to Continue</a>
        </Button>
      </div>
    </div>
  );
}

// ─── Main Dashboard ─────────────────────────────────────────────────────────

export default function DashboardPro() {
  const { user, loading: authLoading, isAuthenticated, logout } = useAuth();
  const [insiderTicker, setInsiderTicker] = useState("NVDA");

  // ── Core data ────────────────────────────────────────────────────────────
  const { data: agentStatus, refetch: refetchAgent } = trpc.agent.status.useQuery(
    undefined, { refetchInterval: 30_000 }
  );
  const { data: cycleLogs = [] } = trpc.agent.cycleLogs.useQuery(
    { limit: 8 }, { enabled: isAuthenticated }
  );
  const { data: news = [], isLoading: newsLoading, refetch: refetchNews } = trpc.news.recent.useQuery();
  const { data: watchlist = [] } = trpc.watchlist.list.useQuery(
    undefined, { enabled: isAuthenticated }
  );
  const { data: alerts = [] } = trpc.alerts.list.useQuery(
    { unreadOnly: true }, { enabled: isAuthenticated }
  );
  const { data: predictions = [], refetch: refetchPredictions } = trpc.predictions.upcoming.useQuery();
  const { data: scorecard } = trpc.predictions.scorecard.useQuery();
  const { data: sectorMomentum = [] } = trpc.sectors.momentum.useQuery();
  const { data: riskSettings } = trpc.risk.settings.useQuery(
    undefined, { enabled: isAuthenticated }
  );
  const { data: portfolios = [], refetch: refetchPortfolios } = trpc.portfolio.list.useQuery(
    undefined, { enabled: isAuthenticated }
  );
  const { data: redditSentiment } = trpc.sentiment.reddit.useQuery(
    undefined, { enabled: isAuthenticated, staleTime: 5 * 60_000 }
  );

  // ── Derived queries (depend on earlier data) ─────────────────────────────
  const watchlistTickers = watchlist.map((w) => w.ticker);
  const { data: stockQuotes } = trpc.stocks.getMultipleQuotes.useQuery(
    { symbols: watchlistTickers },
    { enabled: watchlistTickers.length > 0, refetchInterval: 60_000 }
  );
  const { data: technicals } = trpc.technicals.multipleIndicators.useQuery(
    { symbols: watchlistTickers.slice(0, 15) },
    { enabled: watchlistTickers.length > 0 }
  );
  const firstPortfolioId = portfolios[0]?.id;
  const { data: portfolioSummary } = trpc.portfolio.summary.useQuery(
    { portfolioId: firstPortfolioId! },
    { enabled: !!firstPortfolioId }
  );
  const { data: tradeHistory = [] } = trpc.portfolio.tradeHistory.useQuery(
    { portfolioId: firstPortfolioId!, limit: 20 },
    { enabled: !!firstPortfolioId }
  );
  const { data: insiderData = [] } = trpc.sec.insiderTransactions.useQuery(
    { ticker: insiderTicker, limit: 12 },
    { enabled: isAuthenticated }
  );

  // ── Mutations ─────────────────────────────────────────────────────────────
  const analyzeNews = trpc.news.analyze.useMutation({
    onSuccess: () => { toast.success("News analyzed"); refetchNews(); },
    onError: (e) => toast.error(e.message),
  });
  const generatePredictions = trpc.predictions.generate.useMutation({
    onSuccess: (d) => { toast.success(`Generated ${d.count} predictions`); refetchPredictions(); },
    onError: (e) => toast.error(e.message),
  });
  const syncRss = trpc.sync.rssNews.useMutation({
    onSuccess: () => toast.success("RSS feeds synced"),
    onError: (e) => toast.error(e.message),
  });
  const pauseAgent = trpc.agent.pause.useMutation({
    onSuccess: () => { toast.success("Agent paused"); refetchAgent(); },
  });
  const resumeAgent = trpc.agent.resume.useMutation({
    onSuccess: () => { toast.success("Agent resumed"); refetchAgent(); },
  });
  const runNow = trpc.agent.runNow.useMutation({
    onSuccess: () => { toast.success("Agent cycle triggered"); refetchAgent(); },
    onError: (e) => toast.error(e.message),
  });
  const createPortfolio = trpc.portfolio.create.useMutation({
    onSuccess: () => { toast.success("Portfolio created with $100,000"); refetchPortfolios(); },
    onError: (e) => toast.error(e.message),
  });

  // ── Loading / Unauth guards ───────────────────────────────────────────────
  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <span className="text-sm text-muted-foreground">Initializing terminal…</span>
        </div>
      </div>
    );
  }
  if (!isAuthenticated) return <UnauthScreen />;

  // ── Derived values ────────────────────────────────────────────────────────
  const bullish = news.filter((n) => n.sentiment === "bullish").length;
  const bearish = news.filter((n) => n.sentiment === "bearish").length;
  const sentimentBias = bullish > bearish ? "BULLISH" : bearish > bullish ? "BEARISH" : "NEUTRAL";
  const sentimentColor = sentimentBias === "BULLISH" ? "text-profit" : sentimentBias === "BEARISH" ? "text-loss" : "text-muted-foreground";

  const lastCycle = cycleLogs[0];
  const equity = portfolioSummary?.totalEquity;
  const pnl = portfolioSummary?.totalUnrealizedPnL ?? 0;
  const pnlColor = pnl >= 0 ? "text-profit" : "text-loss";

  return (
    <div className="min-h-screen bg-background">

      {/* ═══ STATUS RIBBON ═══════════════════════════════════════════════════ */}
      <div className="bg-card border-b border-border text-xs">
        <div className="max-w-[1600px] mx-auto px-4 h-8 flex items-center justify-between gap-4">
          <div className="flex items-center gap-5 font-mono">
            <div className="flex items-center gap-1.5">
              <span className={`h-2 w-2 rounded-full ${agentStatus?.isPaused ? "bg-amber-400" : "bg-emerald-500 animate-pulse"}`} />
              <span className="text-muted-foreground">AGENT</span>
              <span className={agentStatus?.isPaused ? "text-amber-500 font-semibold" : "text-emerald-600 font-semibold"}>
                {agentStatus?.isPaused ? "PAUSED" : "LIVE"}
              </span>
            </div>
            <span className="text-border">|</span>
            <span className="text-muted-foreground">CYCLE <span className="text-foreground">#{agentStatus?.cycleCount ?? 0}</span></span>
            <span className="hidden sm:inline text-border">|</span>
            <span className="hidden sm:inline text-muted-foreground">TRADES TODAY <span className="text-foreground">{agentStatus?.tradesToday ?? 0}</span></span>
            <span className="hidden md:inline text-border">|</span>
            <span className={`hidden md:inline font-semibold ${sentimentColor}`}>
              MARKET: {sentimentBias}
            </span>
          </div>
          <div className="flex items-center gap-4 font-mono text-muted-foreground">
            {equity != null && (
              <>
                <span>EQUITY <span className="text-foreground font-semibold">{fmtUSD(equity)}</span></span>
                <span className={`hidden sm:inline ${pnlColor}`}>
                  {pnl >= 0 ? "▲" : "▼"} {fmtUSD(Math.abs(pnl))} P&L
                </span>
                <span className="hidden md:inline text-border">|</span>
              </>
            )}
            <span>{new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })} EST</span>
          </div>
        </div>
      </div>

      {/* ═══ HEADER ══════════════════════════════════════════════════════════ */}
      <header className="bg-card border-b border-border sticky top-0 z-30">
        <div className="max-w-[1600px] mx-auto px-4 h-14 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="h-8 w-8 rounded-lg bg-primary flex items-center justify-center">
              <BarChart3 className="h-4 w-4 text-primary-foreground" />
            </div>
            <div>
              <span className="text-sm font-bold text-foreground">Trading Agent</span>
              <span className="hidden sm:inline text-xs text-muted-foreground ml-2">Pro Terminal</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" className="text-xs h-8 gap-1.5" onClick={() => syncRss.mutate()} disabled={syncRss.isPending}>
              {syncRss.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              <span className="hidden sm:inline">Sync</span>
            </Button>
            <Button size="sm" variant="outline" className="text-xs h-8 gap-1.5" onClick={() => analyzeNews.mutate()} disabled={analyzeNews.isPending}>
              {analyzeNews.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Eye className="h-3 w-3" />}
              Analyze
            </Button>
            <Button size="sm" className="text-xs h-8 gap-1.5" onClick={() => generatePredictions.mutate()} disabled={generatePredictions.isPending}>
              {generatePredictions.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
              Generate
            </Button>
            <div className="relative ml-1">
              <Bell className="h-4 w-4 text-muted-foreground cursor-pointer hover:text-foreground transition-colors" />
              {alerts.length > 0 && (
                <span className="absolute -top-1.5 -right-1.5 h-3.5 min-w-3.5 px-0.5 bg-destructive rounded-full text-[9px] text-white flex items-center justify-center font-mono">
                  {alerts.length}
                </span>
              )}
            </div>
            <div className="h-7 w-7 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center text-xs font-semibold text-primary cursor-pointer ml-1" onClick={logout}>
              {user?.name?.charAt(0).toUpperCase() ?? "U"}
            </div>
          </div>
        </div>
      </header>

      {/* ═══ COMMAND CENTER — 3-COLUMN GRID ══════════════════════════════════ */}
      <div className="max-w-[1600px] mx-auto px-4 py-4">
        <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr_280px] gap-4 mb-4">

          {/* ── LEFT: Watchlist + Live Prices ──────────────────────────────── */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Watchlist</h2>
              <Badge variant="outline" className="text-[10px] font-mono">{watchlist.length} stocks</Badge>
            </div>
            <div className="rounded-xl border border-border bg-card overflow-hidden">
              {watchlist.length === 0 ? (
                <div className="py-10 text-center text-sm text-muted-foreground">
                  <Target className="h-6 w-6 mx-auto mb-2 opacity-30" />
                  No stocks tracked yet
                </div>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border bg-secondary/40">
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground">Ticker</th>
                      <th className="text-right px-3 py-2 font-medium text-muted-foreground">Price</th>
                      <th className="text-right px-3 py-2 font-medium text-muted-foreground">Chg%</th>
                      <th className="text-right px-3 py-2 font-medium text-muted-foreground">RSI</th>
                    </tr>
                  </thead>
                  <tbody>
                    {watchlist.map((stock) => {
                      const quote = stockQuotes?.[stock.ticker];
                      const tech = technicals?.[stock.ticker];
                      const rsi = rsiLabel(tech?.rsi);
                      const chg = quote?.changePercent ?? null;
                      const isUp = (chg ?? 0) >= 0;
                      return (
                        <tr key={stock.id} className="border-b border-border/40 last:border-0 hover:bg-secondary/20 transition-colors">
                          <td className="px-3 py-2.5">
                            <div className="flex items-center gap-1.5">
                              {stock.isPriority === 1 && <span className="w-1 h-1 rounded-full bg-primary" />}
                              <span className="font-mono font-bold text-foreground">{stock.ticker}</span>
                            </div>
                            {stock.name && <div className="text-[10px] text-muted-foreground truncate max-w-[90px]">{stock.name}</div>}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono text-foreground">
                            {quote?.price != null ? `$${fmt(quote.price)}` : "—"}
                          </td>
                          <td className={`px-3 py-2.5 text-right font-mono font-semibold ${chg == null ? "text-muted-foreground" : isUp ? "text-profit" : "text-loss"}`}>
                            {chg != null ? (
                              <span className="flex items-center justify-end gap-0.5">
                                {isUp ? <ChevronUp className="h-2.5 w-2.5" /> : <ChevronDown className="h-2.5 w-2.5" />}
                                {fmtPct(chg)}
                              </span>
                            ) : "—"}
                          </td>
                          <td className={`px-3 py-2.5 text-right font-mono font-semibold ${rsi.color}`}>
                            {rsi.label}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {/* ── Agent Control ─────────────────────────────────────────── */}
            <div className="rounded-xl border border-border bg-card p-3 space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-2">Agent Control</h3>
              <div className="grid grid-cols-3 gap-2">
                <Button
                  size="sm"
                  variant={agentStatus?.isPaused ? "default" : "outline"}
                  className="text-xs h-8 gap-1"
                  onClick={() => agentStatus?.isPaused ? resumeAgent.mutate() : pauseAgent.mutate()}
                  disabled={pauseAgent.isPending || resumeAgent.isPending}
                >
                  {agentStatus?.isPaused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
                  {agentStatus?.isPaused ? "Resume" : "Pause"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="text-xs h-8 gap-1"
                  onClick={() => runNow.mutate()}
                  disabled={runNow.isPending}
                >
                  {runNow.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                  Run Now
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-xs h-8 gap-1 text-destructive hover:text-destructive"
                  onClick={() => logout()}
                >
                  <LogOut className="h-3 w-3" />
                  Logout
                </Button>
              </div>
            </div>
          </div>

          {/* ── CENTER: Predictions + Scorecard ────────────────────────────── */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Active Signals</h2>
              <div className="flex items-center gap-2">
                {scorecard && scorecard.evaluated > 0 && (
                  <div className="flex items-center gap-1.5 text-xs font-mono">
                    <span className="text-muted-foreground">Hit Rate</span>
                    <span className={`font-bold ${scorecard.hitRate >= 55 ? "text-profit" : "text-loss"}`}>{scorecard.hitRate.toFixed(0)}%</span>
                    <span className="text-muted-foreground">({scorecard.evaluated} eval'd)</span>
                  </div>
                )}
              </div>
            </div>

            {/* Scorecard row */}
            {scorecard && scorecard.evaluated > 0 && (
              <div className="grid grid-cols-4 gap-2">
                {[
                  { label: "Total", val: scorecard.totalPredictions, color: "text-foreground" },
                  { label: "Correct", val: scorecard.correct, color: "text-profit" },
                  { label: "Wrong", val: scorecard.incorrect, color: "text-loss" },
                  { label: "Pending", val: scorecard.pending, color: "text-muted-foreground" },
                ].map(({ label, val, color }) => (
                  <div key={label} className="rounded-lg border border-border bg-card p-2.5 text-center">
                    <div className={`text-lg font-mono font-bold ${color}`}>{val}</div>
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</div>
                  </div>
                ))}
              </div>
            )}

            {/* Predictions grid */}
            {predictions.length === 0 ? (
              <div className="rounded-xl border border-border bg-card py-12 text-center text-sm text-muted-foreground">
                <Sparkles className="h-6 w-6 mx-auto mb-2 opacity-30" />
                No predictions yet — click Generate
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                {predictions.slice(0, 6).map((pred: any) => {
                  const conf = pred.predictionConfidence ?? 0;
                  const isCall = (pred.opportunityType ?? "call") === "call" || (pred.direction ?? "up") === "up";
                  const signals = (() => { try { return JSON.parse(pred.earlySignals ?? "[]"); } catch { return []; } })();
                  const stocks = (() => { try { return JSON.parse(pred.keyStocks ?? "[]"); } catch { return []; } })();
                  return (
                    <div key={pred.id} className={`rounded-xl border ${isCall ? "border-emerald-200 bg-emerald-50/40" : "border-red-200 bg-red-50/40"} p-3 relative overflow-hidden`}>
                      <div className={`absolute top-0 left-0 right-0 h-0.5 ${isCall ? "bg-emerald-500" : "bg-red-500"}`} style={{ width: `${conf}%` }} />
                      <div className="flex items-start justify-between mb-1.5 mt-0.5">
                        <Badge className={`text-[10px] font-mono px-1.5 py-0 border-0 ${isCall ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}>
                          {isCall ? "▲ CALL" : "▼ PUT"}
                        </Badge>
                        <span className={`text-xl font-mono font-bold ${isCall ? "text-emerald-600" : "text-red-600"}`}>{conf}%</span>
                      </div>
                      <div className="text-xs font-semibold text-foreground mb-1 line-clamp-1">{pred.sector}</div>
                      <p className="text-[10px] text-muted-foreground line-clamp-2 mb-2">{pred.description}</p>
                      {stocks.slice(0, 3).length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {stocks.slice(0, 3).map((s: string) => (
                            <span key={s} className="text-[10px] font-mono bg-secondary rounded px-1.5 py-0.5 text-foreground">{s}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Sector Momentum row */}
            {sectorMomentum.length > 0 && (
              <div className="rounded-xl border border-border bg-card p-3">
                <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-2">Sector Momentum</h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                  {sectorMomentum.slice(0, 8).map((s: any) => {
                    const bull = s.bullishCount ?? 0;
                    const bear = s.bearishCount ?? 0;
                    const total = bull + bear;
                    const bullPct = total > 0 ? (bull / total) * 100 : 50;
                    const isBull = bullPct >= 50;
                    return (
                      <div key={s.sector ?? s.id} className="rounded-lg bg-secondary/40 border border-border/40 p-2">
                        <div className="text-[10px] text-muted-foreground truncate mb-1">{s.sector}</div>
                        <div className={`text-xs font-mono font-bold ${isBull ? "text-profit" : "text-loss"}`}>
                          {isBull ? "▲" : "▼"} {bullPct.toFixed(0)}%
                        </div>
                        <div className="h-1 bg-secondary rounded mt-1 overflow-hidden">
                          <div className={`h-full ${isBull ? "bg-emerald-500" : "bg-red-500"}`} style={{ width: `${bullPct}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* ── RIGHT: Agent Brain + Reddit ────────────────────────────────── */}
          <div className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Agent Intelligence</h2>

            {/* Last cycle summary */}
            <div className="rounded-xl border border-border bg-card p-3">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                  <Bot className="h-3.5 w-3.5 text-primary" /> Last Cycle
                </h3>
                {lastCycle && <span className="text-[10px] text-muted-foreground font-mono">{timeAgo(lastCycle.createdAt)}</span>}
              </div>
              {lastCycle ? (
                <div className="space-y-2">
                  <div className="grid grid-cols-3 gap-1.5 text-center">
                    {[
                      { label: "Trades", val: lastCycle.tradesExecuted },
                      { label: "Closed", val: lastCycle.positionsClosed },
                      { label: "Cycle", val: `#${lastCycle.cycleNumber}` },
                    ].map(({ label, val }) => (
                      <div key={label} className="bg-secondary/40 rounded-lg py-2">
                        <div className="text-sm font-mono font-bold text-foreground">{val}</div>
                        <div className="text-[9px] text-muted-foreground uppercase">{label}</div>
                      </div>
                    ))}
                  </div>
                  {lastCycle.portfolioEquity && (
                    <div className="flex items-center justify-between text-xs border-t border-border pt-2">
                      <span className="text-muted-foreground">Equity snapshot</span>
                      <span className="font-mono font-semibold text-foreground">${parseFloat(lastCycle.portfolioEquity).toLocaleString("en-US", { maximumFractionDigits: 0 })}</span>
                    </div>
                  )}
                  {lastCycle.reflection && (
                    <div className="text-[10px] text-muted-foreground bg-secondary/30 rounded-lg p-2 leading-relaxed line-clamp-4">
                      {lastCycle.reflection}
                    </div>
                  )}
                  {lastCycle.riskWarnings && (
                    <div className="flex items-start gap-1.5 text-[10px] text-amber-600 bg-amber-50 border border-amber-100 rounded-lg p-2">
                      <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
                      <span className="line-clamp-2">{lastCycle.riskWarnings}</span>
                    </div>
                  )}
                </div>
              ) : (
                <div className="py-4 text-center text-xs text-muted-foreground">No cycle logs yet</div>
              )}
            </div>

            {/* Reddit hot stocks */}
            {redditSentiment && (redditSentiment as any)?.tickers?.length > 0 && (
              <div className="rounded-xl border border-border bg-card p-3">
                <h3 className="text-xs font-semibold text-foreground flex items-center gap-1.5 mb-2">
                  <Radio className="h-3.5 w-3.5 text-orange-500" /> Reddit Trending
                </h3>
                <div className="space-y-1.5">
                  {((redditSentiment as any).tickers ?? []).slice(0, 5).map((t: any) => {
                    const isBull = t.sentiment === "bullish";
                    const isNeutral = t.sentiment === "neutral";
                    return (
                      <div key={t.ticker} className="flex items-center justify-between text-xs">
                        <span className="font-mono font-bold text-foreground">{t.ticker}</span>
                        <div className="flex items-center gap-2">
                          {t.mentions && <span className="text-muted-foreground">{t.mentions} mentions</span>}
                          <Badge className={`text-[9px] font-mono px-1.5 py-0 border-0 ${isBull ? "bg-emerald-100 text-emerald-700" : isNeutral ? "bg-secondary text-muted-foreground" : "bg-red-100 text-red-700"}`}>
                            {t.sentiment?.toUpperCase() ?? "—"}
                          </Badge>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Alerts */}
            {alerts.length > 0 && (
              <div className="rounded-xl border border-amber-200 bg-amber-50/50 p-3">
                <h3 className="text-xs font-semibold text-amber-700 flex items-center gap-1.5 mb-2">
                  <Bell className="h-3.5 w-3.5" /> {alerts.length} Unread Alert{alerts.length !== 1 ? "s" : ""}
                </h3>
                <div className="space-y-1.5">
                  {alerts.slice(0, 3).map((a) => (
                    <div key={a.id} className="text-[10px] text-amber-800 bg-white/60 rounded-lg px-2.5 py-1.5 leading-snug">
                      <span className="font-semibold">{a.title}</span>
                      {a.message && <div className="text-amber-600 mt-0.5 line-clamp-1">{a.message}</div>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ═══ DETAILED TABS ══════════════════════════════════════════════════ */}
        <Tabs defaultValue="portfolio" className="space-y-4">
          <TabsList className="bg-card border border-border p-1 flex flex-wrap gap-0.5 h-auto">
            {[
              { value: "portfolio", label: "Portfolio", icon: Briefcase },
              { value: "news", label: "News", icon: BookOpen },
              { value: "signals", label: "Signals", icon: Activity },
              { value: "insider", label: "Insider", icon: Eye },
              { value: "agent", label: "Agent Brain", icon: Bot },
              { value: "predictions", label: "Predictions", icon: Sparkles },
              { value: "risk", label: "Risk", icon: Shield },
            ].map(({ value, label, icon: Icon }) => (
              <TabsTrigger key={value} value={value} className="text-xs h-8 gap-1.5 data-[state=active]:bg-primary/10 data-[state=active]:text-primary">
                <Icon className="h-3 w-3" />{label}
              </TabsTrigger>
            ))}
          </TabsList>

          {/* ── Portfolio Tab ───────────────────────────────────────────────── */}
          <TabsContent value="portfolio" className="space-y-4">
            {/* Summary row */}
            {portfolioSummary ? (
              <>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  {[
                    { label: "Total Equity", val: fmtUSD(portfolioSummary.totalEquity), sub: portfolios[0]?.name, color: "text-foreground" },
                    { label: "Cash", val: fmtUSD(portfolioSummary.cashBalance), sub: `${((portfolioSummary.cashBalance / portfolioSummary.totalEquity) * 100).toFixed(1)}% of equity`, color: "text-foreground" },
                    { label: "Unrealized P&L", val: fmtUSD(portfolioSummary.totalUnrealizedPnL), sub: portfolioSummary.totalUnrealizedPnL >= 0 ? "Gain" : "Loss", color: portfolioSummary.totalUnrealizedPnL >= 0 ? "text-profit" : "text-loss" },
                    { label: "Open Positions", val: portfolioSummary.positions.length, sub: "Paper trading", color: "text-foreground" },
                  ].map(({ label, val, sub, color }) => (
                    <Card key={label} className="border-border">
                      <CardContent className="pt-4 pb-3">
                        <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">{label}</div>
                        <div className={`text-xl font-mono font-bold ${color}`}>{val}</div>
                        <div className="text-[10px] text-muted-foreground mt-0.5">{sub}</div>
                      </CardContent>
                    </Card>
                  ))}
                </div>

                {/* Positions table */}
                <Card className="border-border">
                  <CardHeader className="pb-2 pt-4">
                    <CardTitle className="text-sm">Open Positions</CardTitle>
                  </CardHeader>
                  <CardContent className="pb-0">
                    {portfolioSummary.positions.length === 0 ? (
                      <div className="py-8 text-center text-sm text-muted-foreground">No open positions</div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-border">
                              {["Symbol", "Qty", "Entry", "Current", "Mkt Value", "P&L", "P&L%", "SL", "TP"].map(h => (
                                <th key={h} className="text-left px-3 py-2 font-medium text-muted-foreground last:text-right">{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {portfolioSummary.positions.map((pos: any) => {
                              const pnlPct = pos.unrealizedPnLPercent;
                              const isProfitable = (pos.unrealizedPnL ?? 0) >= 0;
                              return (
                                <tr key={pos.id} className="border-b border-border/40 last:border-0 hover:bg-secondary/20">
                                  <td className="px-3 py-2.5 font-mono font-bold">{pos.symbol}</td>
                                  <td className="px-3 py-2.5 font-mono">{pos.quantity}</td>
                                  <td className="px-3 py-2.5 font-mono">${fmt(pos.avgEntryPrice)}</td>
                                  <td className="px-3 py-2.5 font-mono">{pos.currentPrice != null ? `$${fmt(pos.currentPrice)}` : "—"}</td>
                                  <td className="px-3 py-2.5 font-mono">{pos.marketValue != null ? fmtUSD(pos.marketValue) : "—"}</td>
                                  <td className={`px-3 py-2.5 font-mono font-semibold ${isProfitable ? "text-profit" : "text-loss"}`}>
                                    {pos.unrealizedPnL != null ? (isProfitable ? "+" : "") + fmtUSD(pos.unrealizedPnL) : "—"}
                                  </td>
                                  <td className={`px-3 py-2.5 font-mono font-semibold ${isProfitable ? "text-profit" : "text-loss"}`}>
                                    {pnlPct != null ? fmtPct(pnlPct) : "—"}
                                  </td>
                                  <td className="px-3 py-2.5 font-mono text-muted-foreground">{pos.stopLoss ? `$${fmt(pos.stopLoss)}` : "—"}</td>
                                  <td className="px-3 py-2.5 font-mono text-muted-foreground text-right">{pos.takeProfit ? `$${fmt(pos.takeProfit)}` : "—"}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Trade history */}
                <Card className="border-border">
                  <CardHeader className="pb-2 pt-4">
                    <CardTitle className="text-sm">Trade History</CardTitle>
                  </CardHeader>
                  <CardContent className="pb-0">
                    {tradeHistory.length === 0 ? (
                      <div className="py-8 text-center text-sm text-muted-foreground">No trades yet</div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-border">
                              {["Symbol", "Side", "Qty", "Price", "Total", "Type", "Date"].map(h => (
                                <th key={h} className="text-left px-3 py-2 font-medium text-muted-foreground">{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {tradeHistory.map((t: any) => (
                              <tr key={t.id} className="border-b border-border/40 last:border-0 hover:bg-secondary/20">
                                <td className="px-3 py-2.5 font-mono font-bold">{t.symbol}</td>
                                <td className={`px-3 py-2.5 font-mono font-semibold ${t.side === "buy" ? "text-profit" : "text-loss"}`}>{t.side.toUpperCase()}</td>
                                <td className="px-3 py-2.5 font-mono">{t.quantity}</td>
                                <td className="px-3 py-2.5 font-mono">${fmt(parseFloat(t.price))}</td>
                                <td className="px-3 py-2.5 font-mono">{fmtUSD(parseFloat(t.total))}</td>
                                <td className="px-3 py-2.5 text-muted-foreground uppercase text-[10px]">{t.orderType}</td>
                                <td className="px-3 py-2.5 font-mono text-muted-foreground">{new Date(t.executedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </>
            ) : (
              <Card className="border-border">
                <CardContent className="py-12 text-center space-y-4">
                  <Briefcase className="h-10 w-10 mx-auto opacity-25" />
                  <div>
                    <p className="font-semibold text-foreground mb-1">No portfolio yet</p>
                    <p className="text-sm text-muted-foreground">Create a paper trading portfolio to start tracking the agent's performance.</p>
                  </div>
                  <Button
                    onClick={() => createPortfolio.mutate({ name: "Agent Portfolio", initialCash: 100_000 })}
                    disabled={createPortfolio.isPending}
                    className="h-9 px-6"
                  >
                    {createPortfolio.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                    Create Portfolio ($100,000)
                  </Button>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* ── News Tab ────────────────────────────────────────────────────── */}
          <TabsContent value="news">
            <Card className="border-border">
              <CardHeader className="pb-2 pt-4">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm">Market Intelligence Feed</CardTitle>
                  <div className="flex items-center gap-2 text-xs font-mono">
                    <span className="text-profit">{bullish} bull</span>
                    <span className="text-muted-foreground">/</span>
                    <span className="text-loss">{bearish} bear</span>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pb-0">
                {newsLoading ? (
                  <div className="py-12 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
                ) : news.length === 0 ? (
                  <div className="py-12 text-center text-sm text-muted-foreground">No articles yet — click Analyze to sync</div>
                ) : (
                  <div className="divide-y divide-border/40">
                    {news.map((a) => (
                      <div key={a.id} className="py-3 flex gap-3 hover:bg-secondary/20 px-1 rounded transition-colors">
                        <div className={`w-0.5 shrink-0 self-stretch rounded-full mt-0.5 ${a.sentiment === "bullish" ? "bg-profit" : a.sentiment === "bearish" ? "bg-loss" : "bg-border"}`} />
                        <div className="min-w-0 flex-1">
                          <a href={a.url ?? "#"} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-foreground hover:text-primary transition-colors line-clamp-1">
                            {a.title}
                          </a>
                          {a.aiSummary && <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{a.aiSummary}</p>}
                          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                            <span className="text-[10px] font-mono uppercase text-muted-foreground">{a.source}</span>
                            {a.sentiment && (
                              <Badge className={`text-[9px] font-mono px-1.5 py-0 border-0 ${a.sentiment === "bullish" ? "bg-emerald-100 text-emerald-700" : a.sentiment === "bearish" ? "bg-red-100 text-red-700" : "bg-secondary text-muted-foreground"}`}>
                                {a.sentiment.toUpperCase()}
                              </Badge>
                            )}
                            {a.mentionedStocks && (() => { try { return JSON.parse(a.mentionedStocks).slice(0, 3); } catch { return []; } })().map((s: string) => (
                              <span key={s} className="text-[9px] font-mono bg-secondary rounded px-1.5 py-0.5 text-foreground">{s}</span>
                            ))}
                            <span className="text-[10px] font-mono text-muted-foreground/60 ml-auto">{timeAgo(a.publishedAt)}</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── Signals / Technicals Tab ────────────────────────────────────── */}
          <TabsContent value="signals">
            <Card className="border-border">
              <CardHeader className="pb-2 pt-4">
                <CardTitle className="text-sm">Technical Indicators — Watchlist</CardTitle>
              </CardHeader>
              <CardContent className="pb-0">
                {watchlist.length === 0 ? (
                  <div className="py-12 text-center text-sm text-muted-foreground">Add stocks to your watchlist to see technical indicators</div>
                ) : !technicals ? (
                  <div className="py-12 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border">
                          {["Symbol", "Price", "RSI(14)", "MACD", "Signal", "SMA20", "SMA50", "SMA200", "BB Upper", "BB Lower", "Trend"].map(h => (
                            <th key={h} className="text-left px-3 py-2 font-medium text-muted-foreground whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {watchlist.map((stock) => {
                          const t = technicals?.[stock.ticker];
                          const quote = stockQuotes?.[stock.ticker];
                          const rsi = t?.rsi;
                          const rsiInfo = rsiLabel(rsi);
                          const price = quote?.price;
                          const sma50 = t?.sma50;
                          const sma200 = t?.sma200;
                          const trend = price != null && sma50 != null
                            ? price > sma50 ? "ABOVE SMA50" : "BELOW SMA50"
                            : "—";
                          const trendColor = trend === "ABOVE SMA50" ? "text-profit" : trend === "BELOW SMA50" ? "text-loss" : "text-muted-foreground";
                          return (
                            <tr key={stock.ticker} className="border-b border-border/40 last:border-0 hover:bg-secondary/20">
                              <td className="px-3 py-2.5 font-mono font-bold">{stock.ticker}</td>
                              <td className="px-3 py-2.5 font-mono">{price != null ? `$${fmt(price)}` : "—"}</td>
                              <td className={`px-3 py-2.5 font-mono font-semibold ${rsiInfo.color}`}>{rsiInfo.label}</td>
                              <td className="px-3 py-2.5 font-mono">{t?.macd != null ? fmt(t.macd) : "—"}</td>
                              <td className="px-3 py-2.5 font-mono">{t?.macdSignal != null ? fmt(t.macdSignal) : "—"}</td>
                              <td className="px-3 py-2.5 font-mono text-muted-foreground">{t?.sma20 != null ? `$${fmt(t.sma20)}` : "—"}</td>
                              <td className="px-3 py-2.5 font-mono text-muted-foreground">{sma50 != null ? `$${fmt(sma50)}` : "—"}</td>
                              <td className="px-3 py-2.5 font-mono text-muted-foreground">{sma200 != null ? `$${fmt(sma200)}` : "—"}</td>
                              <td className="px-3 py-2.5 font-mono text-muted-foreground">{t?.bollingerUpper != null ? `$${fmt(t.bollingerUpper)}` : "—"}</td>
                              <td className="px-3 py-2.5 font-mono text-muted-foreground">{t?.bollingerLower != null ? `$${fmt(t.bollingerLower)}` : "—"}</td>
                              <td className={`px-3 py-2.5 font-mono text-[10px] font-semibold ${trendColor}`}>{trend}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── Insider Tab ─────────────────────────────────────────────────── */}
          <TabsContent value="insider" className="space-y-4">
            <Card className="border-border">
              <CardHeader className="pb-3 pt-4">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm">SEC Form 4 — Insider Transactions</CardTitle>
                  <div className="flex items-center gap-2">
                    {["NVDA", "AAPL", "TSLA", "MSFT", "META", "AMZN"].map((t) => (
                      <button
                        key={t}
                        onClick={() => setInsiderTicker(t)}
                        className={`text-[10px] font-mono px-2 py-1 rounded border transition-colors ${insiderTicker === t ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:border-primary/50"}`}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pb-0">
                {insiderData.length === 0 ? (
                  <div className="py-12 text-center text-sm text-muted-foreground">
                    <Eye className="h-6 w-6 mx-auto mb-2 opacity-30" />
                    No insider transactions found for {insiderTicker}
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border">
                          {["Insider", "Role", "Type", "Shares", "Price", "Value", "Date"].map(h => (
                            <th key={h} className="text-left px-3 py-2 font-medium text-muted-foreground">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {insiderData.map((tx: any, i: number) => {
                          const isBuy = (tx.transactionType ?? "").toLowerCase().includes("purchase") || (tx.transactionType ?? "").toLowerCase().includes("buy");
                          const isSell = (tx.transactionType ?? "").toLowerCase().includes("sale") || (tx.transactionType ?? "").toLowerCase().includes("sell");
                          return (
                            <tr key={i} className="border-b border-border/40 last:border-0 hover:bg-secondary/20">
                              <td className="px-3 py-2.5 font-semibold text-foreground">{tx.ownerName ?? "—"}</td>
                              <td className="px-3 py-2.5 text-muted-foreground text-[10px]">{tx.relationship ?? tx.role ?? "—"}</td>
                              <td className={`px-3 py-2.5 font-mono font-semibold ${isBuy ? "text-profit" : isSell ? "text-loss" : "text-muted-foreground"}`}>
                                {isBuy ? "▲ BUY" : isSell ? "▼ SELL" : tx.transactionType ?? "—"}
                              </td>
                              <td className="px-3 py-2.5 font-mono">{tx.shares != null ? Number(tx.shares).toLocaleString() : "—"}</td>
                              <td className="px-3 py-2.5 font-mono">{tx.pricePerShare != null ? `$${fmt(tx.pricePerShare)}` : "—"}</td>
                              <td className="px-3 py-2.5 font-mono">{tx.totalValue != null ? fmtUSD(tx.totalValue) : "—"}</td>
                              <td className="px-3 py-2.5 font-mono text-muted-foreground">{tx.date ? new Date(tx.date).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── Agent Brain Tab ─────────────────────────────────────────────── */}
          <TabsContent value="agent" className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-2">
              {[
                { label: "Total Cycles", val: agentStatus?.cycleCount ?? 0 },
                { label: "Trades Today", val: agentStatus?.tradesToday ?? 0 },
                { label: "Status", val: agentStatus?.isPaused ? "PAUSED" : "ACTIVE", color: agentStatus?.isPaused ? "text-amber-600" : "text-profit" },
              ].map(({ label, val, color }) => (
                <Card key={label} className="border-border">
                  <CardContent className="pt-4 pb-3 text-center">
                    <div className={`text-2xl font-mono font-bold ${color ?? "text-foreground"}`}>{val}</div>
                    <div className="text-[10px] uppercase tracking-widest text-muted-foreground mt-1">{label}</div>
                  </CardContent>
                </Card>
              ))}
            </div>

            <Card className="border-border">
              <CardHeader className="pb-2 pt-4">
                <CardTitle className="text-sm">Cycle Logs</CardTitle>
              </CardHeader>
              <CardContent className="pb-4">
                {cycleLogs.length === 0 ? (
                  <div className="py-8 text-center text-sm text-muted-foreground">No cycles run yet. Click "Run Now" to trigger one.</div>
                ) : (
                  <div className="space-y-3">
                    {cycleLogs.map((log) => {
                      let summary: any = null;
                      try { summary = log.summary ? JSON.parse(log.summary) : null; } catch { }
                      return (
                        <div key={log.id} className="rounded-xl border border-border bg-secondary/20 p-4">
                          <div className="flex items-center justify-between mb-3">
                            <div className="flex items-center gap-2">
                              <Bot className="h-4 w-4 text-primary" />
                              <span className="text-sm font-semibold">Cycle #{log.cycleNumber}</span>
                            </div>
                            <div className="flex items-center gap-3 text-xs font-mono text-muted-foreground">
                              {log.portfolioEquity && <span>Equity: ${parseFloat(log.portfolioEquity).toLocaleString("en-US", { maximumFractionDigits: 0 })}</span>}
                              <span>{timeAgo(log.createdAt)}</span>
                            </div>
                          </div>
                          <div className="grid grid-cols-3 gap-2 mb-3">
                            {[
                              { label: "Predictions", val: typeof log.predictionsGenerated === "number" ? log.predictionsGenerated : 0, color: "text-primary" },
                              { label: "Trades", val: typeof log.tradesExecuted === "number" ? log.tradesExecuted : 0, color: "text-profit" },
                              { label: "Closed", val: typeof log.positionsClosed === "number" ? log.positionsClosed : Array.isArray(log.positionsClosed) ? (log.positionsClosed as any[]).length : 0, color: "text-muted-foreground" },
                            ].map(({ label, val, color }) => (
                              <div key={label} className="text-center bg-card rounded-lg py-2 border border-border/40">
                                <div className={`text-lg font-mono font-bold ${color}`}>{val}</div>
                                <div className="text-[9px] uppercase text-muted-foreground">{label}</div>
                              </div>
                            ))}
                          </div>
                          {log.reflection && (
                            <div className="text-xs text-muted-foreground bg-card border border-border/40 rounded-lg p-3 leading-relaxed mb-2">
                              <span className="text-[10px] uppercase tracking-widest text-primary font-semibold block mb-1">Agent Reflection</span>
                              {log.reflection}
                            </div>
                          )}
                          {summary?.decision && (
                            <div className="text-xs text-foreground bg-card border border-border/40 rounded-lg p-3">
                              <span className="text-[10px] uppercase tracking-widest text-primary font-semibold block mb-1">Decision Rationale</span>
                              {typeof summary.decision === "string" ? summary.decision : JSON.stringify(summary.decision, null, 2)}
                            </div>
                          )}
                          {log.riskWarnings && (
                            <div className="flex items-start gap-2 mt-2 text-xs text-amber-600 bg-amber-50 border border-amber-100 rounded-lg p-2.5">
                              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                              <span>{log.riskWarnings}</span>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── Predictions Tab ─────────────────────────────────────────────── */}
          <TabsContent value="predictions" className="space-y-4">
            {scorecard && (
              <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
                {[
                  { label: "Total", val: scorecard.totalPredictions },
                  { label: "Evaluated", val: scorecard.evaluated },
                  { label: "Correct", val: scorecard.correct, color: "text-profit" },
                  { label: "Wrong", val: scorecard.incorrect, color: "text-loss" },
                  { label: "Hit Rate", val: `${scorecard.hitRate.toFixed(0)}%`, color: scorecard.hitRate >= 55 ? "text-profit" : "text-loss" },
                  { label: "Pending", val: scorecard.pending },
                ].map(({ label, val, color }) => (
                  <Card key={label} className="border-border">
                    <CardContent className="pt-3 pb-2 text-center">
                      <div className={`text-xl font-mono font-bold ${color ?? "text-foreground"}`}>{val}</div>
                      <div className="text-[9px] uppercase tracking-widest text-muted-foreground mt-0.5">{label}</div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {predictions.length === 0 ? (
                <div className="col-span-3 py-16 text-center text-sm text-muted-foreground">
                  <Sparkles className="h-8 w-8 mx-auto mb-3 opacity-30" />
                  No predictions yet — click Generate
                </div>
              ) : predictions.map((pred: any) => {
                const conf = pred.predictionConfidence ?? 0;
                const isCall = (pred.opportunityType ?? "call") === "call" || (pred.direction ?? "up") === "up";
                const signals = (() => { try { return JSON.parse(pred.earlySignals ?? "[]"); } catch { return []; } })();
                const stocks = (() => { try { return JSON.parse(pred.keyStocks ?? "[]"); } catch { return []; } })();
                return (
                  <div key={pred.id} className={`rounded-xl border p-4 relative overflow-hidden ${isCall ? "border-emerald-200 bg-emerald-50/30" : "border-red-200 bg-red-50/30"}`}>
                    <div className={`absolute top-0 left-0 right-0 h-0.5 ${isCall ? "bg-emerald-500" : "bg-red-500"}`} style={{ width: `${conf}%` }} />
                    <div className="flex items-start justify-between mb-2 mt-0.5">
                      <div className="space-y-1">
                        <Badge className={`text-[10px] font-mono px-2 py-0 border-0 ${isCall ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}>
                          {isCall ? "▲ CALL" : "▼ PUT"}
                        </Badge>
                        <div className="text-xs font-semibold text-foreground">{pred.sector}</div>
                      </div>
                      <div className={`text-2xl font-mono font-bold ${isCall ? "text-emerald-600" : "text-red-600"}`}>{conf}%</div>
                    </div>
                    <p className="text-xs text-muted-foreground mb-3 line-clamp-3">{pred.description}</p>
                    {signals.length > 0 && (
                      <div className="mb-2">
                        <div className="text-[9px] uppercase tracking-widest text-muted-foreground mb-1">Signals</div>
                        <div className="flex flex-wrap gap-1">
                          {signals.slice(0, 3).map((s: string, i: number) => (
                            <span key={i} className="text-[10px] bg-secondary rounded px-1.5 py-0.5 text-muted-foreground">{s}</span>
                          ))}
                        </div>
                      </div>
                    )}
                    {stocks.length > 0 && (
                      <div>
                        <div className="text-[9px] uppercase tracking-widest text-muted-foreground mb-1">Key Stocks</div>
                        <div className="flex flex-wrap gap-1">
                          {stocks.slice(0, 5).map((s: string) => (
                            <span key={s} className="text-[10px] font-mono font-semibold bg-card border border-border rounded px-1.5 py-0.5">{s}</span>
                          ))}
                        </div>
                      </div>
                    )}
                    <div className="flex items-center gap-2 mt-3 pt-3 border-t border-border/40 text-[10px] text-muted-foreground font-mono">
                      {pred.timeframe && <span>{pred.timeframe}</span>}
                      <span className="ml-auto">{new Date(pred.startDate ?? pred.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </TabsContent>


          {/* ── Risk Tab ────────────────────────────────────────────────────── */}
          <TabsContent value="risk" className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Risk limits */}
              <Card className="border-border">
                <CardHeader className="pb-2 pt-4">
                  <CardTitle className="text-sm">Risk Parameters</CardTitle>
                </CardHeader>
                <CardContent>
                  {!riskSettings ? (
                    <div className="py-8 text-center text-sm text-muted-foreground">Loading risk settings…</div>
                  ) : (
                    <div className="space-y-3">
                      {[
                        { label: "Max Position Size", val: riskSettings.maxPositionPct, suffix: "% of equity", warn: riskSettings.maxPositionPct > 15 },
                        { label: "Max Sector Exposure", val: riskSettings.maxSectorPct, suffix: "% of equity", warn: riskSettings.maxSectorPct > 35 },
                        { label: "Stop Loss", val: riskSettings.stopLossPct, suffix: "% below entry", warn: false },
                        { label: "Take Profit", val: riskSettings.takeProfitPct, suffix: "% above entry", warn: false },
                        { label: "Max Portfolio Drawdown", val: riskSettings.maxDrawdownPct, suffix: "%", warn: false },
                        { label: "Max Open Positions", val: riskSettings.maxOpenPositions, suffix: " positions", warn: false },
                      ].map(({ label, val, suffix, warn }) => (
                        <div key={label} className="flex items-center justify-between py-2 border-b border-border/40 last:border-0">
                          <span className="text-xs text-muted-foreground">{label}</span>
                          <div className="flex items-center gap-1.5">
                            {warn && <AlertTriangle className="h-3 w-3 text-amber-500" />}
                            <span className={`text-xs font-mono font-semibold ${warn ? "text-amber-600" : "text-foreground"}`}>{val}{suffix}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Position concentrations */}
              <Card className="border-border">
                <CardHeader className="pb-2 pt-4">
                  <CardTitle className="text-sm">Position Concentration</CardTitle>
                </CardHeader>
                <CardContent>
                  {!portfolioSummary || portfolioSummary.positions.length === 0 ? (
                    <div className="py-8 text-center text-sm text-muted-foreground">No open positions to analyze</div>
                  ) : (
                    <div className="space-y-3">
                      {portfolioSummary.positions.map((pos: any) => {
                        const pct = pos.marketValue != null ? (pos.marketValue / portfolioSummary.totalEquity) * 100 : 0;
                        const isOverLimit = pct > (riskSettings?.maxPositionPct ?? 10);
                        return (
                          <div key={pos.id}>
                            <div className="flex items-center justify-between text-xs mb-1">
                              <span className="font-mono font-bold">{pos.symbol}</span>
                              <div className="flex items-center gap-1.5">
                                {isOverLimit && <AlertTriangle className="h-3 w-3 text-amber-500" />}
                                <span className={`font-mono ${isOverLimit ? "text-amber-600 font-semibold" : "text-muted-foreground"}`}>{pct.toFixed(1)}%</span>
                              </div>
                            </div>
                            <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-all ${isOverLimit ? "bg-amber-400" : pct > 5 ? "bg-primary" : "bg-emerald-500"}`}
                                style={{ width: `${Math.min(pct, 100)}%` }}
                              />
                            </div>
                          </div>
                        );
                      })}
                      <div className="pt-2 border-t border-border/40 text-xs text-muted-foreground">
                        Limit: {riskSettings?.maxPositionPct ?? 10}% per position
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </TabsContent>


        </Tabs>
      </div>
    </div>
  );
}

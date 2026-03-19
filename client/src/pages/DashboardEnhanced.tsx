import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import {
  TrendingUp,
  TrendingDown,
  Bell,
  RefreshCw,
  Loader2,
  Target,
  Sparkles,
  ArrowRight,
  Clock,
  Youtube,
  Activity,
  Shield,
  Zap,
  BarChart3,
  Bot,
  Pause,
  Play,
  CircleDot,
} from "lucide-react";
import { getLoginUrl } from "@/const";
import { toast } from "sonner";

export default function DashboardEnhanced() {
  const { user, loading: authLoading, isAuthenticated } = useAuth();

  // Fetch data
  const { data: news, isLoading: newsLoading, refetch: refetchNews } = trpc.news.recent.useQuery();
  const { data: watchlist, isLoading: watchlistLoading } = trpc.watchlist.list.useQuery(undefined, {
    enabled: isAuthenticated,
  });
  const { data: arkTrades, isLoading: arkLoading } = trpc.ark.recentTrades.useQuery();
  const { data: predictions = [], refetch: refetchPredictions } = trpc.predictions.upcoming.useQuery();
  const { data: alerts, isLoading: alertsLoading } = trpc.alerts.list.useQuery(
    { unreadOnly: true },
    { enabled: isAuthenticated }
  );
  const { data: youtubeVideos = [] } = trpc.youtube.recentVideos.useQuery();
  const { data: agentStatus } = trpc.agent.status.useQuery(undefined, {
    refetchInterval: 30_000,
  });

  // Mutations
  const analyzeNews = trpc.news.analyze.useMutation({
    onSuccess: () => { toast.success("News analysis complete!"); refetchNews(); },
  });
  const generatePredictions = trpc.predictions.generate.useMutation({
    onSuccess: (data) => { toast.success(`Generated ${data.count} predictions!`); refetchPredictions(); },
    onError: () => { toast.error("Failed to generate predictions"); },
  });
  const syncYouTube = trpc.youtube.syncVideos.useMutation({
    onSuccess: () => { toast.success("YouTube videos synced!"); },
    onError: (error) => { toast.error(error.message || "Failed to sync YouTube videos"); },
  });

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background bg-grid">
        <div className="flex flex-col items-center gap-4">
          <div className="relative">
            <div className="h-12 w-12 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
            <Activity className="h-5 w-5 text-primary absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
          </div>
          <span className="text-sm text-muted-foreground font-mono-nums">INITIALIZING</span>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-background bg-grid p-4">
        <div className="max-w-md w-full">
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 mb-6">
              <Activity className="h-8 w-8 text-primary" />
            </div>
            <h1 className="text-3xl font-display font-bold text-foreground mb-2">Trading Agent</h1>
            <p className="text-muted-foreground">AI-powered autonomous trading intelligence</p>
          </div>
          <Card className="border-border/50 backdrop-blur-sm">
            <CardContent className="pt-6">
              <div className="space-y-4 mb-6">
                <div className="flex items-center gap-3 text-sm text-muted-foreground">
                  <Bot className="h-4 w-4 text-primary" />
                  <span>6 specialist AI agents analyzing in parallel</span>
                </div>
                <div className="flex items-center gap-3 text-sm text-muted-foreground">
                  <Shield className="h-4 w-4 text-profit" />
                  <span>Risk management with position limits</span>
                </div>
                <div className="flex items-center gap-3 text-sm text-muted-foreground">
                  <Zap className="h-4 w-4 text-signal" />
                  <span>Real-time market data + Telegram alerts</span>
                </div>
              </div>
              <Button asChild className="w-full h-11 font-medium">
                <a href={getLoginUrl()}>Sign In to Continue</a>
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  const bullishNews = news?.filter((n) => n.sentiment === "bullish").length || 0;
  const bearishNews = news?.filter((n) => n.sentiment === "bearish").length || 0;
  const totalNews = news?.length || 0;

  return (
    <div className="min-h-screen bg-background bg-grid">
      {/* ── Agent Status Bar ──────────────────────────────────────────── */}
      <div className="border-b border-border/50 bg-card/80 backdrop-blur-sm border-gradient-top">
        <div className="container mx-auto py-2 flex items-center justify-between text-xs">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <CircleDot className={`h-3 w-3 ${agentStatus?.isPaused ? "text-warning" : "text-profit pulse-live"}`} />
              <span className="font-mono-nums text-muted-foreground">
                AGENT: <span className={agentStatus?.isPaused ? "text-warning" : "text-profit"}>{agentStatus?.isPaused ? "PAUSED" : "ACTIVE"}</span>
              </span>
            </div>
            <div className="hidden sm:flex items-center gap-2 text-muted-foreground">
              <Clock className="h-3 w-3" />
              <span className="font-mono-nums">
                CYCLE: #{agentStatus?.cycleCount || 0}
              </span>
            </div>
            <div className="hidden md:flex items-center gap-2 text-muted-foreground">
              <BarChart3 className="h-3 w-3" />
              <span className="font-mono-nums">
                TRADES TODAY: {agentStatus?.tradesToday || 0}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="hidden sm:block font-mono-nums text-muted-foreground">
              {new Date().toLocaleTimeString("en-US", { hour12: false })} EST
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full bg-profit pulse-live" />
              <span className="font-mono-nums text-muted-foreground">LIVE</span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Header ────────────────────────────────────────────────────── */}
      <header className="border-b border-border/50 bg-card/50 backdrop-blur-sm">
        <div className="container mx-auto py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
              <Activity className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h1 className="text-xl font-display font-bold text-foreground tracking-tight">Trading Agent</h1>
              <p className="text-xs text-muted-foreground font-mono-nums">MULTI-AGENT PREDICTIVE INTELLIGENCE</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => analyzeNews.mutate()}
              disabled={analyzeNews.isPending}
              className="hidden sm:flex border-border/50 text-xs"
            >
              {analyzeNews.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
              Analyze
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={() => generatePredictions.mutate()}
              disabled={generatePredictions.isPending}
              className="text-xs"
            >
              {generatePredictions.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Sparkles className="h-3.5 w-3.5 mr-1.5" />}
              Generate
            </Button>
            <div className="relative">
              <Bell className="h-5 w-5 text-muted-foreground hover:text-foreground transition-colors" />
              {alerts && alerts.length > 0 && (
                <span className="absolute -top-1.5 -right-1.5 h-4 min-w-4 px-1 bg-loss rounded-full text-[10px] font-mono-nums text-white flex items-center justify-center">
                  {alerts.length}
                </span>
              )}
            </div>
            <div className="h-7 w-7 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center text-xs font-medium text-primary">
              {user?.name?.charAt(0).toUpperCase() || "U"}
            </div>
          </div>
        </div>
      </header>

      {/* ── Main Content ──────────────────────────────────────────────── */}
      <main className="container mx-auto py-6">
        <Tabs defaultValue="overview" className="space-y-6">
          <TabsList className="bg-card border border-border/50 p-1">
            <TabsTrigger value="overview" className="text-xs data-[state=active]:bg-primary/10 data-[state=active]:text-primary">Overview</TabsTrigger>
            <TabsTrigger value="news" className="text-xs data-[state=active]:bg-primary/10 data-[state=active]:text-primary">News Feed</TabsTrigger>
            <TabsTrigger value="watchlist" className="text-xs data-[state=active]:bg-primary/10 data-[state=active]:text-primary">Watchlist</TabsTrigger>
            <TabsTrigger value="ark" className="text-xs data-[state=active]:bg-primary/10 data-[state=active]:text-primary">ARK Trades</TabsTrigger>
            <TabsTrigger value="predictions" className="text-xs data-[state=active]:bg-primary/10 data-[state=active]:text-primary">Predictions</TabsTrigger>
            <TabsTrigger value="youtube" className="text-xs data-[state=active]:bg-primary/10 data-[state=active]:text-primary">YouTube</TabsTrigger>
          </TabsList>

          {/* ── Overview Tab ────────────────────────────────────────────── */}
          <TabsContent value="overview" className="space-y-6">
            {/* Quick Stats Row */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Card className="border-border/50 card-hover">
                <CardContent className="pt-5 pb-4">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">News</span>
                    <BarChart3 className="h-4 w-4 text-muted-foreground/50" />
                  </div>
                  <div className="font-mono-nums text-2xl font-bold text-foreground">{totalNews}</div>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-xs font-mono-nums text-profit">{bullishNews} bullish</span>
                    <span className="text-xs text-muted-foreground">/</span>
                    <span className="text-xs font-mono-nums text-loss">{bearishNews} bearish</span>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-border/50 card-hover">
                <CardContent className="pt-5 pb-4">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Predictions</span>
                    <Target className="h-4 w-4 text-muted-foreground/50" />
                  </div>
                  <div className="font-mono-nums text-2xl font-bold text-foreground">{predictions.length}</div>
                  <p className="text-xs text-muted-foreground mt-1">Active opportunities</p>
                </CardContent>
              </Card>

              <Card className="border-border/50 card-hover">
                <CardContent className="pt-5 pb-4">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">ARK Trades</span>
                    <TrendingUp className="h-4 w-4 text-muted-foreground/50" />
                  </div>
                  <div className="font-mono-nums text-2xl font-bold text-foreground">{arkTrades?.length || 0}</div>
                  <p className="text-xs text-muted-foreground mt-1">Cathie Wood moves</p>
                </CardContent>
              </Card>

              <Card className="border-border/50 card-hover">
                <CardContent className="pt-5 pb-4">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Agent</span>
                    <Bot className="h-4 w-4 text-muted-foreground/50" />
                  </div>
                  <div className="font-mono-nums text-2xl font-bold text-foreground">{agentStatus?.cycleCount || 0}</div>
                  <p className="text-xs text-muted-foreground mt-1">Cycles completed</p>
                </CardContent>
              </Card>
            </div>

            {/* Sector Momentum */}
            <Card className="border-border/50">
              <CardHeader className="pb-3">
                <div className="flex items-center gap-2">
                  <Activity className="h-4 w-4 text-primary" />
                  <CardTitle className="text-sm font-medium">Sector Momentum</CardTitle>
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
                  {["AI / ML", "Semiconductors", "Quantum", "Clean Energy", "Biotech"].map((sector) => (
                    <div key={sector} className="p-3 rounded-lg bg-secondary/50 border border-border/30">
                      <div className="text-xs text-muted-foreground mb-1.5 truncate">{sector}</div>
                      <div className="flex items-center gap-1.5">
                        <TrendingUp className="h-3.5 w-3.5 text-profit" />
                        <span className="text-sm font-semibold text-profit font-mono-nums">Strong</span>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Alerts */}
            {alerts && alerts.length > 0 && (
              <Card className="border-border/50 border-l-2 border-l-warning">
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-2">
                    <Bell className="h-4 w-4 text-warning" />
                    <CardTitle className="text-sm font-medium">Alerts</CardTitle>
                    <Badge variant="secondary" className="text-[10px] font-mono-nums">{alerts.length}</Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {alerts.slice(0, 5).map((alert) => (
                      <div key={alert.id} className="flex items-start gap-3 p-3 rounded-lg bg-secondary/30 border border-border/30">
                        <Badge
                          variant={alert.severity === "high" ? "destructive" : "secondary"}
                          className="text-[10px] font-mono-nums mt-0.5 shrink-0"
                        >
                          {alert.severity.toUpperCase()}
                        </Badge>
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-foreground truncate">{alert.title}</div>
                          <div className="text-xs text-muted-foreground line-clamp-1">{alert.message}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* ── News Feed Tab ───────────────────────────────────────────── */}
          <TabsContent value="news" className="space-y-4">
            <Card className="border-border/50">
              <CardHeader className="pb-3">
                <div className="flex items-center gap-2">
                  <BarChart3 className="h-4 w-4 text-primary" />
                  <CardTitle className="text-sm font-medium">Market Intelligence Feed</CardTitle>
                  <Badge variant="outline" className="text-[10px] font-mono-nums ml-auto">{totalNews} articles</Badge>
                </div>
              </CardHeader>
              <CardContent>
                {newsLoading ? (
                  <div className="flex justify-center py-12">
                    <Loader2 className="h-6 w-6 animate-spin text-primary" />
                  </div>
                ) : news && news.length > 0 ? (
                  <div className="space-y-2">
                    {news.map((article) => (
                      <div key={article.id} className="group p-3 rounded-lg border border-border/30 hover:border-primary/30 hover:bg-secondary/30 transition-all">
                        <div className="flex items-start gap-3">
                          <div className={`w-1 h-8 rounded-full shrink-0 mt-1 ${article.sentiment === "bullish" ? "bg-profit" : article.sentiment === "bearish" ? "bg-loss" : "bg-muted-foreground/30"}`} />
                          <div className="min-w-0 flex-1">
                            <h3 className="text-sm font-medium text-foreground group-hover:text-primary transition-colors line-clamp-1">{article.title}</h3>
                            {article.aiSummary && (
                              <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{article.aiSummary}</p>
                            )}
                            <div className="flex items-center gap-2 mt-2 flex-wrap">
                              <span className="text-[10px] font-mono-nums text-muted-foreground uppercase">{article.source}</span>
                              {article.sentiment && (
                                <Badge
                                  variant="outline"
                                  className={`text-[10px] font-mono-nums border-0 px-1.5 py-0 ${
                                    article.sentiment === "bullish" ? "bg-profit/10 text-profit" :
                                    article.sentiment === "bearish" ? "bg-loss/10 text-loss" :
                                    "bg-muted text-muted-foreground"
                                  }`}
                                >
                                  {article.sentiment === "bullish" && "▲ "}
                                  {article.sentiment === "bearish" && "▼ "}
                                  {article.sentiment.toUpperCase()}
                                </Badge>
                              )}
                              <span className="text-[10px] font-mono-nums text-muted-foreground/60">
                                {new Date(article.publishedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-12">
                    <BarChart3 className="h-8 w-8 text-muted-foreground/30 mx-auto mb-3" />
                    <p className="text-sm text-muted-foreground">No articles yet. Click <span className="text-primary">Analyze</span> to sync feeds.</p>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── Watchlist Tab ───────────────────────────────────────────── */}
          <TabsContent value="watchlist" className="space-y-4">
            <Card className="border-border/50">
              <CardHeader className="pb-3">
                <div className="flex items-center gap-2">
                  <Target className="h-4 w-4 text-primary" />
                  <CardTitle className="text-sm font-medium">Watchlist</CardTitle>
                </div>
              </CardHeader>
              <CardContent>
                {watchlistLoading ? (
                  <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
                ) : watchlist && watchlist.length > 0 ? (
                  <div className="space-y-2">
                    {watchlist.map((stock) => (
                      <div key={stock.id} className="flex items-center justify-between p-3 rounded-lg border border-border/30 hover:border-primary/30 transition-colors">
                        <div className="flex items-center gap-3">
                          <div className="font-mono-nums text-sm font-bold text-foreground">{stock.ticker}</div>
                          {stock.name && <span className="text-xs text-muted-foreground hidden sm:inline">{stock.name}</span>}
                        </div>
                        {stock.isPriority === 1 && (
                          <Badge className="text-[10px] font-mono-nums bg-signal/10 text-signal border-signal/20">PRIORITY</Badge>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-12">
                    <Target className="h-8 w-8 text-muted-foreground/30 mx-auto mb-3" />
                    <p className="text-sm text-muted-foreground">Watchlist empty. Add stocks to track.</p>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── ARK Trades Tab ──────────────────────────────────────────── */}
          <TabsContent value="ark" className="space-y-4">
            <Card className="border-border/50">
              <CardHeader className="pb-3">
                <div className="flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-primary" />
                  <CardTitle className="text-sm font-medium">ARK Invest Trades</CardTitle>
                  <span className="text-xs text-muted-foreground ml-auto">Cathie Wood's portfolio moves</span>
                </div>
              </CardHeader>
              <CardContent>
                {arkLoading ? (
                  <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
                ) : arkTrades && arkTrades.length > 0 ? (
                  <div className="space-y-2">
                    {arkTrades.map((trade) => (
                      <div key={trade.id} className="flex items-center justify-between p-3 rounded-lg border border-border/30">
                        <div className="flex items-center gap-3">
                          <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-mono-nums font-bold ${
                            trade.direction === "buy" ? "bg-profit/10 text-profit" : "bg-loss/10 text-loss"
                          }`}>
                            {trade.direction === "buy" ? "B" : "S"}
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-mono-nums text-sm font-bold text-foreground">{trade.ticker}</span>
                              <Badge variant="outline" className="text-[10px] font-mono-nums py-0">{trade.fund}</Badge>
                            </div>
                            <div className="text-[10px] font-mono-nums text-muted-foreground">
                              {trade.shares?.toLocaleString()} shares · {new Date(trade.tradeDate).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                            </div>
                          </div>
                        </div>
                        <Badge
                          variant="outline"
                          className={`text-[10px] font-mono-nums border-0 ${
                            trade.direction === "buy" ? "bg-profit/10 text-profit" : "bg-loss/10 text-loss"
                          }`}
                        >
                          {trade.direction.toUpperCase()}
                        </Badge>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-12">
                    <TrendingUp className="h-8 w-8 text-muted-foreground/30 mx-auto mb-3" />
                    <p className="text-sm text-muted-foreground">No ARK trades available.</p>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── Predictions Tab ─────────────────────────────────────────── */}
          <TabsContent value="predictions" className="space-y-4">
            <Card className="border-border/50">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-signal" />
                    <CardTitle className="text-sm font-medium">Predicted Opportunities</CardTitle>
                  </div>
                  <span className="text-[10px] font-mono-nums text-muted-foreground">6-AGENT CONSENSUS</span>
                </div>
              </CardHeader>
              <CardContent>
                {predictions.length === 0 ? (
                  <div className="text-center py-12">
                    <Sparkles className="h-8 w-8 text-muted-foreground/30 mx-auto mb-3" />
                    <p className="text-sm text-muted-foreground mb-4">No predictions yet. Click <span className="text-primary">Generate</span> to analyze markets.</p>
                  </div>
                ) : (
                  <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                    {predictions.map((pred: any) => {
                      const confidence = pred.predictionConfidence || 0;
                      const isCall = (pred.opportunityType || "call") === "call" || (pred.direction || "up") === "up";
                      const accentColor = isCall ? "profit" : "loss";

                      return (
                        <div
                          key={pred.id}
                          className={`relative p-4 rounded-lg border border-border/50 bg-card card-hover overflow-hidden ${
                            isCall ? "glow-profit" : "glow-loss"
                          }`}
                        >
                          {/* Confidence bar at top */}
                          <div className="absolute top-0 left-0 right-0 h-0.5">
                            <div
                              className={`h-full ${isCall ? "bg-profit" : "bg-loss"}`}
                              style={{ width: `${confidence}%` }}
                            />
                          </div>

                          <div className="flex items-start justify-between mb-3 mt-1">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <Badge variant="outline" className="text-[10px] font-mono-nums py-0">
                                {pred.sector}
                              </Badge>
                              <Badge className={`text-[10px] font-mono-nums py-0 border-0 ${
                                isCall ? "bg-profit/15 text-profit" : "bg-loss/15 text-loss"
                              }`}>
                                {isCall ? "▲ CALL" : "▼ PUT"}
                              </Badge>
                            </div>
                            <div className="text-right">
                              <div className={`text-xl font-mono-nums font-bold text-${accentColor}`}>{confidence}%</div>
                            </div>
                          </div>

                          <h3 className="text-sm font-semibold mb-1.5 text-foreground line-clamp-1">{pred.name}</h3>
                          <p className="text-xs text-muted-foreground mb-3 line-clamp-2">{pred.description}</p>

                          {pred.earlySignals && (
                            <div className="flex flex-wrap gap-1 mb-3">
                              {JSON.parse(pred.earlySignals).slice(0, 2).map((signal: string, i: number) => (
                                <span key={i} className="text-[10px] font-mono-nums text-muted-foreground bg-secondary/50 px-1.5 py-0.5 rounded">
                                  {signal}
                                </span>
                              ))}
                            </div>
                          )}

                          <Button size="sm" variant="ghost" className="w-full text-xs group h-8">
                            View Details
                            <ArrowRight className="w-3 h-3 ml-1.5 group-hover:translate-x-1 transition-transform" />
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── YouTube Tab ──────────────────────────────────────────────── */}
          <TabsContent value="youtube" className="space-y-4">
            <Card className="border-border/50">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Youtube className="h-4 w-4 text-loss" />
                    <CardTitle className="text-sm font-medium">YouTube Intelligence</CardTitle>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => syncYouTube.mutate()} disabled={syncYouTube.isPending} className="text-xs border-border/50">
                    {syncYouTube.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
                    Sync
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {youtubeVideos.length === 0 ? (
                  <div className="text-center py-12">
                    <Youtube className="h-8 w-8 text-muted-foreground/30 mx-auto mb-3" />
                    <p className="text-sm text-muted-foreground">No videos yet. Click <span className="text-primary">Sync</span> to load.</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {youtubeVideos.map((item: any) => {
                      const video = item.video;
                      return (
                        <div key={video.id} className="group p-3 rounded-lg border border-border/30 hover:border-primary/30 transition-all">
                          <div className="flex gap-3">
                            <div className="w-24 h-14 bg-secondary/50 rounded flex items-center justify-center shrink-0">
                              <Youtube className="w-5 h-5 text-loss/50" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <h3 className="text-sm font-medium text-foreground group-hover:text-primary transition-colors line-clamp-1">{video.title}</h3>
                              <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{video.aiSummary}</p>
                              <div className="flex items-center gap-2 mt-1.5">
                                <span className="text-[10px] font-mono-nums text-muted-foreground">{item.influencer?.channelName || "Unknown"}</span>
                                <span className="text-[10px] text-muted-foreground/40">·</span>
                                <span className="text-[10px] font-mono-nums text-muted-foreground/60">{new Date(video.publishedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
                                {video.sentiment && (
                                  <Badge className={`text-[10px] font-mono-nums py-0 border-0 ml-auto ${
                                    video.sentiment === "bullish" ? "bg-profit/10 text-profit" : video.sentiment === "bearish" ? "bg-loss/10 text-loss" : "bg-muted text-muted-foreground"
                                  }`}>
                                    {video.sentiment.toUpperCase()}
                                  </Badge>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}

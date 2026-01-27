import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { trpc } from "@/lib/trpc";
import { useState } from "react";
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
  ExternalLink,
  CheckCircle,
  XCircle,
  MinusCircle,
  ChevronDown
} from "lucide-react";
import { getLoginUrl } from "@/const";
import { toast } from "sonner";
import { TechnicalAnalysisWidget } from "@/components/TechnicalAnalysisWidget";
import { StockDeepDiveModal } from "@/components/StockDeepDiveModal";
import { Link } from "wouter";

export default function DashboardEnhanced() {
  const { user, loading: authLoading, isAuthenticated } = useAuth();
  const [selectedPrediction, setSelectedPrediction] = useState<any | null>(null);
  const [selectedStock, setSelectedStock] = useState<{ ticker: string; name?: string } | null>(null);

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
  const { data: sectorMomentum = [], isLoading: sectorMomentumLoading } = trpc.sectors.momentum.useQuery();
  const { data: performanceStats } = trpc.predictions.getPerformance.useQuery();

  // Mutations
  const analyzeNews = trpc.news.analyze.useMutation({
    onSuccess: () => {
      toast.success("News analysis complete!");
      refetchNews();
    },
  });

  const generatePredictions = trpc.predictions.generate.useMutation({
    onSuccess: (data) => {
      toast.success(`Generated ${data.count} rally predictions!`);
      refetchPredictions();
    },
    onError: () => {
      toast.error("Failed to generate predictions");
    },
  });

  const syncYouTube = trpc.youtube.syncVideos.useMutation({
    onSuccess: (data) => {
      toast.success(`Synced ${data.count} YouTube videos!`);
    },
    onError: () => {
      toast.error("Failed to sync YouTube videos");
    },
  });

  const scrapeYouTube = trpc.youtube.scrapeVideos.useMutation({
    onSuccess: (data) => {
      toast.success(`Scraped and analyzed ${data.count} YouTube videos using AI Browser Agent!`);
      window.location.reload(); // Refresh to show new videos
    },
    onError: (error) => {
      toast.error(`Failed to scrape YouTube videos: ${error.message}`);
    },
  });

  const scrapeARK = trpc.ark.scrapeTrades.useMutation({
    onSuccess: (data) => {
      toast.success(`Scraped ${data.count} ARK trades using AI Browser Agent!`);
      window.location.reload(); // Refresh to show new trades
    },
    onError: (error) => {
      toast.error(`Failed to scrape ARK trades: ${error.message}`);
    },
  });

  const scrapeNews = trpc.news.scrapeNews.useMutation({
    onSuccess: (data) => {
      toast.success(`Scraped and analyzed ${data.count} news articles using AI Browser Agent!`);
      refetchNews();
    },
    onError: (error) => {
      toast.error(`Failed to scrape news: ${error.message}`);
    },
  });

  const scrapeStockPrice = trpc.stocks.scrapePrice.useMutation({
    onSuccess: (data) => {
      toast.success(`Scraped stock price: $${data.data?.price || 'N/A'}`);
    },
    onError: (error) => {
      toast.error(`Failed to scrape stock price: ${error.message}`);
    },
  });

  const discoverSectors = trpc.sectors.discover.useMutation({
    onSuccess: (data) => {
      toast.success(`Discovered ${data.count} sectors!`);
      window.location.reload(); // Refresh to show new sector momentum
    },
    onError: () => {
      toast.error("Failed to discover sectors");
    },
  });

  // Sort predictions - newest first, then by confidence
  const sortedPredictions = [...predictions].sort((a, b) => {
    const dateA = new Date(a.startDate || a.createdAt).getTime();
    const dateB = new Date(b.startDate || b.createdAt).getTime();
    if (Math.abs(dateA - dateB) < 86400000) { // Within 1 day
      return (b.predictionConfidence || 0) - (a.predictionConfidence || 0);
    }
    return dateB - dateA;
  });

  // Filter out very old predictions (older than 30 days)
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const activePredictions = sortedPredictions.filter(pred => {
    const predDate = new Date(pred.startDate || pred.createdAt);
    return predDate > thirtyDaysAgo;
  });

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  const accuracy = performanceStats && performanceStats.total > 0
    ? ((performanceStats.success / (performanceStats.success + performanceStats.failure)) * 100).toFixed(1)
    : "N/A";

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card sticky top-0 z-50 shadow-sm">
        <div className="container mx-auto py-3 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">AI Trading Agent</h1>
            <p className="text-xs text-muted-foreground">Find Profitable Trades • Bullish & Bearish</p>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/screener">
              <Button variant="ghost" size="sm">
                🔍 Screener
              </Button>
            </Link>
            <Link href="/performance">
              <Button variant="ghost" size="sm">
                📊 Performance
              </Button>
            </Link>
            <Button
              variant="outline"
              size="sm"
              onClick={() => analyzeNews.mutate()}
              disabled={analyzeNews.isPending}
            >
              {analyzeNews.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-2" />
              )}
              Analyze News
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => generatePredictions.mutate()}
              disabled={generatePredictions.isPending}
            >
              {generatePredictions.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <Sparkles className="h-4 w-4 mr-2" />
              )}
              Generate Predictions
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => discoverSectors.mutate()}
              disabled={discoverSectors.isPending}
            >
              {discoverSectors.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <Target className="h-4 w-4 mr-2" />
              )}
              Discover Sectors
            </Button>

            {/* Notifications Dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="relative">
                  <Bell className="h-5 w-5" />
                  {alerts && alerts.length > 0 && (
                    <span className="absolute -top-1 -right-1 h-4 w-4 bg-red-500 rounded-full text-xs text-white flex items-center justify-center">
                      {alerts.length}
                    </span>
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-80">
                <DropdownMenuLabel>Notifications ({alerts?.length || 0})</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {alerts && alerts.length > 0 ? (
                  <>
                    {alerts.slice(0, 5).map((alert) => (
                      <DropdownMenuItem key={alert.id} className="flex-col items-start py-3">
                        <div className="flex items-center gap-2 w-full mb-1">
                          <Badge variant={alert.severity === "high" ? "destructive" : "secondary"} className="text-xs">
                            {alert.severity}
                          </Badge>
                          <span className="text-xs text-muted-foreground">
                            {new Date(alert.createdAt).toLocaleDateString()}
                          </span>
                        </div>
                        <div className="font-medium text-sm">{alert.title}</div>
                        <div className="text-xs text-muted-foreground mt-1">{alert.message}</div>
                      </DropdownMenuItem>
                    ))}
                    {alerts.length > 5 && (
                      <DropdownMenuItem className="text-center text-xs text-primary">
                        +{alerts.length - 5} more notifications
                      </DropdownMenuItem>
                    )}
                  </>
                ) : (
                  <DropdownMenuItem disabled className="text-center">
                    No new notifications
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>

            <span className="text-sm text-muted-foreground">{user?.name || "Guest"}</span>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto py-6">
        <Tabs defaultValue="overview" className="space-y-6">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="opportunities">Trade Opportunities</TabsTrigger>
            <TabsTrigger value="news">News Feed</TabsTrigger>
            <TabsTrigger value="watchlist">Watchlist</TabsTrigger>
            <TabsTrigger value="ai-agents">🤖 AI Agents</TabsTrigger>
            <TabsTrigger value="youtube">YouTube</TabsTrigger>
          </TabsList>

          {/* Overview Tab */}
          <TabsContent value="overview" className="space-y-6">
            {/* Performance Stats Row */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <Card className="border-green-200 dark:border-green-900">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <CheckCircle className="h-4 w-4 text-green-500" />
                    AI Accuracy
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold text-green-600 dark:text-green-400">{accuracy}%</div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {performanceStats?.success || 0} wins / {performanceStats?.failure || 0} losses
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">Active Opportunities</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold text-foreground">{activePredictions.length}</div>
                  <p className="text-xs text-muted-foreground mt-1">Calls & Puts available</p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">News Analyzed</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold text-foreground">{news?.length || 0}</div>
                  <p className="text-xs text-muted-foreground mt-1">Recent articles</p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">ARK Activity</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold text-foreground">{arkTrades?.length || 0}</div>
                  <p className="text-xs text-muted-foreground mt-1">Recent trades</p>
                </CardContent>
              </Card>
            </div>

            {/* Sector Momentum */}
            <Card>
              <CardHeader>
                <CardTitle>Priority Sector Momentum</CardTitle>
                <CardDescription>AI, Chips, Quantum, Tesla, SpaceX, Energy, Healthcare & More</CardDescription>
              </CardHeader>
              <CardContent>
                {sectorMomentumLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  </div>
                ) : sectorMomentum.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <p>No sector momentum data yet.</p>
                    <p className="text-sm mt-2">Click "Discover Sectors" to analyze current trends.</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                    {sectorMomentum.slice(0, 10).map((sector: any) => {
                      const momentum = sector.momentum || "moderate";
                      const isStrong = momentum === "very_strong" || momentum === "strong";
                      const isWeak = momentum === "weak" || momentum === "declining";
                      const momentumLabel = momentum === "very_strong" ? "Very Strong" :
                                          momentum === "strong" ? "Strong" :
                                          momentum === "moderate" ? "Moderate" :
                                          momentum === "weak" ? "Weak" : "Declining";

                      return (
                        <div key={sector.id || sector.sector} className="p-4 border border-border rounded-lg hover:border-primary/50 transition-colors">
                          <div className="text-sm font-medium text-muted-foreground mb-2 truncate" title={sector.sector}>{sector.sector}</div>
                          <div className="flex items-center gap-2">
                            {isStrong ? (
                              <TrendingUp className="h-4 w-4 text-green-500" />
                            ) : isWeak ? (
                              <TrendingDown className="h-4 w-4 text-red-500" />
                            ) : (
                              <Target className="h-4 w-4 text-amber-500" />
                            )}
                            <span className={`text-sm font-bold ${
                              isStrong ? "text-green-600 dark:text-green-400" :
                              isWeak ? "text-red-600 dark:text-red-400" :
                              "text-amber-600 dark:text-amber-400"
                            }`}>
                              {momentumLabel}
                            </span>
                          </div>
                          {sector.newsCount > 0 && (
                            <div className="text-xs text-muted-foreground mt-1">
                              {sector.newsCount} articles
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* ARK Trades Widget (moved from dedicated tab) */}
            {arkTrades && arkTrades.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Recent ARK Invest Activity</CardTitle>
                  <CardDescription>Cathie Wood's latest moves</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {arkTrades.slice(0, 5).map((trade) => (
                      <div key={trade.id} className="flex items-center justify-between p-3 border border-border rounded-lg hover:bg-muted/50 transition-colors">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-foreground">{trade.ticker}</span>
                          <Badge variant="outline" className="text-xs">{trade.fund}</Badge>
                          <Badge variant={trade.direction === "buy" ? "default" : "destructive"} className="text-xs">
                            {trade.direction}
                          </Badge>
                        </div>
                        <div className="text-sm text-muted-foreground">
                          {trade.shares?.toLocaleString()} shares
                        </div>
                      </div>
                    ))}
                    {arkTrades.length > 5 && (
                      <div className="text-center text-xs text-muted-foreground pt-2">
                        +{arkTrades.length - 5} more trades
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* Trade Opportunities Tab (Previously "Predicted Rallies") */}
          <TabsContent value="opportunities" className="space-y-4">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-xl">
                      <Target className="h-6 w-6 text-primary" />
                      Trade Opportunities
                    </CardTitle>
                    <CardDescription>Profitable setups for calls (upside) & puts (downside) • 2-3 weeks ahead</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {activePredictions.length === 0 ? (
                  <div className="text-center py-12">
                    <Sparkles className="h-16 w-16 text-muted-foreground mx-auto mb-4" />
                    <p className="text-lg font-medium mb-2">No Active Opportunities</p>
                    <p className="text-muted-foreground mb-4">
                      Click "Generate Predictions" to analyze current market patterns.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {activePredictions.map((pred: any, index: number) => {
                      const confidence = pred.predictionConfidence || 0;
                      const catalysts = pred.catalysts ? JSON.parse(pred.catalysts) : {};
                      const opportunityType = catalysts.opportunityType || pred.opportunityType || "call";
                      const direction = catalysts.direction || pred.direction || "up";
                      const keyStocks = pred.keyStocks ? JSON.parse(pred.keyStocks) : [];

                      // Color code by opportunity type
                      const isCall = opportunityType === "call" || direction === "up";
                      const predDate = new Date(pred.startDate || pred.createdAt);
                      const isNew = (new Date().getTime() - predDate.getTime()) < 86400000 * 3; // Less than 3 days old

                      const borderColor = isCall
                        ? (confidence >= 75 ? "border-l-green-500" :
                           confidence >= 60 ? "border-l-emerald-500" :
                           "border-l-lime-500")
                        : (confidence >= 75 ? "border-l-red-500" :
                           confidence >= 60 ? "border-l-rose-500" :
                           "border-l-pink-500");

                      return (
                        <div key={pred.id} className={`p-5 border-l-4 border rounded-lg bg-card hover:shadow-lg transition-all ${borderColor}`}>
                          <div className="flex items-start justify-between gap-4">
                            <div className="flex-1">
                              <div className="flex items-center gap-2 mb-2 flex-wrap">
                                {isNew && <Badge variant="outline" className="text-xs border-primary text-primary">NEW</Badge>}
                                <Badge variant={isCall ? "default" : "destructive"} className="text-sm font-bold">
                                  {isCall ? "CALL" : "PUT"} • {confidence}% Confidence
                                </Badge>
                                <Badge variant="outline">{pred.sector}</Badge>
                                <span className="text-xs text-muted-foreground">
                                  {predDate.toLocaleDateString()}
                                </span>
                              </div>

                              <h3 className="font-bold text-lg mb-2 text-foreground">{pred.name}</h3>
                              <p className="text-sm text-muted-foreground mb-3">{pred.description}</p>

                              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                {pred.earlySignals && (
                                  <div>
                                    <div className="text-xs font-medium mb-2 text-muted-foreground">Early Signals:</div>
                                    <div className="flex flex-wrap gap-1">
                                      {JSON.parse(pred.earlySignals).map((signal: string, i: number) => (
                                        <Badge key={i} variant="secondary" className="text-xs">
                                          {signal}
                                        </Badge>
                                      ))}
                                    </div>
                                  </div>
                                )}

                                {keyStocks.length > 0 && (
                                  <div>
                                    <div className="text-xs font-medium mb-2 text-muted-foreground">Key Stocks:</div>
                                    <div className="flex flex-wrap gap-1">
                                      {keyStocks.map((stock: string, i: number) => (
                                        <Badge key={i} variant="outline" className="text-xs font-mono">
                                          {stock}
                                        </Badge>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>

                              {(catalysts.entryTiming || catalysts.exitStrategy) && (
                                <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                                  {catalysts.entryTiming && (
                                    <div className="p-2 bg-muted/50 rounded">
                                      <span className="font-medium">Entry: </span>
                                      <span className="text-muted-foreground">{catalysts.entryTiming}</span>
                                    </div>
                                  )}
                                  {catalysts.exitStrategy && (
                                    <div className="p-2 bg-muted/50 rounded">
                                      <span className="font-medium">Exit: </span>
                                      <span className="text-muted-foreground">{catalysts.exitStrategy}</span>
                                    </div>
                                  )}
                                </div>
                              )}
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

          {/* News Feed Tab */}
          <TabsContent value="news" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Market News Feed</CardTitle>
                <CardDescription>AI-analyzed financial news • Focused on your priority sectors</CardDescription>
              </CardHeader>
              <CardContent>
                {newsLoading ? (
                  <div className="flex justify-center py-8">
                    <Loader2 className="h-8 w-8 animate-spin text-primary" />
                  </div>
                ) : news && news.length > 0 ? (
                  <div className="space-y-4">
                    {news.map((article) => (
                      <div key={article.id} className="p-4 border border-border rounded-lg hover:border-primary/50 transition-colors">
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex-1">
                            <a
                              href={article.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="font-semibold text-foreground mb-2 hover:text-primary transition-colors inline-flex items-center gap-1"
                            >
                              {article.title}
                              <ExternalLink className="h-3 w-3" />
                            </a>
                            {article.aiSummary && (
                              <p className="text-sm text-muted-foreground mb-3 mt-2">{article.aiSummary}</p>
                            )}
                            <div className="flex items-center gap-2 flex-wrap">
                              <Badge variant="outline">{article.source}</Badge>
                              {article.sentiment && (
                                <Badge
                                  variant={
                                    article.sentiment === "bullish"
                                      ? "default"
                                      : article.sentiment === "bearish"
                                      ? "destructive"
                                      : "secondary"
                                  }
                                >
                                  {article.sentiment === "bullish" && <TrendingUp className="h-3 w-3 mr-1" />}
                                  {article.sentiment === "bearish" && <TrendingDown className="h-3 w-3 mr-1" />}
                                  {article.sentiment}
                                </Badge>
                              )}
                              {article.potentialTerm && article.potentialTerm !== "none" && (
                                <Badge variant="secondary">{article.potentialTerm}-term</Badge>
                              )}
                              <div className="text-xs text-muted-foreground flex items-center gap-1">
                                <Clock className="h-3 w-3" />
                                {new Date(article.publishedAt).toLocaleDateString()}
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-8 text-muted-foreground">
                    <p>No news articles available. Click "Analyze News" to fetch latest articles.</p>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Watchlist Tab */}
          <TabsContent value="watchlist" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Your Watchlist</CardTitle>
                <CardDescription>Priority stocks and custom watchlist</CardDescription>
              </CardHeader>
              <CardContent>
                {watchlistLoading ? (
                  <div className="flex justify-center py-8">
                    <Loader2 className="h-8 w-8 animate-spin text-primary" />
                  </div>
                ) : watchlist && watchlist.length > 0 ? (
                  <div className="space-y-4">
                    {watchlist.map((stock) => (
                      <div key={stock.id} className="space-y-3">
                        <div
                          className="flex items-center justify-between p-4 border border-border rounded-lg hover:border-primary/50 cursor-pointer transition-colors"
                          onClick={() => setSelectedStock({ ticker: stock.ticker, name: stock.name || undefined })}
                        >
                          <div>
                            <div className="font-semibold text-foreground">{stock.ticker}</div>
                            {stock.name && <div className="text-sm text-muted-foreground">{stock.name}</div>}
                          </div>
                          {stock.isPriority === 1 && (
                            <Badge variant="default">Priority</Badge>
                          )}
                        </div>
                        {/* Technical Analysis Widget */}
                        <TechnicalAnalysisWidget ticker={stock.ticker} name={stock.name || undefined} />
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-8 text-muted-foreground">
                    <p>Your watchlist is empty. Add stocks to track them.</p>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* AI Agents Tab */}
          <TabsContent value="ai-agents" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  🤖 AI Web Automation Agents
                </CardTitle>
                <CardDescription>
                  Powerful AI-driven web scraping and data collection. Get real-time data faster than competitors!
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* ARK Trades Scraper */}
                  <Card className="border-2 border-primary/20">
                    <CardHeader>
                      <CardTitle className="text-base">ARK Invest Trades Scraper</CardTitle>
                      <CardDescription className="text-xs">
                        Scrape latest ARK fund trades from ark-funds.com in real-time
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <Button
                        className="w-full"
                        onClick={() => scrapeARK.mutate()}
                        disabled={scrapeARK.isPending}
                      >
                        {scrapeARK.isPending ? (
                          <Loader2 className="h-4 w-4 animate-spin mr-2" />
                        ) : (
                          <Sparkles className="h-4 w-4 mr-2" />
                        )}
                        {scrapeARK.isPending ? "Scraping..." : "Scrape ARK Trades Now"}
                      </Button>
                      <p className="text-xs text-muted-foreground mt-2">
                        ⚡ Get Cathie Wood's latest moves instantly
                      </p>
                    </CardContent>
                  </Card>

                  {/* News Scraper */}
                  <Card className="border-2 border-primary/20">
                    <CardHeader>
                      <CardTitle className="text-base">Financial News Scraper</CardTitle>
                      <CardDescription className="text-xs">
                        Scrape breaking news from Reuters, Bloomberg, Yahoo Finance
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <Button
                        className="w-full"
                        onClick={() => scrapeNews.mutate({
                          topics: ["AI stocks", "semiconductor news", "EV market", "tech earnings", "fed interest rates"]
                        })}
                        disabled={scrapeNews.isPending}
                      >
                        {scrapeNews.isPending ? (
                          <Loader2 className="h-4 w-4 animate-spin mr-2" />
                        ) : (
                          <Sparkles className="h-4 w-4 mr-2" />
                        )}
                        {scrapeNews.isPending ? "Scraping..." : "Scrape Breaking News"}
                      </Button>
                      <p className="text-xs text-muted-foreground mt-2">
                        📰 Get news 1-24 hours before RSS feeds
                      </p>
                    </CardContent>
                  </Card>

                  {/* YouTube Scraper */}
                  <Card className="border-2 border-primary/20">
                    <CardHeader>
                      <CardTitle className="text-base">YouTube Options Trading Scraper</CardTitle>
                      <CardDescription className="text-xs">
                        Scrape latest videos from top options trading experts
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <Button
                        className="w-full"
                        onClick={() => scrapeYouTube.mutate({
                          channelNames: [
                            "Chris Sain",
                            // "Option Alpha",
                            // "InTheMoney",
                            // "tastylive",
                            // "BenzingaTV",
                            // "The Trading Channel",
                            // "SMB Capital"
                          ]
                        })}
                        disabled={scrapeYouTube.isPending}
                      >
                        {scrapeYouTube.isPending ? (
                          <Loader2 className="h-4 w-4 animate-spin mr-2" />
                        ) : (
                          <Youtube className="h-4 w-4 mr-2" />
                        )}
                        {scrapeYouTube.isPending ? "Scraping..." : "Scrape YouTube Videos"}
                      </Button>
                      <p className="text-xs text-muted-foreground mt-2">
                        🎥 Latest video from Chris Sain
                      </p>
                    </CardContent>
                  </Card>

                  {/* Stock Price Scraper */}
                  <Card className="border-2 border-primary/20">
                    <CardHeader>
                      <CardTitle className="text-base">Real-Time Stock Price Scraper</CardTitle>
                      <CardDescription className="text-xs">
                        Scrape current stock prices directly from Yahoo Finance
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <Button
                        className="w-full"
                        onClick={() => {
                          const ticker = prompt("Enter ticker symbol (e.g., AAPL, TSLA):");
                          if (ticker) {
                            scrapeStockPrice.mutate({ ticker: ticker.toUpperCase() });
                          }
                        }}
                        disabled={scrapeStockPrice.isPending}
                      >
                        {scrapeStockPrice.isPending ? (
                          <Loader2 className="h-4 w-4 animate-spin mr-2" />
                        ) : (
                          <TrendingUp className="h-4 w-4 mr-2" />
                        )}
                        {scrapeStockPrice.isPending ? "Scraping..." : "Scrape Stock Price"}
                      </Button>
                      <p className="text-xs text-muted-foreground mt-2">
                        💹 Bypass API rate limits with direct scraping
                      </p>
                    </CardContent>
                  </Card>
                </div>

                {/* Info Box */}
                <div className="p-4 bg-green-50 dark:bg-green-950/20 rounded-lg border border-green-200 dark:border-green-900">
                  <div className="flex items-start gap-3">
                    <Sparkles className="h-5 w-5 text-green-600 flex-shrink-0 mt-0.5" />
                    <div className="space-y-2">
                      <div className="font-semibold text-green-900 dark:text-green-100">
                        ✅ Your Secret Weapon: AI Browser Agents (FULLY ACTIVE)
                      </div>
                      <p className="text-sm text-green-800 dark:text-green-200">
                        These AI agents use Puppeteer + Google Gemini to automate web browsing and data extraction.
                        Get data competitors can't access and beat the market with fresher information!
                      </p>
                      <div className="text-xs text-green-700 dark:text-green-300">
                        <strong>Status:</strong> All agents are now fully integrated and ready to use. Click any button above to launch!
                      </div>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* YouTube Tab */}
          <TabsContent value="youtube" className="space-y-4">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <Youtube className="h-5 w-5 text-red-500" />
                      YouTube Influencers
                    </CardTitle>
                    <CardDescription>Trading insights from top financial YouTubers</CardDescription>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => scrapeYouTube.mutate({
                      channelNames: [
                        "Chris Sain",
                        // "Option Alpha",
                        // "InTheMoney",
                        // "tastylive",
                        // "BenzingaTV",
                        // "The Trading Channel",
                        // "SMB Capital"
                      ]
                    })}
                    disabled={scrapeYouTube.isPending}
                  >
                    {scrapeYouTube.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    ) : (
                      <Youtube className="h-4 w-4 mr-2" />
                    )}
                    Scrape Latest Video
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {youtubeVideos.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <p>No YouTube videos available yet.</p>
                  </div>
                ) : (
                  <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                    {youtubeVideos.map((video: any) => (
                      <div key={video.id} className="border border-border rounded-lg overflow-hidden hover:border-primary/50 transition-colors">
                        {video.thumbnailUrl && (
                          <img src={video.thumbnailUrl} alt={video.title} className="w-full h-48 object-cover" />
                        )}
                        <div className="p-4">
                          <a
                            href={video.videoUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-semibold text-sm hover:text-primary transition-colors inline-flex items-center gap-1"
                          >
                            {video.title}
                            <ExternalLink className="h-3 w-3" />
                          </a>
                          {video.aiSummary && (
                            <p className="text-xs text-muted-foreground mt-2 line-clamp-3">{video.aiSummary}</p>
                          )}
                          <div className="flex items-center gap-2 mt-3">
                            {video.sentiment && (
                              <Badge variant={video.sentiment === "bullish" ? "default" : "secondary"} className="text-xs">
                                {video.sentiment}
                              </Badge>
                            )}
                            <span className="text-xs text-muted-foreground">
                              {new Date(video.publishedAt).toLocaleDateString()}
                            </span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </main>

      {/* Prediction Detail Dialog */}
      <Dialog open={!!selectedPrediction} onOpenChange={(open) => !open && setSelectedPrediction(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{selectedPrediction?.name}</DialogTitle>
            <DialogDescription>
              <Badge variant="outline" className="mr-2">{selectedPrediction?.sector}</Badge>
              Confidence: {selectedPrediction?.predictionConfidence}%
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <h4 className="font-semibold mb-2">Description</h4>
              <p className="text-sm text-muted-foreground">{selectedPrediction?.description}</p>
            </div>
            {selectedPrediction?.earlySignals && (
              <div>
                <h4 className="font-semibold mb-2">Early Signals</h4>
                <ul className="list-disc list-inside space-y-1">
                  {JSON.parse(selectedPrediction.earlySignals).map((signal: string, i: number) => (
                    <li key={i} className="text-sm text-muted-foreground">{signal}</li>
                  ))}
                </ul>
              </div>
            )}
            {selectedPrediction?.keyStocks && (
              <div>
                <h4 className="font-semibold mb-2">Recommended Stocks</h4>
                <div className="flex flex-wrap gap-2">
                  {JSON.parse(selectedPrediction.keyStocks).map((stock: string, i: number) => (
                    <Badge key={i} variant="outline" className="font-mono">{stock}</Badge>
                  ))}
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Stock Deep Dive Modal */}
      {selectedStock && (
        <StockDeepDiveModal
          ticker={selectedStock.ticker}
          name={selectedStock.name}
          open={!!selectedStock}
          onClose={() => setSelectedStock(null)}
        />
      )}
    </div>
  );
}

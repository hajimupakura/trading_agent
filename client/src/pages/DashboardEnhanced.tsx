import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
  ExternalLink
} from "lucide-react";
import { getLoginUrl } from "@/const";
import { toast } from "sonner";

export default function DashboardEnhanced() {
  const { user, loading: authLoading, isAuthenticated } = useAuth();
  const [selectedPrediction, setSelectedPrediction] = useState<any | null>(null);

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

  const discoverSectors = trpc.sectors.discover.useMutation({
    onSuccess: (data) => {
      toast.success(`Discovered ${data.count} sectors!`);
      window.location.reload(); // Refresh to show new sector momentum
    },
    onError: () => {
      toast.error("Failed to discover sectors");
    },
  });

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  // Allow guest access since most endpoints are public
  // if (!isAuthenticated) {
  //   return (
  //     <div className="min-h-screen flex flex-col items-center justify-center bg-background p-4">
  //       <Card className="max-w-md w-full">
  //         <CardHeader>
  //           <CardTitle>AI Trading Agent</CardTitle>
  //           <CardDescription>
  //             Predictive market intelligence for identifying opportunities 2-3 weeks ahead
  //           </CardDescription>
  //         </CardHeader>
  //         <CardContent>
  //           <p className="text-sm text-muted-foreground mb-4">
  //             Track market news, ARK trades, predicted rallies, and receive AI-powered alerts for your trading strategy.
  //           </p>
  //           <Button asChild className="w-full">
  //             <a href={getLoginUrl()}>Sign In to Continue</a>
  //           </Button>
  //         </CardContent>
  //       </Card>
  //     </div>
  //   );
  // }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card">
        <div className="container mx-auto py-4 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">AI Trading Agent</h1>
            <p className="text-sm text-muted-foreground">Predictive Market Intelligence</p>
          </div>
          <div className="flex items-center gap-4">
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
            <div className="relative">
              <Bell className="h-5 w-5 text-muted-foreground" />
              {alerts && alerts.length > 0 && (
                <span className="absolute -top-1 -right-1 h-4 w-4 bg-red-500 rounded-full text-xs text-white flex items-center justify-center">
                  {alerts.length}
                </span>
              )}
            </div>
            <span className="text-sm text-muted-foreground">{user?.name}</span>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto py-6">
        <Tabs defaultValue="overview" className="space-y-6">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="news">News Feed</TabsTrigger>
            <TabsTrigger value="watchlist">Watchlist</TabsTrigger>
            <TabsTrigger value="ark">ARK Trades</TabsTrigger>
            <TabsTrigger value="predictions">Predicted Rallies</TabsTrigger>
            <TabsTrigger value="youtube">YouTube</TabsTrigger>
          </TabsList>

          {/* Overview Tab */}
          <TabsContent value="overview" className="space-y-6">
            {/* Sector Momentum */}
            <Card>
              <CardHeader>
                <CardTitle>Sector Momentum</CardTitle>
                <CardDescription>Real-time momentum indicators for key sectors</CardDescription>
              </CardHeader>
              <CardContent>
                {sectorMomentumLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  </div>
                ) : sectorMomentum.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <p>No sector momentum data available.</p>
                    <p className="text-sm mt-2">Sector momentum is calculated from news analysis.</p>
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
                        <div key={sector.id || sector.sector} className="p-4 border border-border rounded-lg">
                          <div className="text-sm font-medium text-muted-foreground mb-2">{sector.sector}</div>
                          <div className="flex items-center gap-2">
                            {isStrong ? (
                              <TrendingUp className="h-4 w-4 text-green-500" />
                            ) : isWeak ? (
                              <TrendingDown className="h-4 w-4 text-red-500" />
                            ) : (
                              <Target className="h-4 w-4 text-amber-500" />
                            )}
                            <span className={`text-lg font-bold ${
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

            {/* Recent Alerts */}
            {alerts && alerts.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Recent Alerts</CardTitle>
                  <CardDescription>{alerts.length} unread alerts</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {alerts.slice(0, 5).map((alert) => (
                      <div key={alert.id} className="flex items-start gap-3 p-3 border border-border rounded-lg">
                        <Badge variant={alert.severity === "high" ? "destructive" : "secondary"}>
                          {alert.severity}
                        </Badge>
                        <div className="flex-1">
                          <div className="font-medium text-foreground">{alert.title}</div>
                          <div className="text-sm text-muted-foreground">{alert.message}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Quick Stats */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <Card>
                <CardHeader>
                  <CardTitle>News Articles</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold text-foreground">{news?.length || 0}</div>
                  <p className="text-sm text-muted-foreground">Recent articles analyzed</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>ARK Trades</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold text-foreground">{arkTrades?.length || 0}</div>
                  <p className="text-sm text-muted-foreground">Recent trades tracked</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Predicted Rallies</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold text-foreground">{predictions.length}</div>
                  <p className="text-sm text-muted-foreground">Upcoming opportunities</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>YouTube Videos</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold text-foreground">{youtubeVideos.length}</div>
                  <p className="text-sm text-muted-foreground">Influencer insights</p>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* News Feed Tab */}
          <TabsContent value="news" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Market News Feed</CardTitle>
                <CardDescription>AI-analyzed financial news from multiple sources</CardDescription>
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
                  <div className="space-y-3">
                    {watchlist.map((stock) => (
                      <div key={stock.id} className="flex items-center justify-between p-4 border border-border rounded-lg">
                        <div>
                          <div className="font-semibold text-foreground">{stock.ticker}</div>
                          {stock.name && <div className="text-sm text-muted-foreground">{stock.name}</div>}
                        </div>
                        {stock.isPriority === 1 && (
                          <Badge variant="default">Priority</Badge>
                        )}
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

          {/* ARK Trades Tab */}
          <TabsContent value="ark" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>ARK Invest Trades</CardTitle>
                <CardDescription>Recent portfolio changes by Cathie Wood's ARK ETFs</CardDescription>
              </CardHeader>
              <CardContent>
                {arkLoading ? (
                  <div className="flex justify-center py-8">
                    <Loader2 className="h-8 w-8 animate-spin text-primary" />
                  </div>
                ) : arkTrades && arkTrades.length > 0 ? (
                  <div className="space-y-3">
                    {arkTrades.map((trade) => (
                      <div key={trade.id} className="flex items-center justify-between p-4 border border-border rounded-lg">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-semibold text-foreground">{trade.ticker}</span>
                            <Badge variant="outline">{trade.fund}</Badge>
                            <Badge variant={trade.direction === "buy" ? "default" : "destructive"}>
                              {trade.direction}
                            </Badge>
                          </div>
                          <div className="text-sm text-muted-foreground">
                            {trade.shares} shares • {new Date(trade.tradeDate).toLocaleDateString()}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-8 text-muted-foreground">
                    <p>No ARK trades available yet.</p>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Predicted Rallies Tab */}
          <TabsContent value="predictions" className="space-y-4">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <Target className="h-5 w-5 text-primary" />
                      Predicted Rallies
                    </CardTitle>
                    <CardDescription>Opportunities 2-3 weeks ahead of the market</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {predictions.length === 0 ? (
                  <div className="text-center py-8">
                    <Sparkles className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                    <p className="text-muted-foreground mb-4">
                      No predictions yet. Click "Generate Predictions" to analyze current market patterns.
                    </p>
                  </div>
                ) : (
                  <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                    {predictions.map((pred: any) => {
                      const confidence = pred.predictionConfidence || 0;
                      const opportunityType = pred.opportunityType || "call";
                      const direction = pred.direction || "up";
                      
                      // Color code by opportunity type: Green for calls (upside), Red for puts (downside)
                      const isCall = opportunityType === "call" || direction === "up";
                      const baseColor = isCall 
                        ? (confidence >= 75 ? "border-green-500 bg-green-50 dark:bg-green-950/20" :
                           confidence >= 60 ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/20" :
                           "border-lime-500 bg-lime-50 dark:bg-lime-950/20")
                        : (confidence >= 75 ? "border-red-500 bg-red-50 dark:bg-red-950/20" :
                           confidence >= 60 ? "border-rose-500 bg-rose-50 dark:bg-rose-950/20" :
                           "border-pink-500 bg-pink-50 dark:bg-pink-950/20");

                      return (
                        <div key={pred.id} className={`p-5 border-2 rounded-lg ${baseColor} transition-all hover:scale-105`}>
                          <div className="flex items-start justify-between mb-3">
                            <div className="flex items-center gap-2">
                              <Badge variant="outline" className="border-current">
                                {pred.sector}
                              </Badge>
                              <Badge variant={isCall ? "default" : "destructive"} className="text-xs">
                                {isCall ? "CALL" : "PUT"}
                              </Badge>
                            </div>
                            <div className="text-right">
                              <div className="text-2xl font-bold text-foreground">{confidence}%</div>
                              <div className="text-xs text-muted-foreground">confidence</div>
                            </div>
                          </div>
                          <h3 className="font-semibold text-lg mb-2 text-foreground">{pred.name}</h3>
                          <p className="text-sm text-muted-foreground mb-4 line-clamp-2">{pred.description}</p>
                          
                          {pred.earlySignals && (
                            <div className="mb-3">
                              <div className="text-xs font-medium mb-1 text-muted-foreground">Early Signals:</div>
                              <div className="flex flex-wrap gap-1">
                                {JSON.parse(pred.earlySignals).slice(0, 2).map((signal: string, i: number) => (
                                  <Badge key={i} variant="secondary" className="text-xs">
                                    {signal}
                                  </Badge>
                                ))}
                              </div>
                            </div>
                          )}

                          <Button 
                            size="sm" 
                            variant="ghost" 
                            className="w-full mt-2 group"
                            onClick={() => setSelectedPrediction(pred)}
                          >
                            View Details
                            <ArrowRight className="w-4 h-4 ml-2 group-hover:translate-x-1 transition-transform" />
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                )}
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
                    <CardDescription>Trading insights from top YouTube channels</CardDescription>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => syncYouTube.mutate()}
                    disabled={syncYouTube.isPending}
                  >
                    {syncYouTube.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    ) : (
                      <RefreshCw className="h-4 w-4 mr-2" />
                    )}
                    Sync Videos
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {youtubeVideos.length === 0 ? (
                  <div className="text-center py-8">
                    <Youtube className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                    <p className="text-muted-foreground">No YouTube videos yet. Click "Sync Videos" to load influencer content.</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {youtubeVideos.map((item: any) => {
                      const video = item.video;
                      return (
                        <div key={video.id} className="p-4 border border-border rounded-lg hover:border-primary/50 transition-colors">
                          <div className="flex gap-4">
                            <div className="flex-shrink-0">
                              <div className="w-32 h-20 bg-muted rounded flex items-center justify-center">
                                <Youtube className="w-8 h-8 text-red-500" />
                              </div>
                            </div>
                            <div className="flex-1">
                              <h3 className="font-semibold text-foreground mb-1">{video.title}</h3>
                              <p className="text-sm text-muted-foreground mb-2 line-clamp-2">{video.aiSummary}</p>
                              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                <span>{item.influencer?.channelName || "Unknown Channel"}</span>
                                <span>•</span>
                                <Clock className="h-3 w-3" />
                                <span>{new Date(video.publishedAt).toLocaleDateString()}</span>
                                {video.sentiment && (
                                  <>
                                    <span>•</span>
                                    <Badge variant={video.sentiment === "bullish" ? "default" : video.sentiment === "bearish" ? "destructive" : "secondary"} className="text-xs">
                                      {video.sentiment}
                                    </Badge>
                                  </>
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

      {/* Prediction Details Dialog */}
      <Dialog open={!!selectedPrediction} onOpenChange={(open) => !open && setSelectedPrediction(null)}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto bg-slate-900 border-slate-800">
          {selectedPrediction && (
            <>
              <DialogHeader>
                <DialogTitle className="text-2xl text-slate-100 flex items-center gap-2">
                  {(() => {
                    let opportunityType = null;
                    try {
                      const catalysts = selectedPrediction.catalysts ? JSON.parse(selectedPrediction.catalysts) : {};
                      opportunityType = catalysts.opportunityType;
                    } catch (e) {
                      // Ignore parse errors
                    }
                    return opportunityType === "call" ? (
                      <TrendingUp className="w-6 h-6 text-emerald-400" />
                    ) : opportunityType === "put" ? (
                      <TrendingDown className="w-6 h-6 text-red-400" />
                    ) : (
                      <Target className="w-6 h-6 text-cyan-400" />
                    );
                  })()}
                  {selectedPrediction.name}
                </DialogTitle>
                <DialogDescription className="text-slate-400">
                  {selectedPrediction.sector} • {selectedPrediction.predictionConfidence}% Confidence
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-6 mt-4">
                {(() => {
                  // Parse catalysts to get additional fields
                  let metadata: any = {};
                  try {
                    metadata = selectedPrediction.catalysts ? JSON.parse(selectedPrediction.catalysts) : {};
                  } catch (e) {
                    console.error("Failed to parse catalysts:", e);
                  }

                  return (
                    <>
                      {/* Confidence & Timeframe */}
                      <div className="grid grid-cols-2 gap-4">
                        <Card className="p-4 bg-slate-800/50 border-slate-700">
                          <div className="text-sm text-slate-400 mb-1">Confidence</div>
                          <div className="text-2xl font-bold text-emerald-400">{selectedPrediction.predictionConfidence}%</div>
                        </Card>
                        <Card className="p-4 bg-slate-800/50 border-slate-700">
                          <div className="text-sm text-slate-400 mb-1">Timeframe</div>
                          <div className="text-lg font-semibold text-slate-200">{metadata.timeframe || "2-3 weeks"}</div>
                        </Card>
                      </div>

                      {/* Opportunity Type */}
                      {metadata.opportunityType && (
                        <div>
                          <h3 className="text-sm font-semibold text-slate-300 mb-2">Opportunity Type</h3>
                          <Badge variant={metadata.opportunityType === "call" ? "default" : "destructive"} className="capitalize">
                            {metadata.opportunityType.toUpperCase()} - {metadata.direction === "up" ? "Upside" : "Downside"}
                          </Badge>
                        </div>
                      )}

                      {/* Early Signals */}
                      {selectedPrediction.earlySignals && (
                        <div>
                          <h3 className="text-sm font-semibold text-slate-300 mb-2">Early Warning Signals</h3>
                          <div className="flex flex-wrap gap-2">
                            {(() => {
                              try {
                                const signals = JSON.parse(selectedPrediction.earlySignals);
                                return Array.isArray(signals) ? signals.map((signal: string, i: number) => (
                                  <Badge key={i} variant="secondary" className="bg-slate-800 text-slate-300">
                                    {signal}
                                  </Badge>
                                )) : null;
                              } catch (e) {
                                return <span className="text-sm text-slate-400">No signals available</span>;
                              }
                            })()}
                          </div>
                        </div>
                      )}

                      {/* Recommended Stocks */}
                      {selectedPrediction.keyStocks && (
                        <div>
                          <h3 className="text-sm font-semibold text-slate-300 mb-2">Recommended Stocks</h3>
                          <div className="flex flex-wrap gap-2">
                            {(() => {
                              try {
                                const stocks = JSON.parse(selectedPrediction.keyStocks);
                                return Array.isArray(stocks) ? stocks.map((stock: string, i: number) => (
                                  <Badge key={i} variant="outline" className="bg-emerald-950/30 border-emerald-600/50 text-emerald-400">
                                    {stock}
                                  </Badge>
                                )) : null;
                              } catch (e) {
                                return <span className="text-sm text-slate-400">No stocks available</span>;
                              }
                            })()}
                          </div>
                        </div>
                      )}

                      {/* Reasoning / Analysis */}
                      {(metadata.reasoning || selectedPrediction.description) && (
                        <div>
                          <h3 className="text-sm font-semibold text-slate-300 mb-2">Analysis & Reasoning</h3>
                          <p className="text-sm text-slate-400 leading-relaxed">
                            {metadata.reasoning || selectedPrediction.description}
                          </p>
                        </div>
                      )}

                      {/* Entry Timing */}
                      {metadata.entryTiming && (
                        <div>
                          <h3 className="text-sm font-semibold text-slate-300 mb-2 flex items-center gap-2">
                            <Clock className="w-4 h-4" />
                            Entry Timing
                          </h3>
                          <p className="text-sm text-slate-400">{metadata.entryTiming}</p>
                        </div>
                      )}

                      {/* Exit Strategy */}
                      {metadata.exitStrategy && (
                        <div>
                          <h3 className="text-sm font-semibold text-slate-300 mb-2">Exit Strategy</h3>
                          <p className="text-sm text-slate-400">{metadata.exitStrategy}</p>
                        </div>
                      )}

                      {/* Description (fallback) */}
                      {selectedPrediction.description && !metadata.reasoning && (
                        <div>
                          <h3 className="text-sm font-semibold text-slate-300 mb-2">Overview</h3>
                          <p className="text-sm text-slate-400 leading-relaxed">{selectedPrediction.description}</p>
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

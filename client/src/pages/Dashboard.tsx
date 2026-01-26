import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { TrendingUp, TrendingDown, Bell, RefreshCw, Loader2 } from "lucide-react";
import { getLoginUrl } from "@/const";
import { Link } from "wouter";

export default function Dashboard() {
  const { user, loading: authLoading, isAuthenticated } = useAuth();

  // Fetch data
  const { data: news, isLoading: newsLoading, refetch: refetchNews } = trpc.news.recent.useQuery();
  const { data: watchlist, isLoading: watchlistLoading } = trpc.watchlist.list.useQuery(undefined, {
    enabled: isAuthenticated,
  });
  const { data: arkTrades, isLoading: arkLoading } = trpc.ark.recentTrades.useQuery();
  const { data: rallies, isLoading: ralliesLoading } = trpc.rallies.list.useQuery({ status: "ongoing" });
  const { data: alerts, isLoading: alertsLoading } = trpc.alerts.list.useQuery(
    { unreadOnly: true },
    { enabled: isAuthenticated }
  );

  // Mutations
  const analyzeNews = trpc.news.analyze.useMutation({
    onSuccess: () => {
      refetchNews();
    },
  });

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-background p-4">
        <Card className="max-w-md w-full">
          <CardHeader>
            <CardTitle>AI Trading Agent</CardTitle>
            <CardDescription>
              Financial market intelligence dashboard for identifying investment opportunities
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-4">
              Track market news, ARK trades, sector rallies, and receive AI-powered alerts for your trading strategy.
            </p>
            <Button asChild className="w-full">
              <a href={getLoginUrl()}>Sign In to Continue</a>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card">
        <div className="container mx-auto py-4 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">AI Trading Agent</h1>
            <p className="text-sm text-muted-foreground">Market Intelligence Dashboard</p>
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
            <TabsTrigger value="rallies">Rally Tracker</TabsTrigger>
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
                <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                  {["AI", "Metals", "Quantum", "Energy", "Chips"].map((sector) => (
                    <div key={sector} className="p-4 border border-border rounded-lg">
                      <div className="text-sm font-medium text-muted-foreground mb-2">{sector}</div>
                      <div className="flex items-center gap-2">
                        <TrendingUp className="h-4 w-4 text-green-500" />
                        <span className="text-lg font-bold text-foreground">Strong</span>
                      </div>
                    </div>
                  ))}
                </div>
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
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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
                  <CardTitle>Active Rallies</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold text-foreground">{rallies?.length || 0}</div>
                  <p className="text-sm text-muted-foreground">Ongoing sector rallies</p>
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
                      <div key={article.id} className="p-4 border border-border rounded-lg">
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex-1">
                            <h3 className="font-semibold text-foreground mb-2">{article.title}</h3>
                            {article.aiSummary && (
                              <p className="text-sm text-muted-foreground mb-3">{article.aiSummary}</p>
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
                                  {article.sentiment}
                                </Badge>
                              )}
                              {article.potentialTerm && article.potentialTerm !== "none" && (
                                <Badge variant="secondary">{article.potentialTerm}-term</Badge>
                              )}
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
                      <div key={stock.id} className="flex items-center justify-between p-3 border border-border rounded-lg">
                        <div>
                          <div className="font-semibold text-foreground">{stock.ticker}</div>
                          {stock.name && <div className="text-sm text-muted-foreground">{stock.name}</div>}
                        </div>
                        {stock.isPriority === 1 && <Badge>Priority</Badge>}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-8 text-muted-foreground">
                    <p>No stocks in your watchlist yet.</p>
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
                      <div key={trade.id} className="flex items-center justify-between p-3 border border-border rounded-lg">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-semibold text-foreground">{trade.ticker}</span>
                            <Badge variant="outline">{trade.fund}</Badge>
                            <Badge variant={trade.direction === "buy" ? "default" : "destructive"}>
                              {trade.direction}
                            </Badge>
                          </div>
                          {trade.companyName && (
                            <div className="text-sm text-muted-foreground">{trade.companyName}</div>
                          )}
                        </div>
                        <div className="text-right">
                          {trade.marketValue && (
                            <div className="text-sm font-medium text-foreground">{trade.marketValue}</div>
                          )}
                          {trade.percentOfEtf && (
                            <div className="text-xs text-muted-foreground">{trade.percentOfEtf} of ETF</div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-8 text-muted-foreground">
                    <p>No ARK trades available.</p>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Rally Tracker Tab */}
          <TabsContent value="rallies" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Market Rally Tracker</CardTitle>
                <CardDescription>Historical and ongoing sector rallies</CardDescription>
              </CardHeader>
              <CardContent>
                {ralliesLoading ? (
                  <div className="flex justify-center py-8">
                    <Loader2 className="h-8 w-8 animate-spin text-primary" />
                  </div>
                ) : rallies && rallies.length > 0 ? (
                  <div className="space-y-4">
                    {rallies.map((rally) => (
                      <div key={rally.id} className="p-4 border border-border rounded-lg">
                        <div className="flex items-start justify-between mb-3">
                          <div>
                            <h3 className="font-semibold text-foreground">{rally.name}</h3>
                            <div className="flex items-center gap-2 mt-1">
                              <Badge>{rally.sector}</Badge>
                              <Badge variant="outline">{rally.status}</Badge>
                            </div>
                          </div>
                        </div>
                        {rally.description && (
                          <p className="text-sm text-muted-foreground mb-3">{rally.description}</p>
                        )}
                        <div className="text-xs text-muted-foreground">
                          Started: {new Date(rally.startDate).toLocaleDateString()}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-8 text-muted-foreground">
                    <p>No active rallies detected.</p>
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

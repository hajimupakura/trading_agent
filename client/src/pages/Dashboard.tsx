import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { TrendingUp, TrendingDown, Bell, RefreshCw, Loader2, ExternalLink, Target, Hourglass, Zap, CheckCircle2 } from "lucide-react";
import { getLoginUrl } from "@/const";
import { Link } from "wouter";
import { cn, formatTimeAgo } from "@/lib/utils";
import type { NewsArticle, WatchlistStock } from "shared/types";
import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { StockChart } from "@/components/StockChart"; // Import the StockChart component
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { X } from "lucide-react";

function FinancialsDialog({ stock, open, onOpenChange }: { stock: WatchlistStock | null, open: boolean, onOpenChange: (open: boolean) => void }) {
  const { data: financials, isLoading } = trpc.stocks.getFinancials.useQuery(
    { symbol: stock?.ticker || "" },
    { enabled: !!stock }
  );

  if (!stock) return null; // Ensure stock is available when dialog is open

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl"> {/* Make dialog wider for chart */}
        <DialogHeader>
          <DialogTitle>{stock.name} ({stock.ticker})</DialogTitle>
          <DialogDescription>Detailed Stock Information</DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="financials" className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="financials">Financials</TabsTrigger>
            <TabsTrigger value="chart">Chart</TabsTrigger>
          </TabsList>
          <TabsContent value="financials" className="mt-4">
            {isLoading ? (
              <div className="flex justify-center py-8">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
              </div>
            ) : financials ? (
              <div className="grid grid-cols-2 gap-4 py-4">
                <div className="text-sm">
                  <div className="text-muted-foreground">Market Cap</div>
                  <div className="font-semibold">${(Number(financials.marketCap) / 1_000_000_000).toFixed(2)}B</div>
                </div>
                <div className="text-sm">
                  <div className="text-muted-foreground">P/E Ratio</div>
                  <div className="font-semibold">{Number(financials.peRatio).toFixed(2)}</div>
                </div>
                <div className="text-sm">
                  <div className="text-muted-foreground">EPS</div>
                  <div className="font-semibold">{Number(financials.eps).toFixed(2)}</div>
                </div>
                <div className="text-sm">
                  <div className="text-muted-foreground">Dividend Yield</div>
                  <div className="font-semibold">{Number(financials.dividendYield).toFixed(2)}%</div>
                </div>
                <div className="text-sm">
                  <div className="text-muted-foreground">Beta</div>
                  <div className="font-semibold">{Number(financials.beta).toFixed(2)}</div>
                </div>
                <div className="text-sm">
                  <div className="text-muted-foreground">52-Week High</div>
                  <div className="font-semibold">${Number(financials.high52Week).toFixed(2)}</div>
                </div>
                <div className="text-sm">
                  <div className="text-muted-foreground">52-Week Low</div>
                  <div className="font-semibold">${Number(financials.low52Week).toFixed(2)}</div>
                </div>
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                No financial data available.
              </div>
            )}
          </TabsContent>
          <TabsContent value="chart" className="mt-4">
            <StockChart symbol={stock.ticker} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}


export default function Dashboard() {
  const { user, loading: authLoading, isAuthenticated } = useAuth();

  // Fetch data
  const { data: news, isLoading: newsLoading, refetch: refetchNews } = trpc.news.recent.useQuery();
  const { data: watchlist, isLoading: watchlistLoading } = trpc.watchlist.list.useQuery(undefined, {
    enabled: isAuthenticated,
  });

  const watchlistTickers = watchlist?.map(stock => stock.ticker) || [];
  const { data: stockQuotes, isLoading: stockQuotesLoading } = trpc.stocks.getMultipleQuotes.useQuery(
    { symbols: watchlistTickers },
    {
      enabled: isAuthenticated && watchlistTickers.length > 0,
      refetchInterval: (query) => {
        // Only refetch during market hours (e.g., 9:30 AM to 4:00 PM EST)
        const now = new Date();
        const estOffset = -5; // EST is UTC-5
        const estHour = now.getUTCHours() + estOffset;
        const estMinute = now.getUTCMinutes();
        
        // Simple check for market hours (9:30 AM - 4:00 PM EST) and weekdays
        const isMarketOpen = estHour >= 9 && (estHour < 16 || (estHour === 16 && estMinute === 0)) && now.getDay() >= 1 && now.getDay() <= 5;

        return isMarketOpen ? 5 * 60 * 1000 : false; // Refetch every 5 minutes if market is open
      },
      select: (data) => {
        // Convert the object returned by tRPC into a Map for easier lookup
        return new Map(Object.entries(data));
      }
    }
  );
  const { data: arkTrades, isLoading: arkLoading } = trpc.ark.recentTrades.useQuery();
  const { data: rallies, isLoading: ralliesLoading } = trpc.rallies.list.useQuery({ status: "ongoing" });
  const { data: alerts, isLoading: alertsLoading } = trpc.alerts.list.useQuery(
    { unreadOnly: true },
    { enabled: isAuthenticated }
  );
  const { data: sectorMomentum = [], isLoading: sectorMomentumLoading } = trpc.sectors.momentum.useQuery();

  const { data: userDefinedAlerts, refetch: refetchUserDefinedAlerts } = trpc.userAlerts.list.useQuery(undefined, { enabled: isAuthenticated });
  
  const createUserAlert = trpc.userAlerts.create.useMutation({
    onSuccess: () => refetchUserDefinedAlerts(),
  });

  const deleteUserAlert = trpc.userAlerts.delete.useMutation({
    onSuccess: () => refetchUserDefinedAlerts(),
  });

  const [selectedStock, setSelectedStock] = useState<WatchlistStock | null>(null);

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

  // Allow guest access since most endpoints are public
  // if (!isAuthenticated) {
  //   return (
  //     <div className="min-h-screen flex flex-col items-center justify-center bg-background p-4">
  //       <Card className="max-w-md w-full">
  //         <CardHeader>
  //           <CardTitle>AI Trading Agent</CardTitle>
  //           <CardDescription>
  //             Financial market intelligence dashboard for identifying investment opportunities
  //           </CardDescription>
  //         </CardHeader>
  //         <CardContent>
  //           <p className="text-sm text-muted-foreground mb-4">
  //             Track market news, ARK trades, sector rallies, and receive AI-powered alerts for your trading strategy.
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
            <TabsTrigger value="my-alerts">My Alerts</TabsTrigger>
            <Link href="/performance">
              <TabsTrigger value="performance">Performance</TabsTrigger>
            </Link>
            <Link href="/screener">
              <TabsTrigger value="screener">Screener</TabsTrigger>
            </Link>
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
                            <div className="flex items-center justify-between mb-2">
                              <div className="text-sm text-muted-foreground">
                                {formatTimeAgo(article.publishedAt)}
                              </div>
                              {getAiStatus(article)}
                            </div>
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
                            <div className="flex items-center gap-2 flex-wrap mt-3">
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
                <CardDescription>Priority stocks and custom watchlist with real-time quotes</CardDescription>
              </CardHeader>
              <CardContent>
                {(watchlistLoading || stockQuotesLoading) ? (
                  <div className="flex justify-center py-8">
                    <Loader2 className="h-8 w-8 animate-spin text-primary" />
                  </div>
                ) : watchlist && watchlist.length > 0 ? (
                  <div className="space-y-3">
                    {watchlist.map((stock) => {
                      const quote = stockQuotes?.get(stock.ticker);
                      const isPositive = quote && quote.change > 0;
                      const isNegative = quote && quote.change < 0;

                      return (
                        <div 
                          key={stock.id} 
                          className="flex items-center justify-between p-3 border border-border rounded-lg cursor-pointer hover:bg-muted/50 transition-colors"
                          onClick={() => setSelectedStock(stock)}
                        >
                          <div>
                            <div className="font-semibold text-foreground">{stock.ticker}</div>
                            {stock.name && <div className="text-sm text-muted-foreground">{stock.name}</div>}
                          </div>
                          {quote ? (
                            <div className="text-right">
                              <div className="text-lg font-bold text-foreground">
                                ${quote.currentPrice.toFixed(2)}
                              </div>
                              <div className={cn(
                                "flex items-center justify-end text-sm font-medium",
                                isPositive && "text-green-600 dark:text-green-400",
                                isNegative && "text-red-600 dark:text-red-400"
                              )}>
                                {isPositive && <TrendingUp className="h-4 w-4 mr-1" />}
                                {isNegative && <TrendingDown className="h-4 w-4 mr-1" />}
                                {quote.change.toFixed(2)} ({quote.percentChange.toFixed(2)}%)
                              </div>
                            </div>
                          ) : (
                            <div className="text-muted-foreground text-sm">
                              {stockQuotesLoading ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                "No quote data"
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
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

          {/* My Alerts Tab */}
          <TabsContent value="my-alerts" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>My Custom Alerts</CardTitle>
                <CardDescription>Create and manage your own alerts for specific stock events.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* Create Alert Form */}
                <form onSubmit={(e) => {
                  e.preventDefault();
                  const formData = new FormData(e.currentTarget);
                  const ticker = formData.get("ticker") as string;
                  const type = formData.get("type") as "price_above" | "price_below";
                  const value = formData.get("value") as string;
                  if (ticker && type && value) {
                    createUserAlert.mutate({ ticker: ticker.toUpperCase(), type, value });
                    e.currentTarget.reset();
                  }
                }} className="flex items-end gap-2 p-4 border rounded-lg">
                  <div className="flex-1">
                    <label htmlFor="ticker" className="text-sm font-medium">Ticker</label>
                    <Input id="ticker" name="ticker" placeholder="e.g., AAPL" required />
                  </div>
                  <div>
                    <label htmlFor="type" className="text-sm font-medium">Condition</label>
                    <Select id="type" name="type" required>
                      <SelectTrigger>
                        <SelectValue placeholder="Select condition" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="price_above">Price is Above</SelectItem>
                        <SelectItem value="price_below">Price is Below</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <label htmlFor="value" className="text-sm font-medium">Value</label>
                    <Input id="value" name="value" type="number" step="0.01" placeholder="e.g., 150.00" required />
                  </div>
                  <Button type="submit" disabled={createUserAlert.isPending}>
                    {createUserAlert.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add Alert"}
                  </Button>
                </form>

                {/* Active Alerts List */}
                <div>
                  <h3 className="text-lg font-semibold mb-2">Active Alerts</h3>
                  <div className="space-y-2">
                    {userDefinedAlerts && userDefinedAlerts.length > 0 ? (
                      userDefinedAlerts.map(alert => (
                        <div key={alert.id} className="flex items-center justify-between p-3 border rounded-lg bg-muted/20">
                          <div>
                            <span className="font-semibold">{alert.ticker}</span>
                            <span className="text-muted-foreground"> price is {alert.type === 'price_above' ? 'above' : 'below'} </span>
                            <span className="font-semibold">${alert.value}</span>
                          </div>
                          <Button variant="ghost" size="sm" onClick={() => deleteUserAlert.mutate({ id: alert.id })}>
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      ))
                    ) : (
                      <p className="text-muted-foreground text-sm">You have no active alerts.</p>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </main>

      <FinancialsDialog
        stock={selectedStock}
        open={!!selectedStock}
        onOpenChange={(open) => !open && setSelectedStock(null)}
      />
    </div>
  );
}

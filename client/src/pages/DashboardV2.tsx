import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { trpc } from "@/lib/trpc";
import { 
  TrendingUp, 
  TrendingDown, 
  AlertCircle, 
  Zap, 
  Target,
  Youtube,
  Sparkles,
  ArrowRight,
  Clock
} from "lucide-react";
import { getLoginUrl } from "@/const";
import { toast } from "sonner";

/**
 * Enhanced Dashboard V2 - Predictive Focus
 * Emphasizes upcoming opportunities over historical data
 */
export default function DashboardV2() {
  const { user, loading, isAuthenticated } = useAuth();

  const { data: predictions = [], refetch: refetchPredictions } = trpc.predictions.upcoming.useQuery();
  const { data: news = [] } = trpc.news.recent.useQuery();
  const { data: youtubeVideos = [] } = trpc.youtube.recentVideos.useQuery();
  const { data: alerts = [] } = trpc.alerts.list.useQuery({ unreadOnly: false });

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

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950">
        <div className="animate-pulse text-slate-400">Loading...</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950">
        <Card className="p-8 bg-slate-900/50 border-slate-800">
          <h2 className="text-2xl font-bold mb-4 text-slate-100">Sign in to continue</h2>
          <Button asChild className="bg-emerald-600 hover:bg-emerald-700">
            <a href={getLoginUrl()}>Sign In</a>
          </Button>
        </Card>
      </div>
    );
  }

  const unreadAlerts = alerts.filter(a => a.isRead === 0);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-900/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="container mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent">
              AI Trading Agent
            </h1>
            <p className="text-sm text-slate-400">Predictive Market Intelligence</p>
          </div>
          <div className="flex items-center gap-4">
            <Button
              variant="outline"
              size="sm"
              onClick={() => generatePredictions.mutate()}
              disabled={generatePredictions.isPending}
              className="border-emerald-600/50 text-emerald-400 hover:bg-emerald-600/10"
            >
              <Sparkles className="w-4 h-4 mr-2" />
              {generatePredictions.isPending ? "Analyzing..." : "Generate Predictions"}
            </Button>
            {unreadAlerts.length > 0 && (
              <div className="relative">
                <AlertCircle className="w-5 h-5 text-amber-400" />
                <span className="absolute -top-1 -right-1 bg-amber-500 text-xs rounded-full w-4 h-4 flex items-center justify-center text-white">
                  {unreadAlerts.length}
                </span>
              </div>
            )}
            <div className="text-sm text-slate-300">{user?.name}</div>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-6 py-8">
        {/* Predicted Rallies - Hero Section */}
        <section className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-2xl font-bold text-slate-100 flex items-center gap-2">
                <Target className="w-6 h-6 text-emerald-400" />
                Predicted Rallies
              </h2>
              <p className="text-slate-400 text-sm">Opportunities 2-3 weeks ahead of the market</p>
            </div>
          </div>

          {predictions.length === 0 ? (
            <Card className="p-8 bg-slate-900/50 border-slate-800 text-center">
              <Zap className="w-12 h-12 text-slate-600 mx-auto mb-4" />
              <p className="text-slate-400 mb-4">No predictions yet. Click "Generate Predictions" to analyze current market patterns.</p>
            </Card>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {predictions.map((pred: any) => {
                const confidence = pred.predictionConfidence || 0;
                const confidenceColor = 
                  confidence >= 75 ? "text-emerald-400 border-emerald-600/50 bg-emerald-950/30" :
                  confidence >= 60 ? "text-cyan-400 border-cyan-600/50 bg-cyan-950/30" :
                  "text-amber-400 border-amber-600/50 bg-amber-950/30";

                return (
                  <Card key={pred.id} className={`p-6 border ${confidenceColor} transition-all hover:scale-105`}>
                    <div className="flex items-start justify-between mb-3">
                      <Badge variant="outline" className="border-current">
                        {pred.sector}
                      </Badge>
                      <div className="text-right">
                        <div className="text-2xl font-bold">{confidence}%</div>
                        <div className="text-xs opacity-75">confidence</div>
                      </div>
                    </div>
                    <h3 className="font-semibold text-lg mb-2 text-slate-100">{pred.name}</h3>
                    <p className="text-sm opacity-90 mb-4 line-clamp-2">{pred.description}</p>
                    
                    {pred.earlySignals && (
                      <div className="mb-3">
                        <div className="text-xs font-medium mb-1 opacity-75">Early Signals:</div>
                        <div className="flex flex-wrap gap-1">
                          {JSON.parse(pred.earlySignals).slice(0, 2).map((signal: string, i: number) => (
                            <Badge key={i} variant="secondary" className="text-xs">
                              {signal}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}

                    <Button size="sm" variant="ghost" className="w-full mt-2 group">
                      View Details
                      <ArrowRight className="w-4 h-4 ml-2 group-hover:translate-x-1 transition-transform" />
                    </Button>
                  </Card>
                );
              })}
            </div>
          )}
        </section>

        {/* Tabs for News, YouTube, Alerts */}
        <Tabs defaultValue="news" className="w-full">
          <TabsList className="bg-slate-900/50 border border-slate-800">
            <TabsTrigger value="news">Market News</TabsTrigger>
            <TabsTrigger value="youtube">
              <Youtube className="w-4 h-4 mr-2" />
              Influencers
            </TabsTrigger>
            <TabsTrigger value="alerts">
              Alerts {unreadAlerts.length > 0 && `(${unreadAlerts.length})`}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="news" className="mt-6">
            <div className="grid gap-4">
              {news.slice(0, 10).map((article: any) => (
                <Card key={article.id} className="p-5 bg-slate-900/50 border-slate-800 hover:border-slate-700 transition-colors">
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex-1">
                      <h3 className="font-semibold text-slate-100 mb-1">{article.title}</h3>
                      <p className="text-sm text-slate-400 mb-3">{article.aiSummary || article.summary}</p>
                      <div className="flex items-center gap-2 text-xs text-slate-500">
                        <span>{article.source}</span>
                        <span>•</span>
                        <Clock className="w-3 h-3" />
                        <span>{new Date(article.publishedAt).toLocaleDateString()}</span>
                      </div>
                    </div>
                    <div className="ml-4">
                      {article.sentiment === "bullish" && (
                        <Badge className="bg-emerald-600/20 text-emerald-400 border-emerald-600/50">
                          <TrendingUp className="w-3 h-3 mr-1" />
                          Bullish
                        </Badge>
                      )}
                      {article.sentiment === "bearish" && (
                        <Badge className="bg-red-600/20 text-red-400 border-red-600/50">
                          <TrendingDown className="w-3 h-3 mr-1" />
                          Bearish
                        </Badge>
                      )}
                      {article.sentiment === "neutral" && (
                        <Badge variant="secondary">Neutral</Badge>
                      )}
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </TabsContent>

          <TabsContent value="youtube" className="mt-6">
            <div className="mb-4 flex justify-end">
              <Button
                variant="outline"
                size="sm"
                onClick={() => syncYouTube.mutate()}
                disabled={syncYouTube.isPending}
                className="border-red-600/50 text-red-400 hover:bg-red-600/10"
              >
                <Youtube className="w-4 h-4 mr-2" />
                {syncYouTube.isPending ? "Syncing..." : "Sync Videos"}
              </Button>
            </div>

            <div className="grid gap-4">
              {youtubeVideos.map((item: any) => {
                const video = item.video;
                return (
                  <Card key={video.id} className="p-5 bg-slate-900/50 border-slate-800">
                    <div className="flex gap-4">
                      <div className="flex-shrink-0">
                        <div className="w-32 h-20 bg-slate-800 rounded flex items-center justify-center">
                          <Youtube className="w-8 h-8 text-red-500" />
                        </div>
                      </div>
                      <div className="flex-1">
                        <h3 className="font-semibold text-slate-100 mb-1">{video.title}</h3>
                        <p className="text-sm text-slate-400 mb-2 line-clamp-2">{video.aiSummary}</p>
                        <div className="flex items-center gap-2 text-xs text-slate-500">
                          <span>{item.influencer?.channelName || "Unknown Channel"}</span>
                          <span>•</span>
                          <span>{new Date(video.publishedAt).toLocaleDateString()}</span>
                        </div>
                      </div>
                    </div>
                  </Card>
                );
              })}

              {youtubeVideos.length === 0 && (
                <Card className="p-8 bg-slate-900/50 border-slate-800 text-center">
                  <Youtube className="w-12 h-12 text-slate-600 mx-auto mb-4" />
                  <p className="text-slate-400">No YouTube videos yet. Click "Sync Videos" to load influencer content.</p>
                </Card>
              )}
            </div>
          </TabsContent>

          <TabsContent value="alerts" className="mt-6">
            <div className="grid gap-4">
              {alerts.map((alert: any) => (
                <Card key={alert.id} className={`p-5 ${alert.isRead === 0 ? 'bg-amber-950/20 border-amber-600/50' : 'bg-slate-900/50 border-slate-800'}`}>
                  <div className="flex items-start gap-3">
                    <AlertCircle className={`w-5 h-5 flex-shrink-0 ${alert.isRead === 0 ? 'text-amber-400' : 'text-slate-500'}`} />
                    <div className="flex-1">
                      <h3 className="font-semibold text-slate-100 mb-1">{alert.title}</h3>
                      <p className="text-sm text-slate-400">{alert.content}</p>
                      <div className="text-xs text-slate-500 mt-2">
                        {new Date(alert.createdAt).toLocaleString()}
                      </div>
                    </div>
                  </div>
                </Card>
              ))}

              {alerts.length === 0 && (
                <Card className="p-8 bg-slate-900/50 border-slate-800 text-center">
                  <AlertCircle className="w-12 h-12 text-slate-600 mx-auto mb-4" />
                  <p className="text-slate-400">No alerts yet.</p>
                </Card>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { Loader2, TrendingUp, TrendingDown, Target, CheckCircle, XCircle, MinusCircle } from "lucide-react";

export default function PerformanceAnalytics() {
  const { data: performanceStats, isLoading } = trpc.predictions.getPerformance.useQuery();
  const { data: predictions = [] } = trpc.predictions.upcoming.useQuery();

  if (isLoading) {
    return (
      <div className="container mx-auto p-6">
        <div className="flex justify-center py-12">
          <Loader2 className="h-12 w-12 animate-spin text-primary" />
        </div>
      </div>
    );
  }

  const accuracy = performanceStats && performanceStats.total > 0
    ? ((performanceStats.success / (performanceStats.success + performanceStats.failure)) * 100).toFixed(1)
    : "N/A";

  // Calculate stats by sector
  const sectorStats = new Map<string, { success: number; failure: number; neutral: number; total: number }>();
  const timeframeStats = new Map<string, { success: number; failure: number; neutral: number; total: number }>();
  const opportunityTypeStats = { call: { success: 0, failure: 0, neutral: 0, total: 0 }, put: { success: 0, failure: 0, neutral: 0, total: 0 } };

  predictions.forEach((pred: any) => {
    if (!pred.predictionOutcome || pred.predictionOutcome === "pending") return;

    const sector = pred.sector || "Unknown";
    const catalysts = pred.catalysts ? JSON.parse(pred.catalysts) : {};
    const timeframe = catalysts.timeframe || "Unknown";
    const opportunityType = catalysts.opportunityType || "call";

    // Sector stats
    if (!sectorStats.has(sector)) {
      sectorStats.set(sector, { success: 0, failure: 0, neutral: 0, total: 0 });
    }
    const sectorStat = sectorStats.get(sector)!;
    sectorStat.total++;
    if (pred.predictionOutcome === "success") sectorStat.success++;
    else if (pred.predictionOutcome === "failure") sectorStat.failure++;
    else sectorStat.neutral++;

    // Timeframe stats
    if (!timeframeStats.has(timeframe)) {
      timeframeStats.set(timeframe, { success: 0, failure: 0, neutral: 0, total: 0 });
    }
    const timeframeStat = timeframeStats.get(timeframe)!;
    timeframeStat.total++;
    if (pred.predictionOutcome === "success") timeframeStat.success++;
    else if (pred.predictionOutcome === "failure") timeframeStat.failure++;
    else timeframeStat.neutral++;

    // Opportunity type stats
    const typeStat = opportunityTypeStats[opportunityType as keyof typeof opportunityTypeStats];
    if (typeStat) {
      typeStat.total++;
      if (pred.predictionOutcome === "success") typeStat.success++;
      else if (pred.predictionOutcome === "failure") typeStat.failure++;
      else typeStat.neutral++;
    }
  });

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold mb-2">Performance Analytics</h1>
        <p className="text-muted-foreground">Detailed breakdown of AI prediction accuracy</p>
      </div>

      {/* Overall Performance */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Overall Accuracy</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-green-600">{accuracy}%</div>
            <p className="text-xs text-muted-foreground mt-1">
              {performanceStats?.success || 0} wins / {performanceStats?.failure || 0} losses
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Successful Predictions</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <CheckCircle className="h-5 w-5 text-green-500" />
              <div className="text-3xl font-bold">{performanceStats?.success || 0}</div>
            </div>
            <p className="text-xs text-muted-foreground mt-1">Predictions that hit target</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Failed Predictions</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <XCircle className="h-5 w-5 text-red-500" />
              <div className="text-3xl font-bold">{performanceStats?.failure || 0}</div>
            </div>
            <p className="text-xs text-muted-foreground mt-1">Predictions that missed</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Neutral/Pending</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <MinusCircle className="h-5 w-5 text-gray-500" />
              <div className="text-3xl font-bold">{performanceStats?.neutral || 0}</div>
            </div>
            <p className="text-xs text-muted-foreground mt-1">Within ±2% range</p>
          </CardContent>
        </Card>
      </div>

      {/* Performance by Sector */}
      <Card>
        <CardHeader>
          <CardTitle>Performance by Sector</CardTitle>
          <CardDescription>Which sectors have the highest accuracy?</CardDescription>
        </CardHeader>
        <CardContent>
          {sectorStats.size === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <p>No sector data available yet. Generate more predictions and wait for backtesting results.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {Array.from(sectorStats.entries())
                .sort((a, b) => {
                  const accuracyA = a[1].total > 0 ? a[1].success / (a[1].success + a[1].failure) : 0;
                  const accuracyB = b[1].total > 0 ? b[1].success / (b[1].success + b[1].failure) : 0;
                  return accuracyB - accuracyA;
                })
                .map(([sector, stats]) => {
                  const sectorAccuracy = stats.total > 0
                    ? ((stats.success / (stats.success + stats.failure)) * 100).toFixed(1)
                    : "N/A";
                  return (
                    <div key={sector} className="p-4 border rounded-lg">
                      <div className="flex items-center justify-between mb-2">
                        <div className="font-semibold">{sector}</div>
                        <Badge variant={parseFloat(sectorAccuracy) >= 70 ? "default" : "secondary"}>
                          {sectorAccuracy}% Accuracy
                        </Badge>
                      </div>
                      <div className="grid grid-cols-3 gap-2 text-sm">
                        <div>
                          <span className="text-green-600">✓ {stats.success}</span> wins
                        </div>
                        <div>
                          <span className="text-red-600">✗ {stats.failure}</span> losses
                        </div>
                        <div>
                          <span className="text-gray-600">− {stats.neutral}</span> neutral
                        </div>
                      </div>
                    </div>
                  );
                })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Performance by Timeframe */}
      <Card>
        <CardHeader>
          <CardTitle>Performance by Timeframe</CardTitle>
          <CardDescription>Are short-term or long-term predictions more accurate?</CardDescription>
        </CardHeader>
        <CardContent>
          {timeframeStats.size === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <p>No timeframe data available yet.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {Array.from(timeframeStats.entries()).map(([timeframe, stats]) => {
                const accuracy = stats.total > 0
                  ? ((stats.success / (stats.success + stats.failure)) * 100).toFixed(1)
                  : "N/A";
                return (
                  <div key={timeframe} className="p-4 border rounded-lg">
                    <div className="font-semibold mb-2">{timeframe}</div>
                    <div className="text-2xl font-bold text-green-600 mb-2">{accuracy}%</div>
                    <div className="text-sm text-muted-foreground">
                      {stats.success}W / {stats.failure}L / {stats.neutral}N
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Performance by Opportunity Type */}
      <Card>
        <CardHeader>
          <CardTitle>CALL vs PUT Performance</CardTitle>
          <CardDescription>Are bullish or bearish predictions more accurate?</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="p-4 border border-green-200 dark:border-green-900 rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                <TrendingUp className="h-5 w-5 text-green-500" />
                <div className="font-semibold">CALL (Bullish) Predictions</div>
              </div>
              <div className="text-3xl font-bold text-green-600 mb-2">
                {opportunityTypeStats.call.total > 0
                  ? ((opportunityTypeStats.call.success / (opportunityTypeStats.call.success + opportunityTypeStats.call.failure)) * 100).toFixed(1)
                  : "N/A"}%
              </div>
              <div className="text-sm text-muted-foreground">
                {opportunityTypeStats.call.success} wins / {opportunityTypeStats.call.failure} losses / {opportunityTypeStats.call.neutral} neutral
              </div>
            </div>

            <div className="p-4 border border-red-200 dark:border-red-900 rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                <TrendingDown className="h-5 w-5 text-red-500" />
                <div className="font-semibold">PUT (Bearish) Predictions</div>
              </div>
              <div className="text-3xl font-bold text-red-600 mb-2">
                {opportunityTypeStats.put.total > 0
                  ? ((opportunityTypeStats.put.success / (opportunityTypeStats.put.success + opportunityTypeStats.put.failure)) * 100).toFixed(1)
                  : "N/A"}%
              </div>
              <div className="text-sm text-muted-foreground">
                {opportunityTypeStats.put.success} wins / {opportunityTypeStats.put.failure} losses / {opportunityTypeStats.put.neutral} neutral
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ROI Calculator */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Target className="h-5 w-5" />
            Hypothetical ROI Calculator
          </CardTitle>
          <CardDescription>If you invested $1,000 in each prediction...</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="p-4 bg-green-50 dark:bg-green-950/20 rounded-lg">
              <div className="text-sm text-muted-foreground mb-1">Total Invested</div>
              <div className="text-2xl font-bold">
                ${((performanceStats?.total || 0) * 1000).toLocaleString()}
              </div>
            </div>
            <div className="p-4 bg-blue-50 dark:bg-blue-950/20 rounded-lg">
              <div className="text-sm text-muted-foreground mb-1">Estimated Returns (5% avg gain)</div>
              <div className="text-2xl font-bold text-green-600">
                +${((performanceStats?.success || 0) * 1000 * 0.05).toLocaleString()}
              </div>
            </div>
            <div className="p-4 bg-purple-50 dark:bg-purple-950/20 rounded-lg">
              <div className="text-sm text-muted-foreground mb-1">Net Profit/Loss</div>
              <div className={`text-2xl font-bold ${((performanceStats?.success || 0) - (performanceStats?.failure || 0)) * 50 >= 0 ? "text-green-600" : "text-red-600"}`}>
                {((performanceStats?.success || 0) - (performanceStats?.failure || 0)) * 50 >= 0 ? "+" : ""}
                ${(((performanceStats?.success || 0) - (performanceStats?.failure || 0)) * 50).toLocaleString()}
              </div>
            </div>
          </div>
          <p className="text-xs text-muted-foreground mt-4">
            * Hypothetical calculation assuming 5% gain per successful prediction and 100% loss per failed prediction.
            Actual returns may vary based on entry/exit timing and position sizing.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

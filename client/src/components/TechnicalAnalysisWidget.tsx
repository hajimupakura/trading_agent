import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { TrendingUp, TrendingDown, Loader2 } from "lucide-react";

interface TechnicalAnalysisWidgetProps {
  ticker: string;
  name?: string;
}

export function TechnicalAnalysisWidget({ ticker, name }: TechnicalAnalysisWidgetProps) {
  const now = Date.now();
  const ninetyDaysAgo = now - 90 * 24 * 60 * 60 * 1000;
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

  const { data: sma20, isLoading: sma20Loading } = trpc.ta.getSMA.useQuery({
    symbol: ticker,
    interval: "D",
    period: 20,
    from: Math.floor(ninetyDaysAgo / 1000),
    to: Math.floor(now / 1000),
  });

  const { data: sma50, isLoading: sma50Loading } = trpc.ta.getSMA.useQuery({
    symbol: ticker,
    interval: "D",
    period: 50,
    from: Math.floor(ninetyDaysAgo / 1000),
    to: Math.floor(now / 1000),
  });

  const { data: rsi, isLoading: rsiLoading } = trpc.ta.getRSI.useQuery({
    symbol: ticker,
    interval: "D",
    period: 14,
    from: Math.floor(thirtyDaysAgo / 1000),
    to: Math.floor(now / 1000),
  });

  const loading = sma20Loading || sma50Loading || rsiLoading;

  if (loading) {
    return (
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="text-base">{ticker} Technical Analysis</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex justify-center py-4">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        </CardContent>
      </Card>
    );
  }

  const latestSMA20 = sma20?.values ? Array.from(sma20.values()).pop()?.value : undefined;
  const latestSMA50 = sma50?.values ? Array.from(sma50.values()).pop()?.value : undefined;
  const latestRSI = rsi?.values ? Array.from(rsi.values()).pop()?.value : undefined;

  // Determine RSI signal
  let rsiSignal: "overbought" | "oversold" | "neutral" = "neutral";
  let rsiColor = "text-muted-foreground";
  if (latestRSI !== undefined) {
    if (latestRSI > 70) {
      rsiSignal = "overbought";
      rsiColor = "text-red-500";
    } else if (latestRSI < 30) {
      rsiSignal = "oversold";
      rsiColor = "text-green-500";
    }
  }

  // Determine SMA crossover signal
  let smaSignal: "bullish" | "bearish" | "neutral" = "neutral";
  if (latestSMA20 !== undefined && latestSMA50 !== undefined) {
    if (latestSMA20 > latestSMA50) {
      smaSignal = "bullish";
    } else {
      smaSignal = "bearish";
    }
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          {ticker} Technical Analysis
          {smaSignal === "bullish" && <TrendingUp className="h-4 w-4 text-green-500" />}
          {smaSignal === "bearish" && <TrendingDown className="h-4 w-4 text-red-500" />}
        </CardTitle>
        {name && <CardDescription className="text-xs">{name}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-3">
        {/* SMA Indicators */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">SMA(20)</div>
            <div className="text-lg font-bold">
              {latestSMA20 !== undefined ? `$${latestSMA20.toFixed(2)}` : "N/A"}
            </div>
          </div>
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">SMA(50)</div>
            <div className="text-lg font-bold">
              {latestSMA50 !== undefined ? `$${latestSMA50.toFixed(2)}` : "N/A"}
            </div>
          </div>
        </div>

        {/* RSI Indicator */}
        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">RSI(14)</div>
          <div className="flex items-center gap-2">
            <div className={`text-lg font-bold ${rsiColor}`}>
              {latestRSI !== undefined ? latestRSI.toFixed(1) : "N/A"}
            </div>
            {rsiSignal !== "neutral" && (
              <Badge variant={rsiSignal === "overbought" ? "destructive" : "default"} className="text-xs">
                {rsiSignal === "overbought" ? "🔴 Overbought" : "🟢 Oversold"}
              </Badge>
            )}
          </div>
        </div>

        {/* Trading Signal */}
        {smaSignal !== "neutral" && (
          <div className="pt-2 border-t">
            <div className="text-xs text-muted-foreground mb-1">Signal</div>
            <Badge variant={smaSignal === "bullish" ? "default" : "outline"} className="text-xs">
              {smaSignal === "bullish" ? "📈 Bullish Trend (SMA 20 > 50)" : "📉 Bearish Trend (SMA 20 < 50)"}
            </Badge>
          </div>
        )}

        {/* Trading Recommendation */}
        {latestRSI !== undefined && (
          <div className="text-xs p-2 bg-muted/50 rounded">
            <span className="font-medium">Recommendation: </span>
            {rsiSignal === "overbought" && smaSignal === "bearish" && (
              <span className="text-red-600">Consider taking profits or wait for pullback</span>
            )}
            {rsiSignal === "oversold" && smaSignal === "bullish" && (
              <span className="text-green-600">Strong buy signal - oversold in bullish trend</span>
            )}
            {rsiSignal === "oversold" && smaSignal !== "bullish" && (
              <span className="text-yellow-600">Potential bounce but trend is weak</span>
            )}
            {rsiSignal === "overbought" && smaSignal === "bullish" && (
              <span className="text-yellow-600">Trend is strong but overbought - watch for reversal</span>
            )}
            {rsiSignal === "neutral" && (
              <span className="text-muted-foreground">No strong signal - monitor for entry/exit opportunities</span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

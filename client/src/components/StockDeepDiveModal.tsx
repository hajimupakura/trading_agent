import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { Loader2, TrendingUp, TrendingDown, ExternalLink } from "lucide-react";
import { TechnicalAnalysisWidget } from "./TechnicalAnalysisWidget";

interface StockDeepDiveModalProps {
  ticker: string;
  name?: string;
  open: boolean;
  onClose: () => void;
}

export function StockDeepDiveModal({ ticker, name, open, onClose }: StockDeepDiveModalProps) {
  const { data: financials, isLoading: financialsLoading } = trpc.stocks.getFinancials.useQuery(
    { symbol: ticker },
    { enabled: open }
  );

  const { data: quote, isLoading: quoteLoading } = trpc.stocks.getQuote.useQuery(
    { symbol: ticker },
    { enabled: open }
  );

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-2xl">
            {ticker}
            {name && <span className="text-base text-muted-foreground font-normal">• {name}</span>}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => window.open(`https://finance.yahoo.com/quote/${ticker}`, "_blank")}
            >
              <ExternalLink className="h-4 w-4" />
            </Button>
          </DialogTitle>
          <DialogDescription>
            Comprehensive analysis and key metrics
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Current Price & Change */}
          {quoteLoading ? (
            <div className="flex justify-center py-4">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          ) : quote && (
            <div className="flex items-baseline gap-4">
              <div className="text-4xl font-bold">${quote.currentPrice.toFixed(2)}</div>
              {quote.change !== undefined && (
                <div className={`flex items-center gap-1 text-lg ${quote.change >= 0 ? "text-green-600" : "text-red-600"}`}>
                  {quote.change >= 0 ? <TrendingUp className="h-5 w-5" /> : <TrendingDown className="h-5 w-5" />}
                  <span>{quote.change >= 0 ? "+" : ""}{quote.change.toFixed(2)} ({quote.changePercent?.toFixed(2)}%)</span>
                </div>
              )}
            </div>
          )}

          {/* Key Financials */}
          {financialsLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : financials ? (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <div className="p-4 border rounded-lg">
                <div className="text-xs text-muted-foreground mb-1">Market Cap</div>
                <div className="text-xl font-bold">{formatMarketCap(financials.marketCap)}</div>
              </div>
              <div className="p-4 border rounded-lg">
                <div className="text-xs text-muted-foreground mb-1">P/E Ratio</div>
                <div className="text-xl font-bold">{financials.peRatio || "N/A"}</div>
              </div>
              <div className="p-4 border rounded-lg">
                <div className="text-xs text-muted-foreground mb-1">EPS</div>
                <div className="text-xl font-bold">${financials.eps || "N/A"}</div>
              </div>
              <div className="p-4 border rounded-lg">
                <div className="text-xs text-muted-foreground mb-1">Dividend Yield</div>
                <div className="text-xl font-bold">{financials.dividendYield ? `${financials.dividendYield}%` : "N/A"}</div>
              </div>
              <div className="p-4 border rounded-lg">
                <div className="text-xs text-muted-foreground mb-1">Beta</div>
                <div className="text-xl font-bold">{financials.beta || "N/A"}</div>
              </div>
              <div className="p-4 border rounded-lg">
                <div className="text-xs text-muted-foreground mb-1">52-Week Range</div>
                <div className="text-sm font-bold">
                  ${financials.low52Week} - ${financials.high52Week}
                </div>
              </div>
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              <p>No financial data available for {ticker}</p>
            </div>
          )}

          {/* Technical Analysis */}
          <TechnicalAnalysisWidget ticker={ticker} name={name} />

          {/* Quick Insights */}
          {financials && (
            <div className="p-4 bg-muted/50 rounded-lg space-y-2">
              <div className="font-semibold mb-2">Quick Insights</div>
              {financials.peRatio && (
                <div className="text-sm">
                  <span className="font-medium">Valuation: </span>
                  {parseFloat(financials.peRatio) > 30 ? (
                    <Badge variant="outline" className="ml-1">High P/E (possibly overvalued)</Badge>
                  ) : parseFloat(financials.peRatio) < 15 ? (
                    <Badge variant="default" className="ml-1">Low P/E (potentially undervalued)</Badge>
                  ) : (
                    <Badge variant="secondary" className="ml-1">Moderate P/E</Badge>
                  )}
                </div>
              )}
              {financials.beta && (
                <div className="text-sm">
                  <span className="font-medium">Volatility: </span>
                  {parseFloat(financials.beta) > 1.5 ? (
                    <Badge variant="destructive" className="ml-1">High Beta (Very Volatile)</Badge>
                  ) : parseFloat(financials.beta) > 1 ? (
                    <Badge variant="outline" className="ml-1">Above Market Volatility</Badge>
                  ) : parseFloat(financials.beta) < 0.5 ? (
                    <Badge variant="default" className="ml-1">Low Beta (Stable)</Badge>
                  ) : (
                    <Badge variant="secondary" className="ml-1">Moderate Volatility</Badge>
                  )}
                </div>
              )}
              {financials.dividendYield && parseFloat(financials.dividendYield) > 0 && (
                <div className="text-sm">
                  <span className="font-medium">Income: </span>
                  {parseFloat(financials.dividendYield) > 4 ? (
                    <Badge variant="default" className="ml-1">High Dividend Yield</Badge>
                  ) : (
                    <Badge variant="secondary" className="ml-1">Dividend Paying</Badge>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function formatMarketCap(marketCap: string | number): string {
  const value = typeof marketCap === "string" ? parseFloat(marketCap) : marketCap;
  if (isNaN(value)) return "N/A";

  if (value >= 1_000_000_000_000) {
    return `$${(value / 1_000_000_000_000).toFixed(2)}T`;
  } else if (value >= 1_000_000_000) {
    return `$${(value / 1_000_000_000).toFixed(2)}B`;
  } else if (value >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(2)}M`;
  } else {
    return `$${value.toLocaleString()}`;
  }
}

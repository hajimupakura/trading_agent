import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { Loader2, Filter, X } from "lucide-react";
import { StockDeepDiveModal } from "@/components/StockDeepDiveModal";

export default function StockScreener() {
  const [minMarketCap, setMinMarketCap] = useState<number>();
  const [maxPeRatio, setMaxPeRatio] = useState<number>();
  const [sector, setSector] = useState<string>();
  const [selectedStock, setSelectedStock] = useState<{ ticker: string; name?: string } | null>(null);

  const { data: results, isLoading, refetch } = trpc.stocks.screener.useQuery(
    {
      minMarketCap,
      maxPeRatio,
      sector,
    },
    { enabled: false } // Don't auto-fetch, wait for user action
  );

  const handleSearch = () => {
    refetch();
  };

  const handlePreset = (preset: "ai_chips" | "tech_value" | "energy_growth" | "high_yield") => {
    switch (preset) {
      case "ai_chips":
        setMinMarketCap(10_000_000_000); // $10B+
        setMaxPeRatio(50);
        setSector("Semiconductors");
        break;
      case "tech_value":
        setMinMarketCap(1_000_000_000); // $1B+
        setMaxPeRatio(20);
        setSector("Technology");
        break;
      case "energy_growth":
        setMinMarketCap(5_000_000_000); // $5B+
        setMaxPeRatio(30);
        setSector("Energy");
        break;
      case "high_yield":
        setMinMarketCap(1_000_000_000); // $1B+
        setMaxPeRatio(undefined);
        setSector(undefined);
        break;
    }
    setTimeout(() => refetch(), 100);
  };

  const handleReset = () => {
    setMinMarketCap(undefined);
    setMaxPeRatio(undefined);
    setSector(undefined);
  };

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold mb-2">Stock Screener</h1>
        <p className="text-muted-foreground">Find undervalued stocks in your priority sectors</p>
      </div>

      {/* Preset Filters */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Quick Filters</CardTitle>
          <CardDescription>Pre-configured screens for common strategies</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => handlePreset("ai_chips")}>
              🤖 AI & Chip Stocks (P/E &lt; 50, $10B+)
            </Button>
            <Button variant="outline" onClick={() => handlePreset("tech_value")}>
              💻 Value Tech (P/E &lt; 20, $1B+)
            </Button>
            <Button variant="outline" onClick={() => handlePreset("energy_growth")}>
              ⚡ Energy Growth (P/E &lt; 30, $5B+)
            </Button>
            <Button variant="outline" onClick={() => handlePreset("high_yield")}>
              💰 High Dividend Yield
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Custom Filters */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Filter className="h-5 w-5" />
            Custom Filters
          </CardTitle>
          <CardDescription>Build your own screening criteria</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label htmlFor="minMarketCap">Min Market Cap ($)</Label>
              <Input
                id="minMarketCap"
                type="number"
                placeholder="e.g., 1000000000"
                value={minMarketCap || ""}
                onChange={(e) => setMinMarketCap(e.target.value ? parseFloat(e.target.value) : undefined)}
              />
              <p className="text-xs text-muted-foreground">
                Example: 1B = 1,000,000,000
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="maxPeRatio">Max P/E Ratio</Label>
              <Input
                id="maxPeRatio"
                type="number"
                placeholder="e.g., 30"
                value={maxPeRatio || ""}
                onChange={(e) => setMaxPeRatio(e.target.value ? parseFloat(e.target.value) : undefined)}
              />
              <p className="text-xs text-muted-foreground">
                Lower P/E = potentially undervalued
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="sector">Sector</Label>
              <Input
                id="sector"
                type="text"
                placeholder="e.g., Technology"
                value={sector || ""}
                onChange={(e) => setSector(e.target.value || undefined)}
              />
              <p className="text-xs text-muted-foreground">
                AI, Semiconductors, Energy, etc.
              </p>
            </div>
          </div>

          <div className="flex gap-2">
            <Button onClick={handleSearch} disabled={isLoading}>
              {isLoading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Searching...
                </>
              ) : (
                <>
                  <Filter className="h-4 w-4 mr-2" />
                  Search Stocks
                </>
              )}
            </Button>
            <Button variant="outline" onClick={handleReset}>
              <X className="h-4 w-4 mr-2" />
              Reset
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Results */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            Results {results && `(${results.length} stocks found)`}
          </CardTitle>
          <CardDescription>Click on any stock for detailed analysis</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : results && results.length > 0 ? (
            <div className="grid gap-3">
              {results.map((stock: any) => (
                <div
                  key={stock.ticker}
                  className="p-4 border rounded-lg hover:border-primary/50 cursor-pointer transition-colors"
                  onClick={() => setSelectedStock({ ticker: stock.ticker, name: stock.ticker })}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="font-bold text-lg">{stock.ticker}</div>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-2 text-sm">
                        <div>
                          <span className="text-muted-foreground">Market Cap: </span>
                          <span className="font-medium">{formatMarketCap(stock.marketCap)}</span>
                        </div>
                        {stock.peRatio && (
                          <div>
                            <span className="text-muted-foreground">P/E: </span>
                            <span className="font-medium">{stock.peRatio}</span>
                          </div>
                        )}
                        {stock.eps && (
                          <div>
                            <span className="text-muted-foreground">EPS: </span>
                            <span className="font-medium">${stock.eps}</span>
                          </div>
                        )}
                        {stock.dividendYield && parseFloat(stock.dividendYield) > 0 && (
                          <div>
                            <span className="text-muted-foreground">Div Yield: </span>
                            <span className="font-medium">{stock.dividendYield}%</span>
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-col gap-1 items-end">
                      {stock.peRatio && parseFloat(stock.peRatio) < 15 && (
                        <Badge variant="default" className="text-xs">Value</Badge>
                      )}
                      {stock.dividendYield && parseFloat(stock.dividendYield) > 4 && (
                        <Badge variant="secondary" className="text-xs">High Yield</Badge>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : results && results.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <p>No stocks match your criteria. Try adjusting your filters.</p>
            </div>
          ) : (
            <div className="text-center py-12 text-muted-foreground">
              <p>Use the filters above to search for stocks</p>
            </div>
          )}
        </CardContent>
      </Card>

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

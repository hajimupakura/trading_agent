import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Card } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Search, TrendingUp, Loader2, Network, ArrowRight } from "lucide-react";

interface RelatedStock {
  ticker: string;
  companyName?: string;
  relationshipType: string;
  strengthScore: number;
  description: string;
  newsEvidence?: string;
  historicalCorrelation?: string;
}

const relationshipColors: Record<string, string> = {
  competitor: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
  supplier: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  customer: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  supply_chain: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
  complementary: "bg-pink-100 text-pink-800 dark:bg-pink-900 dark:text-pink-200",
  sector_peer: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200",
};

const relationshipLabels: Record<string, string> = {
  competitor: "Competitor",
  supplier: "Supplier",
  customer: "Customer",
  supply_chain: "Supply Chain",
  complementary: "Complementary",
  sector_peer: "Sector Peer",
};

export default function StockAnalyzer() {
  const [ticker, setTicker] = useState("");
  const [searchedTicker, setSearchedTicker] = useState("");

  const analyzeRelatedStocks = trpc.relatedStocks.analyze.useMutation();

  const handleAnalyze = async () => {
    if (!ticker.trim()) return;
    setSearchedTicker(ticker.toUpperCase());
    await analyzeRelatedStocks.mutateAsync({ 
      ticker: ticker.toUpperCase(),
      forceRefresh: true,
    });
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleAnalyze();
    }
  };

  const getStrengthColor = (score: number) => {
    if (score >= 80) return "text-green-600 dark:text-green-400";
    if (score >= 60) return "text-blue-600 dark:text-blue-400";
    if (score >= 40) return "text-yellow-600 dark:text-yellow-400";
    return "text-gray-600 dark:text-gray-400";
  };

  const getStrengthLabel = (score: number) => {
    if (score >= 80) return "Very Strong";
    if (score >= 60) return "Strong";
    if (score >= 40) return "Moderate";
    return "Weak";
  };

  return (
    <div className="container mx-auto p-6 max-w-7xl">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2 flex items-center gap-3">
          <Network className="h-8 w-8 text-primary" />
          Stock Relationship Analyzer
        </h1>
        <p className="text-muted-foreground">
          Discover stocks that may be affected by the movement of any company. Analyze supply chains, competitors, and complementary businesses.
        </p>
      </div>

      {/* Search Bar */}
      <Card className="p-6 mb-8">
        <div className="flex gap-4">
          <div className="flex-1">
            <Input
              type="text"
              placeholder="Enter stock ticker (e.g., NVDA, TSLA, AAPL)"
              value={ticker}
              onChange={(e) => setTicker(e.target.value.toUpperCase())}
              onKeyPress={handleKeyPress}
              className="text-lg"
            />
          </div>
          <Button 
            onClick={handleAnalyze}
            disabled={analyzeRelatedStocks.isLoading || !ticker.trim()}
            size="lg"
          >
            {analyzeRelatedStocks.isLoading ? (
              <>
                <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                Analyzing...
              </>
            ) : (
              <>
                <Search className="h-5 w-5 mr-2" />
                Analyze
              </>
            )}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground mt-3">
          AI will analyze recent news, supply chains, and market relationships to find connected stocks.
        </p>
      </Card>

      {/* Results */}
      {analyzeRelatedStocks.isSuccess && analyzeRelatedStocks.data && (
        <div className="space-y-6">
          {/* Summary */}
          <Card className="p-6 bg-primary/5 border-primary/20">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-2xl font-bold mb-1">
                  {searchedTicker}
                </h2>
                <p className="text-muted-foreground">
                  Found <span className="font-bold text-primary">{analyzeRelatedStocks.data.totalRelationships}</span> related stocks
                </p>
              </div>
              <div className="text-sm text-muted-foreground">
                Analyzed: {new Date(analyzeRelatedStocks.data.analysisTimestamp).toLocaleString()}
              </div>
            </div>
          </Card>

          {/* Related Stocks Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {analyzeRelatedStocks.data.relatedStocks.map((stock: RelatedStock, idx: number) => (
              <Card key={idx} className="p-5 hover:shadow-lg transition-shadow">
                {/* Header */}
                <div className="flex items-start justify-between mb-3">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      <h3 className="text-xl font-bold">{stock.ticker}</h3>
                      <Badge className={relationshipColors[stock.relationshipType] || "bg-gray-100"}>
                        {relationshipLabels[stock.relationshipType] || stock.relationshipType}
                      </Badge>
                    </div>
                    {stock.companyName && (
                      <p className="text-sm text-muted-foreground">{stock.companyName}</p>
                    )}
                  </div>
                  
                  {/* Strength Score */}
                  <div className="flex flex-col items-end">
                    <div className={`text-3xl font-bold ${getStrengthColor(stock.strengthScore)}`}>
                      {stock.strengthScore}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {getStrengthLabel(stock.strengthScore)}
                    </div>
                  </div>
                </div>

                {/* Description */}
                <p className="text-sm text-muted-foreground mb-3">
                  {stock.description}
                </p>

                {/* Additional Info */}
                {stock.newsEvidence && (
                  <div className="mt-3 pt-3 border-t">
                    <p className="text-xs text-muted-foreground">
                      <span className="font-semibold">News Evidence:</span> {stock.newsEvidence}
                    </p>
                  </div>
                )}

                {stock.historicalCorrelation && (
                  <div className="mt-2">
                    <p className="text-xs text-muted-foreground">
                      <span className="font-semibold">Historical Correlation:</span> {stock.historicalCorrelation}
                    </p>
                  </div>
                )}

                {/* Visual Indicator */}
                <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
                  <span>{searchedTicker}</span>
                  <ArrowRight className="h-4 w-4" />
                  <TrendingUp className="h-4 w-4 text-primary" />
                  <ArrowRight className="h-4 w-4" />
                  <span className="font-semibold">{stock.ticker}</span>
                </div>
              </Card>
            ))}
          </div>

          {/* Legend */}
          <Card className="p-6 bg-muted/30">
            <h3 className="font-bold mb-3">Relationship Types Explained</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 text-sm">
              <div>
                <Badge className={relationshipColors.competitor}>Competitor</Badge>
                <p className="mt-1 text-muted-foreground">Direct competitors in the same industry</p>
              </div>
              <div>
                <Badge className={relationshipColors.supplier}>Supplier</Badge>
                <p className="mt-1 text-muted-foreground">Companies that supply materials/services</p>
              </div>
              <div>
                <Badge className={relationshipColors.customer}>Customer</Badge>
                <p className="mt-1 text-muted-foreground">Companies that purchase products</p>
              </div>
              <div>
                <Badge className={relationshipColors.supply_chain}>Supply Chain</Badge>
                <p className="mt-1 text-muted-foreground">Broader supply chain partners</p>
              </div>
              <div>
                <Badge className={relationshipColors.complementary}>Complementary</Badge>
                <p className="mt-1 text-muted-foreground">Products that work together</p>
              </div>
              <div>
                <Badge className={relationshipColors.sector_peer}>Sector Peer</Badge>
                <p className="mt-1 text-muted-foreground">Similar companies in related sectors</p>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* Error State */}
      {analyzeRelatedStocks.isError && (
        <Card className="p-6 bg-destructive/10 border-destructive/20">
          <p className="text-destructive">
            Failed to analyze relationships. Please try again.
          </p>
        </Card>
      )}

      {/* Empty State */}
      {!analyzeRelatedStocks.data && !analyzeRelatedStocks.isLoading && (
        <Card className="p-12 text-center">
          <Network className="h-16 w-16 mx-auto mb-4 text-muted-foreground/50" />
          <h3 className="text-xl font-semibold mb-2">Ready to Analyze</h3>
          <p className="text-muted-foreground">
            Enter a stock ticker above to discover related stocks and supply chain relationships.
          </p>
        </Card>
      )}
    </div>
  );
}

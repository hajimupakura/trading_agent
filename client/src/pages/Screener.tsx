import React, { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import { Loader2 } from "lucide-react";

interface ScreenerFilters {
  minMarketCap?: number;
  maxPeRatio?: number;
  sector?: string;
}

export default function Screener() {
  const [filters, setFilters] = useState<ScreenerFilters>({});
  const [submittedFilters, setSubmittedFilters] = useState<ScreenerFilters | null>(null);

  const { data: screenerResults, isLoading } = trpc.stocks.screener.useQuery(submittedFilters || undefined, {
    enabled: !!submittedFilters,
  });

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmittedFilters(filters);
  };

  return (
    <div className="container mx-auto py-6 space-y-6">
      <header>
        <h1 className="text-3xl font-bold text-foreground">Stock Screener</h1>
        <p className="text-muted-foreground">Find stocks that match your criteria.</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSearch} className="flex items-end gap-4">
            <div>
              <label htmlFor="minMarketCap" className="text-sm font-medium">Min. Market Cap (in B)</label>
              <Input
                id="minMarketCap"
                type="number"
                placeholder="e.g., 10"
                onChange={(e) => setFilters(f => ({ ...f, minMarketCap: Number(e.target.value) * 1_000_000_000 }))}
              />
            </div>
            <div>
              <label htmlFor="maxPeRatio" className="text-sm font-medium">Max. P/E Ratio</label>
              <Input
                id="maxPeRatio"
                type="number"
                placeholder="e.g., 25"
                onChange={(e) => setFilters(f => ({ ...f, maxPeRatio: Number(e.target.value) }))}
              />
            </div>
            {/* Sector filter can be added here later */}
            <Button type="submit" disabled={isLoading}>
              {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Search"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Results</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center h-64">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : !screenerResults || screenerResults.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              {submittedFilters ? "No results found for your criteria." : "Enter criteria and click Search to see results."}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Ticker</TableHead>
                  <TableHead>Market Cap</TableHead>
                  <TableHead>P/E Ratio</TableHead>
                  <TableHead>EPS</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {screenerResults.map((stock: any) => (
                  <TableRow key={stock.ticker}>
                    <TableCell className="font-medium">{stock.ticker}</TableCell>
                    <TableCell>${(Number(stock.marketCap) / 1_000_000_000).toFixed(2)}B</TableCell>
                    <TableCell>{Number(stock.peRatio).toFixed(2)}</TableCell>
                    <TableCell>{Number(stock.eps).toFixed(2)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

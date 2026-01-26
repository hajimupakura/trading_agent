import React, { useState, useMemo } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceArea
} from "recharts";
import { trpc } from "@/lib/trpc";
import { Loader2 } from "lucide-react";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface StockChartProps {
  symbol: string;
}

const resolutions = [
  { label: "1D", value: "1", days: 1 },
  { label: "5D", value: "5", days: 5 },
  { label: "1M", value: "30", days: 30 },
  { label: "3M", value: "90", days: 90 },
  { label: "6M", value: "180", days: 180 },
  { label: "1Y", value: "D", days: 365 },
  { label: "5Y", value: "W", days: 5 * 365 },
];

const indicatorPeriods = {
  SMA: [20, 50, 200],
  RSI: [14],
};

export const StockChart: React.FC<StockChartProps> = ({ symbol }) => {
  const [selectedResolution, setSelectedResolution] = useState(resolutions[5]); // Default to 1Y
  const [selectedSMA, setSelectedSMA] = useState<number[]>([]);
  const [selectedRSI, setSelectedRSI] = useState<number[]>([]);

  const now = useMemo(() => Math.floor(Date.now() / 1000), []);
  const from = useMemo(
    () => Math.floor((Date.now() - selectedResolution.days * 24 * 60 * 60 * 1000) / 1000),
    [selectedResolution]
  );

  const { data: historicalData, isLoading: isLoadingHistorical } = trpc.stocks.getHistoricalData.useQuery(
    {
      symbol,
      resolution: selectedResolution.value,
      from,
      to: now,
    },
    { enabled: !!symbol }
  );

  const { data: sma20Data, isLoading: isLoadingSMA20 } = trpc.ta.getSMA.useQuery(
    { symbol, interval: selectedResolution.value, period: 20, from, to: now },
    { enabled: !!symbol && selectedSMA.includes(20) }
  );
  const { data: sma50Data, isLoading: isLoadingSMA50 } = trpc.ta.getSMA.useQuery(
    { symbol, interval: selectedResolution.value, period: 50, from, to: now },
    { enabled: !!symbol && selectedSMA.includes(50) }
  );
  const { data: sma200Data, isLoading: isLoadingSMA200 } = trpc.ta.getSMA.useQuery(
    { symbol, interval: selectedResolution.value, period: 200, from, to: now },
    { enabled: !!symbol && selectedSMA.includes(200) }
  );

  const { data: rsi14Data, isLoading: isLoadingRSI14 } = trpc.ta.getRSI.useQuery(
    { symbol, interval: selectedResolution.value, period: 14, from, to: now },
    { enabled: !!symbol && selectedRSI.includes(14) }
  );

  const chartData = useMemo(() => {
    if (!historicalData?.close || !historicalData?.timestamp) return [];

    return historicalData.close.map((close, index) => {
      const timestamp = historicalData.timestamp[index];
      const dataPoint: any = {
        time: format(new Date(timestamp * 1000), "yyyy-MM-dd"),
        Close: close,
      };

      if (selectedSMA.includes(20) && sma20Data) {
        const smaPoint = sma20Data.find(d => d.time === timestamp);
        if (smaPoint) dataPoint.SMA20 = smaPoint.value;
      }
      if (selectedSMA.includes(50) && sma50Data) {
        const smaPoint = sma50Data.find(d => d.time === timestamp);
        if (smaPoint) dataPoint.SMA50 = smaPoint.value;
      }
      if (selectedSMA.includes(200) && sma200Data) {
        const smaPoint = sma200Data.find(d => d.time === timestamp);
        if (smaPoint) dataPoint.SMA200 = smaPoint.value;
      }
      if (selectedRSI.includes(14) && rsi14Data) {
        const rsiPoint = rsi14Data.find(d => d.time === timestamp);
        if (rsiPoint) dataPoint.RSI14 = rsiPoint.value;
      }

      return dataPoint;
    });
  }, [
    historicalData,
    sma20Data,
    sma50Data,
    sma200Data,
    rsi14Data,
    selectedSMA,
    selectedRSI,
  ]);

  const toggleSMA = (period: number) => {
    setSelectedSMA(prev =>
      prev.includes(period) ? prev.filter(p => p !== period) : [...prev, period]
    );
  };

  const toggleRSI = (period: number) => {
    setSelectedRSI(prev =>
      prev.includes(period) ? prev.filter(p => p !== period) : [...prev, period]
    );
  };

  if (isLoadingHistorical) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!historicalData || chartData.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        No historical data available for {symbol} at {selectedResolution.label}.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Resolution Selector */}
      <div className="flex gap-2">
        {resolutions.map((res) => (
          <Button
            key={res.value}
            variant={selectedResolution.value === res.value ? "default" : "outline"}
            size="sm"
            onClick={() => setSelectedResolution(res)}
          >
            {res.label}
          </Button>
        ))}
      </div>

      {/* Indicator Selectors */}
      <div className="flex gap-4">
        <div>
          <span className="text-sm font-semibold mr-2">SMA:</span>
          {indicatorPeriods.SMA.map(period => (
            <Button
              key={`sma-${period}`}
              variant={selectedSMA.includes(period) ? "default" : "outline"}
              size="sm"
              className="ml-2"
              onClick={() => toggleSMA(period)}
            >
              {period}
            </Button>
          ))}
        </div>
        <div>
          <span className="text-sm font-semibold mr-2">RSI:</span>
          {indicatorPeriods.RSI.map(period => (
            <Button
              key={`rsi-${period}`}
              variant={selectedRSI.includes(period) ? "default" : "outline"}
              size="sm"
              className="ml-2"
              onClick={() => toggleRSI(period)}
            >
              {period}
            </Button>
          ))}
        </div>
      </div>

      {/* Main Chart */}
      <ResponsiveContainer width="100%" height={400}>
        <LineChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="time" tickFormatter={(unixTime) => format(new Date(unixTime), "MMM d yy")} />
          <YAxis domain={['auto', 'auto']} />
          <Tooltip labelFormatter={(label) => format(new Date(label), "MMM d, yyyy")} />
          <Line type="monotone" dataKey="Close" stroke="#8884d8" dot={false} name="Close Price" />
          {selectedSMA.includes(20) && <Line type="monotone" dataKey="SMA20" stroke="#82ca9d" dot={false} name="SMA 20" />}
          {selectedSMA.includes(50) && <Line type="monotone" dataKey="SMA50" stroke="#ffc658" dot={false} name="SMA 50" />}
          {selectedSMA.includes(200) && <Line type="monotone" dataKey="SMA200" stroke="#ff7300" dot={false} name="SMA 200" />}
        </LineChart>
      </ResponsiveContainer>

      {/* RSI Chart (if selected) */}
      {selectedRSI.includes(14) && rsi14Data && (
        <ResponsiveContainer width="100%" height={150}>
          <LineChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="time" hide />
            <YAxis domain={[0, 100]} />
            <Tooltip labelFormatter={(label) => format(new Date(label), "MMM d, yyyy")} />
            <ReferenceArea y1={30} y2={70} fill="#82ca9d" fillOpacity={0.1} stroke="#82ca9d" strokeDasharray="3 3" />
            <Line type="monotone" dataKey="RSI14" stroke="#d88484" dot={false} name="RSI 14" />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
};

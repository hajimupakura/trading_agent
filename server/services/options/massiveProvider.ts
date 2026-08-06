import type { MarketState, OptionContractSnapshot, OptionSide, SupportedUnderlying, UnderlyingBar } from "./types";
import type { RawOptionContract } from "./contractRanker";
import { rankOptionContracts } from "./contractRanker";

const API_BASE = "https://api.massive.com";

function etDate(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

function addDays(dateString: string, days: number): string {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function calendarDte(expiration: string, today: string): number {
  return Math.round((Date.parse(`${expiration}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000);
}

async function massiveFetch<T>(pathOrUrl: string): Promise<T> {
  const apiKey = process.env.MASSIVE_API_KEY || process.env.POLYGON_API_KEY;
  if (!apiKey) throw new Error("MASSIVE_API_KEY is not configured");
  const url = new URL(pathOrUrl.startsWith("http") ? pathOrUrl : `${API_BASE}${pathOrUrl}`);
  url.searchParams.set("apiKey", apiKey);
  const response = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`Massive API ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

export function isMassiveConfigured(): boolean {
  return Boolean(process.env.MASSIVE_API_KEY || process.env.POLYGON_API_KEY);
}

export async function getOptionChain(underlying: SupportedUnderlying): Promise<OptionContractSnapshot[]> {
  const today = etDate();
  const params = new URLSearchParams({
    "expiration_date.gte": today,
    "expiration_date.lte": addDays(today, 2),
    limit: "250",
    sort: "expiration_date",
  });
  let nextUrl: string | undefined = `${API_BASE}/v3/snapshot/options/${underlying}?${params}`;
  const raw: RawOptionContract[] = [];
  let pages = 0;

  while (nextUrl && pages < 4) {
    const payload: any = await massiveFetch<any>(nextUrl);
    for (const item of payload.results ?? []) {
      const details = item.details ?? {};
      const quote = item.last_quote ?? {};
      const day = item.day ?? item.session ?? {};
      const bid = Number(quote.bid ?? 0);
      const ask = Number(quote.ask ?? 0);
      const midpoint = Number(quote.midpoint ?? (bid > 0 && ask > 0 ? (bid + ask) / 2 : 0));
      const spread = ask > 0 && bid > 0 ? ask - bid : 0;
      const volume = Number(day.volume ?? 0);
      const openInterest = Number(item.open_interest ?? 0);
      const side = details.contract_type as OptionSide;
      const expirationDate = String(details.expiration_date ?? "");
      if ((side !== "call" && side !== "put") || !expirationDate) continue;

      raw.push({
        ticker: String(details.ticker ?? item.ticker ?? ""), underlying, expirationDate,
        dte: calendarDte(expirationDate, today), side, strike: Number(details.strike_price ?? 0),
        exerciseStyle: String(details.exercise_style ?? "unknown"), bid, ask, midpoint, spread,
        spreadPct: midpoint > 0 ? spread / midpoint * 100 : 999,
        last: item.last_trade?.price == null ? null : Number(item.last_trade.price),
        lastTradeSize: Number(item.last_trade?.size ?? 0),
        quoteUpdatedAt: quote.last_updated == null ? null : Math.floor(Number(quote.last_updated) / 1_000_000),
        volume, openInterest,
        volumeToOpenInterest: openInterest > 0 ? volume / openInterest : volume > 0 ? 5 : 0,
        impliedVolatility: item.implied_volatility == null ? null : Number(item.implied_volatility),
        delta: item.greeks?.delta == null ? null : Number(item.greeks.delta),
        gamma: item.greeks?.gamma == null ? null : Number(item.greeks.gamma),
        theta: item.greeks?.theta == null ? null : Number(item.greeks.theta),
        vega: item.greeks?.vega == null ? null : Number(item.greeks.vega),
        underlyingPrice: item.underlying_asset?.price == null ? null : Number(item.underlying_asset.price),
      });
    }
    nextUrl = payload.next_url;
    pages++;
  }

  return rankOptionContracts(raw);
}

function ema(values: number[], period: number): number {
  if (values.length === 0) return 0;
  const multiplier = 2 / (period + 1);
  return values.slice(1).reduce((value, current) => current * multiplier + value * (1 - multiplier), values[0]!);
}

function rsi(values: number[], period = 14): number | null {
  if (values.length <= period) return null;
  const changes = values.slice(-period - 1).slice(1).map((value, index) => value - values.slice(-period - 1)[index]!);
  const gain = changes.reduce((sum, change) => sum + Math.max(0, change), 0) / period;
  const loss = changes.reduce((sum, change) => sum + Math.max(0, -change), 0) / period;
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

function atr(bars: UnderlyingBar[], period = 14): number | null {
  if (bars.length <= period) return null;
  const recent = bars.slice(-period - 1);
  const ranges = recent.slice(1).map((bar, index) => Math.max(
    bar.high - bar.low,
    Math.abs(bar.high - recent[index]!.close),
    Math.abs(bar.low - recent[index]!.close),
  ));
  return ranges.reduce((sum, value) => sum + value, 0) / period;
}

function emaSeries(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const multiplier = 2 / (period + 1);
  return values.slice(1).reduce<number[]>((series, current) => {
    series.push(current * multiplier + series[series.length - 1]! * (1 - multiplier));
    return series;
  }, [values[0]!]);
}

function candlePattern(bars: UnderlyingBar[]): MarketState["technicals"]["candlePattern"] {
  if (bars.length < 2) return "none";
  const previous = bars[bars.length - 2]!;
  const current = bars[bars.length - 1]!;
  const body = Math.abs(current.close - current.open);
  const range = Math.max(current.high - current.low, Number.EPSILON);
  if (current.close > current.open && previous.close < previous.open && current.open <= previous.close && current.close >= previous.open) return "bullish_engulfing";
  if (current.close < current.open && previous.close > previous.open && current.open >= previous.close && current.close <= previous.open) return "bearish_engulfing";
  if ((Math.min(current.open, current.close) - current.low) / range > 0.6 && body / range < 0.35) return "hammer";
  if ((current.high - Math.max(current.open, current.close)) / range > 0.6 && body / range < 0.35) return "shooting_star";
  return "none";
}

export async function getMarketState(underlying: SupportedUnderlying): Promise<MarketState> {
  const date = etDate();
  const aggregateTicker = underlying === "SPX" ? "I:SPX" : "SPY";
  const payload: any = await massiveFetch(`/v2/aggs/ticker/${aggregateTicker}/range/1/minute/${date}/${date}?adjusted=true&sort=asc&limit=50000`);
  const bars: UnderlyingBar[] = (payload.results ?? []).map((bar: any) => ({
    timestamp: Number(bar.t), open: Number(bar.o), high: Number(bar.h), low: Number(bar.l),
    close: Number(bar.c), volume: Number(bar.v ?? 0), vwap: bar.vw == null ? null : Number(bar.vw),
  }));
  if (bars.length === 0) throw new Error(`No ${underlying} intraday bars returned`);
  const current = bars[bars.length - 1]!;
  const totalVolume = bars.reduce((sum, bar) => sum + bar.volume, 0);
  const vwapNumerator = bars.reduce((sum, bar) => sum + (bar.vwap ?? bar.close) * bar.volume, 0);
  const referencePrice = underlying === "SPY" && totalVolume > 0
    ? vwapNumerator / totalVolume
    : bars.reduce((sum, bar) => sum + bar.close, 0) / bars.length;
  const opening = bars.slice(0, 15);
  const openingRangeHigh = Math.max(...opening.map(bar => bar.high));
  const openingRangeLow = Math.min(...opening.map(bar => bar.low));
  const closes = bars.slice(-30).map(bar => bar.close);
  const fast = ema(closes, 8);
  const slow = ema(closes, 21);
  const allCloses = bars.map(bar => bar.close);
  const atr14 = atr(bars);
  const ema12 = emaSeries(allCloses, 12);
  const ema26 = emaSeries(allCloses, 26);
  const macdSeries = allCloses.map((_, index) => ema12[index]! - ema26[index]!);
  const macd = allCloses.length >= 26 ? macdSeries[macdSeries.length - 1]! : null;
  const macdSignal = allCloses.length >= 35 ? ema(macdSeries.slice(25), 9) : null;
  const mean20 = closes.slice(-20).reduce((sum, value) => sum + value, 0) / Math.max(1, closes.slice(-20).length);
  const deviation20 = Math.sqrt(closes.slice(-20).reduce((sum, value) => sum + (value - mean20) ** 2, 0) / Math.max(1, closes.slice(-20).length));
  const bollingerPosition = closes.length >= 20 && deviation20 > 0 ? (current.close - mean20) / (2 * deviation20) : null;
  const breakoutDistance = current.close > openingRangeHigh ? current.close - openingRangeHigh
    : current.close < openingRangeLow ? openingRangeLow - current.close : 0;
  const recentVolumes = bars.slice(-21, -1).map(bar => bar.volume).filter(value => value > 0);
  const averageRecentVolume = recentVolumes.reduce((sum, value) => sum + value, 0) / Math.max(1, recentVolumes.length);
  const regime = bars.length < 15 ? "opening"
    : current.close > referencePrice && fast > slow ? "uptrend"
    : current.close < referencePrice && fast < slow ? "downtrend"
    : "range";

  return {
    symbol: underlying, asOf: current.timestamp, price: current.close, referencePrice,
    referenceLabel: underlying === "SPY" ? "VWAP" : "SESSION_MEAN",
    aboveReference: current.close > referencePrice, openingRangeHigh, openingRangeLow,
    relativeVolume: null, regime, bars: bars.slice(-120),
    technicals: {
      ema8: fast, ema21: slow, rsi14: rsi(allCloses), atr14, macd, macdSignal,
      bollingerPosition, breakoutAtr: atr14 && atr14 > 0 ? breakoutDistance / atr14 : null,
      volumeConfirmation: underlying === "SPY" && recentVolumes.length >= 5 ? current.volume >= averageRecentVolume * 1.2 : null,
      candlePattern: candlePattern(bars),
    },
  };
}

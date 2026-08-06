import "server-only";
import { calculateTechnicals } from "./indicators";
import { rankContracts } from "./ranker";
import type { Bar, Contract, MarketState, Side, Underlying } from "./types";

const BASE = "https://api.massive.com";
const ALPACA_BASE = "https://data.alpaca.markets";
const dateEt = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
function addDays(value: string, count: number) { const date = new Date(`${value}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + count); return date.toISOString().slice(0, 10); }
async function massive<T>(pathOrUrl: string): Promise<T> {
  const key = process.env.MASSIVE_API_KEY;
  if (!key) throw new Error("MASSIVE_API_KEY is not configured");
  const url = new URL(pathOrUrl.startsWith("http") ? pathOrUrl : `${BASE}${pathOrUrl}`);
  url.searchParams.set("apiKey", key);
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`Massive API ${response.status}`);
  return response.json() as Promise<T>;
}
export async function getMarketState(underlying: Underlying): Promise<MarketState> {
  const key = process.env.ALPACA_API_KEY_ID; const secret = process.env.ALPACA_API_SECRET_KEY;
  if (!key || !secret) throw new Error("Alpaca market-data keys are not configured");
  const date = dateEt();
  const url = new URL(`${ALPACA_BASE}/v2/stocks/SPY/bars`);
  url.searchParams.set("timeframe", "1Min"); url.searchParams.set("start", date); url.searchParams.set("feed", "iex");
  url.searchParams.set("adjustment", "all"); url.searchParams.set("sort", "asc"); url.searchParams.set("limit", "1000");
  const response = await fetch(url, { headers:{ "APCA-API-KEY-ID":key, "APCA-API-SECRET-KEY":secret }, cache:"no-store", signal:AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`Alpaca SPY bars ${response.status}`);
  const payload = await response.json() as { bars?: Array<{ t:string;o:number;h:number;l:number;c:number;v?:number;vw?:number }> };
  const inRegularSession = (timestamp: string) => {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone:"America/New_York", hour:"2-digit", minute:"2-digit", hourCycle:"h23" }).formatToParts(new Date(timestamp));
    const hour = Number(parts.find(part => part.type === "hour")?.value); const minute = Number(parts.find(part => part.type === "minute")?.value);
    const minutes = hour * 60 + minute; return minutes >= 570 && minutes < 960;
  };
  const bars: Bar[] = (payload.bars ?? []).filter(item => inRegularSession(item.t)).map(item => ({ timestamp:Date.parse(item.t), open:item.o, high:item.h, low:item.l, close:item.c, volume:item.v ?? 0, vwap:item.vw ?? null }));
  if (!bars.length) throw new Error("No Alpaca IEX SPY bars returned");
  const current = bars.at(-1)!; const opening = bars.slice(0, 15);
  const openingRangeHigh = Math.max(...opening.map(bar => bar.high)); const openingRangeLow = Math.min(...opening.map(bar => bar.low));
  const totalVolume = bars.reduce((sum, bar) => sum + bar.volume, 0);
  const referencePrice = totalVolume
    ? bars.reduce((sum, bar) => sum + (bar.vwap ?? bar.close) * bar.volume, 0) / totalVolume
    : bars.reduce((sum, bar) => sum + bar.close, 0) / bars.length;
  const technicals = calculateTechnicals(bars, underlying, openingRangeHigh, openingRangeLow);
  const regime = bars.length < 15 ? "opening" : current.close > referencePrice && technicals.ema8 > technicals.ema21 ? "uptrend" : current.close < referencePrice && technicals.ema8 < technicals.ema21 ? "downtrend" : "range";
  return { symbol:underlying, chartSymbol:"SPY", asOf:current.timestamp, price:current.close, displayPrice:current.close, referencePrice, referenceLabel:"VWAP", openingRangeHigh, openingRangeLow, regime, technicals, bars:bars.slice(-120) };
}
export async function getOptionChain(underlying: Underlying): Promise<Contract[]> {
  const today = dateEt();
  const buckets = await Promise.all([0,1,2].map(async dte => {
    const expiration = addDays(today,dte); const rows: Parameters<typeof rankContracts>[0] = [];
    let next:string|undefined = `${BASE}/v3/snapshot/options/${underlying}?expiration_date=${expiration}&limit=250&sort=strike_price`; let pages=0;
    while(next && pages++ < 4) {
      const payload:any = await massive<any>(next);
      for(const item of payload.results ?? []) {
        const details=item.details ?? {}; const quote=item.last_quote ?? {}; const day=item.day ?? item.session ?? {};
        const side=details.contract_type as Side; const expirationDate=String(details.expiration_date ?? "");
        if(!expirationDate || !["call","put"].includes(side)) continue;
        const bid=Number(quote.bid ?? 0); const ask=Number(quote.ask ?? 0); const midpoint=Number(quote.midpoint ?? (bid && ask ? (bid+ask)/2:0));
        const volume=Number(day.volume ?? 0); const openInterest=Number(item.open_interest ?? 0);
        rows.push({ ticker:String(details.ticker ?? item.ticker ?? ""),underlying,expirationDate,dte,
          side,strike:Number(details.strike_price ?? 0),exerciseStyle:String(details.exercise_style ?? "unknown"),bid,ask,midpoint,
          spreadPct:midpoint ? (ask-bid)/midpoint*100:999,quoteUpdatedAt:quote.last_updated==null?null:Math.floor(Number(quote.last_updated)/1_000_000),
          volume,openInterest,volumeToOpenInterest:openInterest?volume/openInterest:volume?5:0,impliedVolatility:item.implied_volatility==null?null:Number(item.implied_volatility),
          delta:item.greeks?.delta==null?null:Number(item.greeks.delta),gamma:item.greeks?.gamma==null?null:Number(item.greeks.gamma),theta:item.greeks?.theta==null?null:Number(item.greeks.theta),underlyingPrice:item.underlying_asset?.price==null?null:Number(item.underlying_asset.price) });
      }
      next=payload.next_url;
    }
    return rows;
  }));
  const raw=buckets.flat();
  return rankContracts(raw);
}

import "server-only";
import { calculateTechnicals } from "./indicators";
import { rankContracts } from "./ranker";
import { getSampledSpxBars } from "./spx-bars";
import type { Bar, Contract, LongHorizon, MarketState, Side, Underlying } from "./types";
import { LONG_HORIZONS } from "./types";
import type { RiskSettings } from "@/lib/settings/config";
import { DEFAULT_RISK_SETTINGS } from "@/lib/settings/config";

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
  if (underlying === "SPX") return getSpxMarketState();
  return getEquityMarketState(underlying);
}

async function getPriorDayLevels(symbol: string, headers: Record<string,string>): Promise<MarketState["priorDay"]> {
  try {
    const url = new URL(`${ALPACA_BASE}/v2/stocks/${encodeURIComponent(symbol)}/bars`);
    url.searchParams.set("timeframe", "1Day"); url.searchParams.set("feed", "iex"); url.searchParams.set("limit", "5");
    url.searchParams.set("adjustment", "all"); url.searchParams.set("sort", "desc");
    const response = await fetch(url, { headers, cache:"no-store", signal:AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    const payload = await response.json() as { bars?: Array<{ t:string;h:number;l:number;c:number }> };
    const today = dateEt();
    const prior = (payload.bars ?? []).find(bar => new Intl.DateTimeFormat("en-CA",{timeZone:"America/New_York"}).format(new Date(bar.t)) < today);
    return prior ? { high:prior.h, low:prior.l, close:prior.c } : null;
  } catch { return null; }
}

async function getEquityMarketState(symbol: Exclude<Underlying,"SPX">): Promise<MarketState> {
  const key = process.env.ALPACA_API_KEY_ID; const secret = process.env.ALPACA_API_SECRET_KEY;
  if (!key || !secret) throw new Error("Alpaca market-data keys are not configured");
  const date = dateEt();
  const url = new URL(`${ALPACA_BASE}/v2/stocks/${encodeURIComponent(symbol)}/bars`);
  url.searchParams.set("timeframe", "1Min"); url.searchParams.set("start", date); url.searchParams.set("feed", "iex");
  url.searchParams.set("adjustment", "all"); url.searchParams.set("sort", "asc"); url.searchParams.set("limit", "1000");
  const headers = { "APCA-API-KEY-ID":key, "APCA-API-SECRET-KEY":secret };
  const [response, priorDay] = await Promise.all([
    fetch(url, { headers, cache:"no-store", signal:AbortSignal.timeout(12_000) }),
    getPriorDayLevels(symbol, headers),
  ]);
  if (!response.ok) throw new Error(`Alpaca ${symbol} bars ${response.status}`);
  const payload = await response.json() as { bars?: Array<{ t:string;o:number;h:number;l:number;c:number;v?:number;vw?:number }> };
  const inRegularSession = (timestamp: string) => {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone:"America/New_York", hour:"2-digit", minute:"2-digit", hourCycle:"h23" }).formatToParts(new Date(timestamp));
    const hour = Number(parts.find(part => part.type === "hour")?.value); const minute = Number(parts.find(part => part.type === "minute")?.value);
    const minutes = hour * 60 + minute; return minutes >= 570 && minutes < 960;
  };
  const bars: Bar[] = (payload.bars ?? []).filter(item => inRegularSession(item.t)).map(item => ({ timestamp:Date.parse(item.t), open:item.o, high:item.h, low:item.l, close:item.c, volume:item.v ?? 0, vwap:item.vw ?? null }));
  if (!bars.length) {
    // Zero session bars is expected off-hours (weekends, holidays, pre-open) — surface
    // a market-closed notice instead of a data-feed error so the dashboard reads true.
    const parts = new Intl.DateTimeFormat("en-US", { timeZone:"America/New_York", weekday:"short", hour:"2-digit", minute:"2-digit", hourCycle:"h23" }).formatToParts(new Date());
    const weekday = parts.find(part => part.type === "weekday")?.value ?? "";
    const minutes = Number(parts.find(part => part.type === "hour")?.value) * 60 + Number(parts.find(part => part.type === "minute")?.value);
    const closedNow = ["Sat","Sun"].includes(weekday) || minutes < 570 || minutes >= 960;
    if (closedNow) throw new Error(`Market is closed — ${symbol} data resumes at the next open (9:30 AM ET)`);
    throw new Error(`No Alpaca IEX ${symbol} bars returned`);
  }
  const current = bars.at(-1)!; const opening = bars.slice(0, 15);
  const openingRangeHigh = Math.max(...opening.map(bar => bar.high)); const openingRangeLow = Math.min(...opening.map(bar => bar.low));
  const totalVolume = bars.reduce((sum, bar) => sum + bar.volume, 0);
  const referencePrice = totalVolume
    ? bars.reduce((sum, bar) => sum + (bar.vwap ?? bar.close) * bar.volume, 0) / totalVolume
    : bars.reduce((sum, bar) => sum + bar.close, 0) / bars.length;
  const technicals = calculateTechnicals(bars, symbol, openingRangeHigh, openingRangeLow);
  const regime = bars.length < 15 ? "opening" : current.close > referencePrice && technicals.ema8 > technicals.ema21 ? "uptrend" : current.close < referencePrice && technicals.ema8 < technicals.ema21 ? "downtrend" : "range";
  return { symbol, chartSymbol:symbol, asOf:current.timestamp, price:current.close, displayPrice:current.close, referencePrice, referenceLabel:"VWAP", openingRangeHigh, openingRangeLow, regime, technicals, bars:bars.slice(-120), priorDay };
}

// Prior-day levels for SPX via Massive daily aggs, cached per session date. Without
// this, SPX market state carried priorDay:null forever — which silently disabled the
// opening-drive path (it needs yesterday's close/high) and starved the daily-context
// confluence lines. Found 2026-08-13 replaying the SPX gap morning.
let spxPriorDayCache:{date:string;value:MarketState["priorDay"]}|null=null;
async function getSpxPriorDay(today:string):Promise<MarketState["priorDay"]> {
  if(spxPriorDayCache?.date===today&&spxPriorDayCache.value)return spxPriorDayCache.value;
  try{
    const payload:{results?:Array<{t:number;h:number;l:number;c:number}>}=await massive(`/v2/aggs/ticker/I:SPX/range/1/day/${addDays(today,-7)}/${today}?adjusted=true&sort=desc&limit=10`);
    const prior=(payload.results??[]).find(bar=>new Intl.DateTimeFormat("en-CA",{timeZone:"America/New_York"}).format(new Date(bar.t))<today);
    const value=prior?{high:prior.h,low:prior.l,close:prior.c}:null;
    spxPriorDayCache={date:today,value};
    return value;
  }catch{return null;}
}

async function getSpxMarketState():Promise<MarketState> {
  const date=dateEt();
  let bars:Bar[];
  try{
    const payload:{results?:Array<{t:number;o:number;h:number;l:number;c:number}>}=await massive(`/v2/aggs/ticker/I:SPX/range/1/minute/${date}/${date}?adjusted=true&sort=asc&limit=50000`);
    const inRegularSession=(timestamp:number)=>{const parts=new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date(timestamp));const minutes=Number(parts.find(part=>part.type==="hour")?.value)*60+Number(parts.find(part=>part.type==="minute")?.value);return minutes>=570&&minutes<960;};
    bars=(payload.results??[]).filter(item=>inRegularSession(item.t)).map(item=>({timestamp:item.t,open:item.o,high:item.h,low:item.l,close:item.c,volume:0,vwap:null}));
    if(!bars.length)throw new Error("No Massive I:SPX one-minute bars returned; verify live index-data access");
  }catch(massiveError){
    // Entitlement (or any index-data) failure: fall back to bars self-sampled every minute
    // from the SPX option chain by the cron (lib/options/spx-bars.ts).
    bars=await getSampledSpxBars();
    if(!bars.length){
      if(massiveError instanceof Error&&massiveError.message.includes("403"))throw new Error("Live SPX index bars are not included in the current Massive entitlement; chain-sampled SPX bars will accumulate while the market is open");
      throw massiveError;
    }
  }
  const current=bars.at(-1)!;const opening=bars.slice(0,15);
  const openingRangeHigh=Math.max(...opening.map(bar=>bar.high));const openingRangeLow=Math.min(...opening.map(bar=>bar.low));
  const referencePrice=bars.reduce((sum,bar)=>sum+bar.close,0)/bars.length;
  const technicals=calculateTechnicals(bars,"SPX",openingRangeHigh,openingRangeLow);
  // SPX is a calculated index, not a traded instrument, so native volume/VWAP do not exist.
  // Price-only momentum remains usable; volume confirmation is deliberately treated as unavailable.
  const regime=bars.length<15?"opening":current.close>referencePrice&&technicals.ema8>technicals.ema21?"uptrend":current.close<referencePrice&&technicals.ema8<technicals.ema21?"downtrend":"range";
  const priorDay=await getSpxPriorDay(date);
  return {symbol:"SPX",chartSymbol:"SPX",asOf:current.timestamp,price:current.close,displayPrice:current.close,referencePrice,referenceLabel:"SESSION MEAN",openingRangeHigh,openingRangeLow,regime,technicals,bars:bars.slice(-120),priorDay};
}

export async function getHistoricalSpyBars(date: string): Promise<Bar[]> {
  const key = process.env.ALPACA_API_KEY_ID; const secret = process.env.ALPACA_API_SECRET_KEY;
  if (!key || !secret) throw new Error("Alpaca market-data keys are not configured");
  const start = date; const end = addDays(date, 1);
  const url = new URL(`${ALPACA_BASE}/v2/stocks/SPY/bars`);
  url.searchParams.set("timeframe", "1Min"); url.searchParams.set("start", start); url.searchParams.set("end", end);
  url.searchParams.set("feed", "iex"); url.searchParams.set("adjustment", "all"); url.searchParams.set("sort", "asc"); url.searchParams.set("limit", "1000");
  const response = await fetch(url, { headers:{ "APCA-API-KEY-ID":key, "APCA-API-SECRET-KEY":secret }, cache:"no-store", signal:AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Alpaca historical SPY bars ${response.status}`);
  const payload = await response.json() as { bars?: Array<{ t:string;o:number;h:number;l:number;c:number;v?:number;vw?:number }> };
  const bars = (payload.bars ?? []).filter(item=>{
    // Session isolation: RTH minutes AND the requested ET date only — without the date
    // check, the next session's bars leak in and contaminate opening range/VWAP/indicators.
    const sessionDate=new Intl.DateTimeFormat("en-CA",{timeZone:"America/New_York"}).format(new Date(item.t));
    if(sessionDate!==date) return false;
    const parts=new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date(item.t));
    const minutes=Number(parts.find(part=>part.type==="hour")?.value)*60+Number(parts.find(part=>part.type==="minute")?.value);
    return minutes>=570&&minutes<960;
  }).map(item => ({ timestamp:Date.parse(item.t), open:item.o, high:item.h, low:item.l, close:item.c, volume:item.v ?? 0, vwap:item.vw ?? null }));
  if (bars.length < 35) throw new Error("Not enough historical SPY bars for a deterministic replay");
  return bars;
}

// Long-dated monitoring chains. Each horizon tab covers a RANGE of expirations, not just one:
// several target tenors are resolved to their nearest listed expiries so 1-3 week and
// 2-month contracts are not silently skipped between the tab anchors.
const HORIZON_TARGETS: Record<LongHorizon, number[]> = { "1M": [7, 14, 21, 30, 45], "3M": [60, 91, 120], "6M": [150, 182], "9M": [240, 273], "1Y": [330, 365] };

export async function getHorizonChains(underlying: Underlying, horizons: Array<"NEAR"|LongHorizon>, settings:RiskSettings=DEFAULT_RISK_SETTINGS): Promise<Contract[]> {
  const today = dateEt();
  const targets = horizons.flatMap((horizon): Array<{ horizon: "NEAR" | LongHorizon; targetDays: number }> => horizon === "NEAR" ? [{ horizon, targetDays: 0 }] : HORIZON_TARGETS[horizon].map(targetDays => ({ horizon, targetDays })));
  const expirations = await Promise.all(targets.map(async ({ horizon, targetDays }) => {
    // Floor scales with the tenor so a short target can't resolve to a near-week expiry.
    const floor = targetDays === 0 ? today : addDays(today, Math.max(0, targetDays - Math.min(21, Math.round(targetDays / 3))));
    const payload = await massive<{ results?: Array<{ expiration_date?: string }> }>(
      `/v3/reference/options/contracts?underlying_ticker=${encodeURIComponent(underlying)}&expiration_date.gte=${floor}&limit=1&sort=expiration_date&order=asc`,
    ).catch(() => null);
    const expiration = payload?.results?.[0]?.expiration_date;
    return expiration ? { horizon, expiration } : null;
  }));
  const unique = [...new Map(expirations.filter((item): item is {horizon:"NEAR"|LongHorizon;expiration:string} => item != null).map(item => [item.expiration, item])).values()];
  const dteOf = (expiration: string) => Math.max(0, Math.round((Date.parse(`${expiration}T16:00:00-04:00`) - Date.now()) / 86_400_000));
  const buckets = await Promise.all(unique.map(async ({ expiration }) => {
    const rows: Parameters<typeof rankContracts>[0] = [];
    let next: string | undefined = `${BASE}/v3/snapshot/options/${underlying}?expiration_date=${expiration}&limit=250&sort=strike_price`; let pages = 0;
    while (next && pages++ < 2) {
      const payload: any = await massive<any>(next);
      for (const item of payload.results ?? []) {
        const details = item.details ?? {}; const quote = item.last_quote ?? {}; const day = item.day ?? item.session ?? {};
        const side = details.contract_type as Side; const expirationDate = String(details.expiration_date ?? "");
        if (!expirationDate || !["call","put"].includes(side)) continue;
        const bid = Number(quote.bid ?? 0); const ask = Number(quote.ask ?? 0); const midpoint = Number(quote.midpoint ?? (bid && ask ? (bid + ask) / 2 : 0));
        const volume = Number(day.volume ?? 0); const openInterest = Number(item.open_interest ?? 0);
        rows.push({ ticker:String(details.ticker ?? item.ticker ?? ""), underlying, expirationDate, dte:dteOf(expirationDate),
          side, strike:Number(details.strike_price ?? 0), exerciseStyle:String(details.exercise_style ?? "unknown"), bid, ask, midpoint,
          spreadPct:midpoint ? (ask - bid) / midpoint * 100 : 999, quoteUpdatedAt:quote.last_updated == null ? null : Math.floor(Number(quote.last_updated) / 1_000_000),
          volume, openInterest, volumeToOpenInterest:openInterest ? volume / openInterest : volume ? 5 : 0, impliedVolatility:item.implied_volatility == null ? null : Number(item.implied_volatility),
          delta:item.greeks?.delta == null ? null : Number(item.greeks.delta), gamma:item.greeks?.gamma == null ? null : Number(item.greeks.gamma), theta:item.greeks?.theta == null ? null : Number(item.greeks.theta), underlyingPrice:item.underlying_asset?.price == null ? null : Number(item.underlying_asset.price) });
      }
      next = payload.next_url;
    }
    // Cap per expiration bucket so one horizon cannot starve the others downstream.
    return rankContracts(rows, settings, { monitorOnly:true }).slice(0, 80);
  }));
  return buckets.flat();
}

export async function getOptionChain(underlying: Underlying,settings:RiskSettings=DEFAULT_RISK_SETTINGS,options?:{monitorOnly?:boolean}): Promise<Contract[]> {
  const today = dateEt();
  // The next three expiration SESSIONS, not calendar days: weekend dates carry no listed
  // expirations, so a Friday fetch covers Fri (0), Mon (3), Tue (4) — otherwise the
  // scanner asks Massive for Saturday/Sunday chains and "1DTE/2DTE" go empty all weekend.
  const sessions: Array<{ expiration: string; dte: number }> = [];
  for (let offset = 0; sessions.length < 3 && offset <= 6; offset++) {
    const candidate = addDays(today, offset);
    const weekday = new Date(`${candidate}T12:00:00Z`).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    sessions.push({ expiration: candidate, dte: offset });
  }
  const buckets = await Promise.all(sessions.map(async ({ expiration, dte }) => {
    const rows: Parameters<typeof rankContracts>[0] = [];
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
  return rankContracts(raw,settings,{monitorOnly:options?.monitorOnly});
}

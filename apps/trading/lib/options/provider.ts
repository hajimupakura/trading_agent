import "server-only";
import { STOCK_FEED } from "@/lib/alpaca/data-plan";
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

// ---- ALPACA OPTION CHAINS (2026-11-19). The Massive key 403'd ~Sep 11 and the
// user is not renewing; Alpaca added index options (SPX/SPXW/XSP/VIX) this year
// and serves chains for every underlying we care about through the options data
// API we already hold keys for. Snapshots carry quotes/greeks/IV/day-volume;
// open interest rides the trading API's contracts listing (best-effort merge).
// Contract identity (side/strike/expiry) is parsed from the OCC symbol itself.
const PAPER_TRADING_BASE = "https://paper-api.alpaca.markets";
function alpacaKeys() {
  const key = process.env.ALPACA_API_KEY_ID; const secret = process.env.ALPACA_API_SECRET_KEY;
  if (!key || !secret) throw new Error("Alpaca market-data keys are not configured");
  return { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret };
}
const OCC_RE = /^([A-Z]+?)(\d{6})([CP])(\d{8})$/;
interface AlpacaOptionSnapshot {
  latestQuote?: { t?: string; bp?: number; ap?: number };
  dailyBar?: { v?: number };
  impliedVolatility?: number | null;
  greeks?: { delta?: number | null; gamma?: number | null; theta?: number | null } | null;
}
export async function alpacaChainRows(underlying: Underlying, expiration: string, dte: number): Promise<Parameters<typeof rankContracts>[0]> {
  const headers = alpacaKeys();
  // The S&P 500 lists under TWO Cboe roots, and Alpaca addresses each as its own
  // underlying symbol: "SPX" carries only the AM-settled third-Friday monthlies
  // (which stop trading the evening BEFORE expiry), while "SPXW" carries the
  // PM-settled daily/weekly book — the live 0DTE market. Querying SPX alone
  // returned only monthlies, which looked fine while the 11/20 monthly was alive
  // and blew up on 2026-11-20 itself (a third Friday): the nearest "0DTE" chain
  // was a dead contract serving Thursday's closing quotes all session, and on any
  // non-monthly week the short-dated chain would have been empty outright.
  const roots = underlying === "SPX" ? ["SPX", "SPXW"] : [underlying];
  // Open interest enrichment (trading API). Failure never blocks the chain.
  const openInterestBySymbol = new Map<string, number>();
  try {
    let pageToken: string | undefined; let pages = 0;
    do {
      const url = new URL(`${PAPER_TRADING_BASE}/v2/options/contracts`);
      url.searchParams.set("underlying_symbols", roots.join(",")); url.searchParams.set("expiration_date", expiration);
      url.searchParams.set("limit", "1000");
      if (pageToken) url.searchParams.set("page_token", pageToken);
      const response = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(12_000) });
      if (!response.ok) break;
      const payload = await response.json() as { option_contracts?: Array<{ symbol: string; open_interest?: string | number | null }>; next_page_token?: string | null };
      for (const contract of payload.option_contracts ?? []) openInterestBySymbol.set(contract.symbol, Number(contract.open_interest ?? 0) || 0);
      pageToken = payload.next_page_token ?? undefined;
    } while (pageToken && ++pages < 4);
  } catch { /* enrichment only */ }
  const rows: Parameters<typeof rankContracts>[0] = [];
  const rootErrors: string[] = [];
  for (const root of roots) {
    try {
      let pageToken: string | undefined; let pages = 0;
      do {
        const url = new URL(`${ALPACA_BASE}/v1beta1/options/snapshots/${encodeURIComponent(root)}`);
        // OPRA when the account is entitled (real greeks/IV), else the free indicative
        // feed (greeks absent -> pseudo-deltas estimated below). Probed once per process.
        url.searchParams.set("feed", opraAvailable === false ? "indicative" : "opra");
        url.searchParams.set("limit", "1000");
        url.searchParams.set("expiration_date", expiration);
        if (pageToken) url.searchParams.set("page_token", pageToken);
        let response = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(12_000) });
        if (!response.ok && opraAvailable == null && [400, 401, 403].includes(response.status)) {
          opraAvailable = false;
          url.searchParams.set("feed", "indicative");
          response = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(12_000) });
        } else if (response.ok && opraAvailable == null) opraAvailable = true;
        if (!response.ok) throw new Error(`Alpaca option chain ${response.status} for ${root} ${expiration}`);
        const payload = await response.json() as { snapshots?: Record<string, AlpacaOptionSnapshot>; next_page_token?: string | null };
        for (const [occ, snap] of Object.entries(payload.snapshots ?? {})) {
          const match = OCC_RE.exec(occ);
          if (!match) continue;
          const side: Side = match[3] === "C" ? "call" : "put";
          const strike = Number(match[4]) / 1000;
          const bid = Number(snap.latestQuote?.bp ?? 0); const ask = Number(snap.latestQuote?.ap ?? 0);
          const midpoint = bid && ask ? (bid + ask) / 2 : 0;
          const volume = Number(snap.dailyBar?.v ?? 0);
          const openInterest = openInterestBySymbol.get(occ) ?? 0;
          rows.push({ ticker: `O:${occ}`, underlying, expirationDate: expiration, dte, side, strike,
            exerciseStyle: underlying === "SPX" ? "european" : "american", bid, ask, midpoint,
            spreadPct: midpoint ? (ask - bid) / midpoint * 100 : 999,
            quoteUpdatedAt: snap.latestQuote?.t ? Date.parse(snap.latestQuote.t) : null,
            volume, openInterest, volumeToOpenInterest: openInterest ? volume / openInterest : volume ? 5 : 0,
            impliedVolatility: snap.impliedVolatility == null ? null : Number(snap.impliedVolatility),
            delta: snap.greeks?.delta == null ? null : Number(snap.greeks.delta),
            gamma: snap.greeks?.gamma == null ? null : Number(snap.greeks.gamma),
            theta: snap.greeks?.theta == null ? null : Number(snap.greeks.theta),
            // No per-contract underlying price on Alpaca; the SPX sampler derives spot
            // from ATM put-call parity instead (spx-bars.deriveSpxSpot handles null).
            underlyingPrice: null });
        }
        pageToken = payload.next_page_token ?? undefined;
      } while (pageToken && ++pages < 4);
    } catch (error) {
      rootErrors.push(String(error));
    }
  }
  // All roots down = a real provider failure. One root down while the other answered
  // is degraded — log it loudly rather than discarding the good root, but never
  // swallow it silently: losing SPXW quietly would recreate the monthlies-only
  // blindness this dual-root fetch exists to fix.
  if (rootErrors.length && !rows.length) throw new Error(rootErrors.join(" · "));
  for (const message of rootErrors) console.error("Option chain root fetch failed (continuing on remaining roots)", underlying, expiration, message);
  if (rows.length && rows.every(row => row.delta == null)) estimateDeltas(rows);
  return rows;
}
let opraAvailable: boolean | null = null;
// Latest quotes for specific OCC symbols. Needed by the shadow ledger: a skipped
// contract that goes deep ITM (exactly the big counterfactual winners) drops out
// of the snapshot's ranked top-40, so marking must quote it directly.
export async function alpacaLatestOptionQuotes(tickers: string[]): Promise<Map<string, { bid: number; ask: number }>> {
  const quotes = new Map<string, { bid: number; ask: number }>();
  if (!tickers.length) return quotes;
  const headers = alpacaKeys();
  const url = new URL(`${ALPACA_BASE}/v1beta1/options/quotes/latest`);
  url.searchParams.set("symbols", tickers.slice(0, 100).map(ticker => ticker.replace(/^O:/, "")).join(","));
  url.searchParams.set("feed", opraAvailable === false ? "indicative" : "opra");
  let response = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(12_000) });
  if (!response.ok && opraAvailable == null && [400, 401, 403].includes(response.status)) {
    opraAvailable = false;
    url.searchParams.set("feed", "indicative");
    response = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(12_000) });
  }
  if (!response.ok) throw new Error(`Alpaca latest option quotes ${response.status}`);
  const payload = await response.json() as { quotes?: Record<string, { bp?: number; ap?: number }> };
  for (const [occ, quote] of Object.entries(payload.quotes ?? {})) quotes.set(`O:${occ}`, { bid: Number(quote.bp ?? 0), ask: Number(quote.ap ?? 0) });
  return quotes;
}
// Moneyness-based delta ESTIMATE for feeds without greeks (the indicative feed).
// Forward from ATM put-call parity, dollar-sigma from the ATM straddle (straddle
// price ~ expected move ~ 0.8 sigma), delta_call ~ Phi((F-K)/sigma). Coarse, but
// it restores delta-nearness RANKING (quality picks around 0.4) — it is never
// used as a greek for pricing. Marked by leaving gamma/theta null.
function estimateDeltas(rows: Parameters<typeof rankContracts>[0]): void {
  const byStrike = new Map<number, { call?: number; put?: number }>();
  for (const row of rows) {
    if (row.bid <= 0 || row.ask <= 0) continue;
    const entry = byStrike.get(row.strike) ?? {};
    entry[row.side] = row.midpoint; byStrike.set(row.strike, entry);
  }
  const pairs = [...byStrike.entries()].filter(([, pair]) => pair.call != null && pair.put != null)
    .map(([strike, pair]) => ({ strike, call: pair.call!, put: pair.put!, distance: Math.abs(pair.call! - pair.put!) }))
    .sort((a, b) => a.distance - b.distance);
  const atm = pairs[0];
  if (!atm) return;
  const forward = atm.strike + atm.call - atm.put;
  const sigma = Math.max((atm.call + atm.put) / 0.8, forward * 0.001);
  const phi = (z: number) => { // Abramowitz–Stegun normal CDF approximation
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI);
    const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return z >= 0 ? 1 - p : p;
  };
  for (const row of rows) {
    const callDelta = phi((forward - row.strike) / sigma);
    row.delta = Number((row.side === "call" ? callDelta : callDelta - 1).toFixed(3));
  }
}
export async function getMarketState(underlying: Underlying): Promise<MarketState> {
  if (underlying === "SPX") return getSpxMarketState();
  return getEquityMarketState(underlying);
}

async function getPriorDayLevels(symbol: string, headers: Record<string,string>): Promise<MarketState["priorDay"]> {
  try {
    const url = new URL(`${ALPACA_BASE}/v2/stocks/${encodeURIComponent(symbol)}/bars`);
    url.searchParams.set("timeframe", "1Day"); url.searchParams.set("feed", STOCK_FEED); url.searchParams.set("limit", "5");
    url.searchParams.set("adjustment", "all"); url.searchParams.set("sort", "desc");
    // WITHOUT start, Alpaca returns only TODAY's bars — so "find a bar dated before
    // today" found nothing and priorDay was silently null for EVERY equity since this
    // was written (discovered 2026-08-17: it disabled the opening-drive gap math for
    // all stock names while looking perfectly healthy).
    url.searchParams.set("start", addDays(dateEt(), -7));
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
  url.searchParams.set("timeframe", "1Min"); url.searchParams.set("start", date); url.searchParams.set("feed", STOCK_FEED);
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

// Prior-day levels for SPX, cached per session date, rebuilt from our own
// chain-sampled minute prices (Massive retired 2026-11, Alpaca has no native index
// feed — the sampled series IS the source, not a fallback). High/low are the sampled
// extremes (slightly inside the true wicks), close is the last sample — accurate
// enough for gap math, which is all priorDay feeds. Without priorDay, the opening
// drive silently dies (needs yesterday's close/high) — found 2026-08-13.
let spxPriorDayCache:{date:string;value:MarketState["priorDay"]}|null=null;
async function getSpxPriorDay(today:string):Promise<MarketState["priorDay"]> {
  if(spxPriorDayCache?.date===today&&spxPriorDayCache.value)return spxPriorDayCache.value;
  try{
      const etOf=(iso:string)=>new Intl.DateTimeFormat("en-CA",{timeZone:"America/New_York"}).format(new Date(iso));
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const { data } = await createAdminClient().from("index_bar_samples")
        .select("bar_time,price").eq("symbol","SPX")
        .lt("bar_time",`${today}T00:00:00-05:00`)
        .order("bar_time",{ascending:false}).limit(500);
      const rows=(data??[]).map(row=>({day:etOf(String(row.bar_time)),price:Number(row.price)}));
      const lastDay=rows[0]?.day;
      const session=rows.filter(row=>row.day===lastDay&&Number.isFinite(row.price)&&row.price>0);
      if(!lastDay||session.length<30)return null; // thin sample = no trustworthy levels
      const value={high:Math.max(...session.map(row=>row.price)),low:Math.min(...session.map(row=>row.price)),close:session[0].price};
      spxPriorDayCache={date:today,value};
      return value;
  }catch{return null;}
}

async function getSpxMarketState():Promise<MarketState> {
  // SPX bars self-assemble from the option chain the every-minute cron samples
  // (lib/options/spx-bars.ts). This is the PRIMARY source, not a fallback: Massive
  // is retired (2026-11, not renewed) and Alpaca carries no native index feed. The
  // old code still fired a doomed Massive HTTP call on every scan and, when samples
  // were empty (weekends/pre-open), surfaced a scary "Massive entitlement" banner
  // for what is simply "no session bars yet".
  const date=dateEt();
  const bars:Bar[]=await getSampledSpxBars();
  if(!bars.length)throw new Error("SPX bars for today's session have not accumulated yet — they self-assemble from live chain quotes each minute during regular hours (first bars by ~9:31 ET)");
  const current=bars.at(-1)!;const opening=bars.slice(0,15);
  const openingRangeHigh=Math.max(...opening.map(bar=>bar.high));const openingRangeLow=Math.min(...opening.map(bar=>bar.low));
  const referencePrice=bars.reduce((sum,bar)=>sum+bar.close,0)/bars.length;
  const technicals=calculateTechnicals(bars,"SPX",openingRangeHigh,openingRangeLow);
  // SPX is a calculated index, not a traded instrument, so native volume/VWAP do not exist.
  // Price-only momentum remains usable; volume confirmation is deliberately treated as unavailable.
  const regime=bars.length<15?"opening":current.close>referencePrice&&technicals.ema8>technicals.ema21?"uptrend":current.close<referencePrice&&technicals.ema8<technicals.ema21?"downtrend":"range";
  // SPX PARTICIPATION PROXY (2026-11-19): a calculated index has no volume, so SPX's
  // own volume math is noise. Borrow SPY's fresh (<=5 min) confirmation — it is the
  // same market with a real tape. null means "proxy unavailable" and the signal layer
  // keeps the historical waiver in that case.
  technicals.volumeConfirmation=null; technicals.relativeVolume=null;
  try{
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const { data: spyRow } = await createAdminClient().from("options_monitor_snapshots").select("payload,updated_at").eq("underlying","SPY").maybeSingle();
    if(spyRow&&Date.now()-Date.parse(String(spyRow.updated_at))<5*60_000){
      const spyTech=(spyRow.payload as {market?:{technicals?:{volumeConfirmation?:boolean|null;relativeVolume?:number|null}}}|null)?.market?.technicals;
      if(spyTech){technicals.volumeConfirmation=spyTech.volumeConfirmation??null;technicals.relativeVolume=spyTech.relativeVolume??null;}
    }
  }catch{/* proxy unavailable -> waiver */}
  const priorDay=await getSpxPriorDay(date);
  return {symbol:"SPX",chartSymbol:"SPX",asOf:current.timestamp,price:current.close,displayPrice:current.close,referencePrice,referenceLabel:"SESSION MEAN",openingRangeHigh,openingRangeLow,regime,technicals,bars:bars.slice(-120),priorDay};
}

export async function getHistoricalSpyBars(date: string): Promise<Bar[]> {
  const key = process.env.ALPACA_API_KEY_ID; const secret = process.env.ALPACA_API_SECRET_KEY;
  if (!key || !secret) throw new Error("Alpaca market-data keys are not configured");
  const start = date; const end = addDays(date, 1);
  const url = new URL(`${ALPACA_BASE}/v2/stocks/SPY/bars`);
  url.searchParams.set("timeframe", "1Min"); url.searchParams.set("start", start); url.searchParams.set("end", end);
  url.searchParams.set("feed", STOCK_FEED); url.searchParams.set("adjustment", "all"); url.searchParams.set("sort", "asc"); url.searchParams.set("limit", "1000");
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
    // Nearest listed expiry on/after the floor, via the trading API's contract listing.
    const url = new URL(`${PAPER_TRADING_BASE}/v2/options/contracts`);
    // SPX again spans both roots: without SPXW, the NEAR tenor can only resolve to a
    // third-Friday monthly (see the root note on alpacaChainRows).
    url.searchParams.set("underlying_symbols", underlying === "SPX" ? "SPX,SPXW" : underlying); url.searchParams.set("expiration_date_gte", floor);
    url.searchParams.set("limit", "200");
    const payload = await fetch(url, { headers: alpacaKeys(), cache: "no-store", signal: AbortSignal.timeout(12_000) })
      .then(response => response.ok ? response.json() as Promise<{ option_contracts?: Array<{ expiration_date?: string }> }> : null)
      .catch(() => null);
    const expirations = (payload?.option_contracts ?? []).map(contract => String(contract.expiration_date ?? "")).filter(Boolean).sort();
    return expirations.length ? { horizon, expiration: expirations[0] } : null;
  }));
  const unique = [...new Map(expirations.filter((item): item is {horizon:"NEAR"|LongHorizon;expiration:string} => item != null).map(item => [item.expiration, item])).values()];
  const dteOf = (expiration: string) => Math.max(0, Math.round((Date.parse(`${expiration}T16:00:00-04:00`) - Date.now()) / 86_400_000));
  const buckets = await Promise.all(unique.map(async ({ expiration }) => {
    const rows = await alpacaChainRows(underlying, expiration, dteOf(expiration));
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
  const buckets = await Promise.all(sessions.map(({ expiration, dte }) => alpacaChainRows(underlying, expiration, dte)));
  const raw=buckets.flat();
  return rankContracts(raw,settings,{monitorOnly:options?.monitorOnly});
}

import { config } from "./config.js";
import type { AlpacaOrder, AlpacaPosition } from "./types.js";

const PAPER = "https://paper-api.alpaca.markets"; const DATA = "https://data.alpaca.markets";
const headers = { "APCA-API-KEY-ID":config.ALPACA_API_KEY_ID, "APCA-API-SECRET-KEY":config.ALPACA_API_SECRET_KEY, "Content-Type":"application/json" };
async function request<T>(base:string,path:string,init:RequestInit = {}):Promise<T> {
  const response = await fetch(`${base}${path}`, { ...init, headers:{ ...headers, ...init.headers }, signal:AbortSignal.timeout(8000) });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.message ?? `Alpaca ${response.status}`);
  return body as T;
}
export async function getPositions() { return request<AlpacaPosition[]>(PAPER,"/v2/positions"); }
export async function getTodayOrders() { return request<AlpacaOrder[]>(PAPER,"/v2/orders?status=all&limit=500&direction=desc&nested=false"); }
export async function getSpyPrice() {
  const payload = await request<{trade?:{p?:number}}>(DATA,"/v2/stocks/SPY/trades/latest?feed=iex");
  const price = Number(payload.trade?.p); return Number.isFinite(price) && price > 0 ? price : null;
}
// Live option quote via Alpaca (equity options only — no index/SPXW coverage). Used
// when the Massive stream has no fresh quote for a Robinhood-held contract: on
// 2026-08-14 a TSLA put rode a +55% spike the monitors never saw (recorded peak 0%)
// because the only fallback was a minutes-stale chain snapshot, so no-follow-through
// sold a winner as a dud.
export async function getLatestOptionQuote(occTicker:string):Promise<{symbol:string;bid:number;ask:number;timestamp:number}|null> {
  const symbol = occTicker.replace(/^O:/,"");
  try {
    const payload = await request<{quotes?:Record<string,{bp?:number;ap?:number;t?:string}>}>(DATA,`/v1beta1/options/quotes/latest?symbols=${encodeURIComponent(symbol)}&feed=indicative`);
    const quote = payload.quotes?.[symbol];
    const bid = Number(quote?.bp); const ask = Number(quote?.ap); const timestamp = quote?.t ? Date.parse(quote.t) : NaN;
    return bid > 0 && ask >= bid && Number.isFinite(timestamp) ? { symbol: occTicker, bid, ask, timestamp } : null;
  } catch { return null; }
}
export async function submitCloseOrder(input:{symbol:string;quantity:number;limitPrice:number;clientOrderId:string}) {
  return request<AlpacaOrder>(PAPER,"/v2/orders", { method:"POST", body:JSON.stringify({ symbol:input.symbol, qty:String(input.quantity), side:"sell", type:"limit", time_in_force:"day", limit_price:input.limitPrice.toFixed(2), client_order_id:input.clientOrderId, position_intent:"sell_to_close" }) });
}
export async function replaceCloseOrder(orderId:string,limitPrice:number) {
  return request<AlpacaOrder>(PAPER,`/v2/orders/${encodeURIComponent(orderId)}`, { method:"PATCH", body:JSON.stringify({ limit_price:limitPrice.toFixed(2) }) });
}
export async function cancelOrder(orderId:string) {
  const response = await fetch(`${PAPER}/v2/orders/${encodeURIComponent(orderId)}`, { method:"DELETE", headers, signal:AbortSignal.timeout(8000) });
  if (!response.ok && response.status !== 404) throw new Error(`Alpaca cancel ${response.status}`);
}

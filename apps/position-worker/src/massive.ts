import WebSocket from "ws";
import { config } from "./config.js";
import type { OptionQuote } from "./types.js";

export class MassiveQuoteStream {
  private socket:WebSocket|null = null; private desired = new Set<string>(); private subscribed = new Set<string>();
  private quotes = new Map<string,OptionQuote>(); private reconnectTimer:NodeJS.Timeout|null = null; private stopped = false;
  start() { this.stopped = false; this.connect(); }
  stop() { this.stopped = true; if (this.reconnectTimer) clearTimeout(this.reconnectTimer); this.socket?.close(); }
  setSymbols(symbols:string[]) {
    this.desired = new Set(symbols); if (this.socket?.readyState !== WebSocket.OPEN) return;
    const add = [...this.desired].filter(symbol => !this.subscribed.has(symbol)); const remove = [...this.subscribed].filter(symbol => !this.desired.has(symbol));
    if (add.length) this.socket.send(JSON.stringify({ action:"subscribe", params:add.map(symbol => `Q.${symbol}`).join(",") }));
    if (remove.length) this.socket.send(JSON.stringify({ action:"unsubscribe", params:remove.map(symbol => `Q.${symbol}`).join(",") }));
    add.forEach(symbol => this.subscribed.add(symbol)); remove.forEach(symbol => this.subscribed.delete(symbol));
  }
  get(symbol:string) { return this.quotes.get(symbol) ?? null; }
  private connect() {
    if (this.stopped) return; this.socket = new WebSocket("wss://socket.massive.com/options");
    this.socket.on("open", () => this.socket?.send(JSON.stringify({ action:"auth", params:config.MASSIVE_API_KEY })));
    this.socket.on("message", data => {
      try {
        const events = JSON.parse(data.toString()) as Array<Record<string,unknown>>;
        for (const event of events) {
          if (event.ev === "status" && event.status === "auth_success") { this.subscribed.clear(); this.setSymbols([...this.desired]); }
          if (event.ev === "Q") {
            const symbol = String(event.sym); const bid = Number(event.bp); const ask = Number(event.ap); const timestamp = Number(event.t);
            if (symbol && bid > 0 && ask >= bid && Number.isFinite(timestamp)) this.quotes.set(symbol,{symbol,bid,ask,timestamp});
          }
        }
      } catch (error) { console.error(JSON.stringify({ event:"massive_message_error", error:String(error) })); }
    });
    this.socket.on("error", error => console.error(JSON.stringify({ event:"massive_socket_error", error:error.message })));
    this.socket.on("close", () => { this.socket = null; this.subscribed.clear(); if (!this.stopped) this.reconnectTimer = setTimeout(() => this.connect(),3000); });
  }
}

export async function getSpxPrice():Promise<number|null> {
  const date = new Date().toLocaleDateString("en-CA",{timeZone:"America/New_York"});
  const url = new URL(`https://api.massive.com/v2/aggs/ticker/${encodeURIComponent("I:SPX")}/range/1/minute/${date}/${date}`);
  url.searchParams.set("apiKey",config.MASSIVE_API_KEY); url.searchParams.set("sort","desc"); url.searchParams.set("limit","1");
  const response = await fetch(url,{signal:AbortSignal.timeout(8000)}); if (!response.ok) return null;
  const payload = await response.json() as {results?:Array<{c:number}>};
  const price = Number(payload.results?.[0]?.c);
  return Number.isFinite(price) && price > 0 ? price : null;
}

export async function getSnapshotQuote(underlying:"SPY"|"SPX",ticker:string):Promise<OptionQuote|null> {
  const url = new URL(`https://api.massive.com/v3/snapshot/options/${underlying}/${encodeURIComponent(ticker)}`); url.searchParams.set("apiKey",config.MASSIVE_API_KEY);
  const response = await fetch(url,{signal:AbortSignal.timeout(8000)}); if (!response.ok) return null;
  const payload = await response.json() as {results?:{last_quote?:{bid?:number;ask?:number;last_updated?:number}}}; const quote = payload.results?.last_quote;
  const bid = Number(quote?.bid); const ask = Number(quote?.ask); const rawTimestamp = Number(quote?.last_updated); const timestamp = rawTimestamp > 1e15 ? Math.floor(rawTimestamp/1e6) : rawTimestamp;
  return bid > 0 && ask >= bid && Number.isFinite(timestamp) ? {symbol:ticker,bid,ask,timestamp} : null;
}

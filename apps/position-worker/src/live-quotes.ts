import WebSocket from "ws";
import { createClient } from "@supabase/supabase-js";
import { config } from "./config.js";

// Near-real-time underlying prices for the dashboard: subscribe to Alpaca's free
// IEX stock stream for SPY + the watchlist, throttle to one write per symbol per
// second, and upsert into live_quotes — Supabase Realtime pushes each change to
// any open dashboard. End-to-end latency lands around 0.3-1s, at zero added
// subscription cost. Display-path only: nothing here feeds trading decisions
// (signals stay on minute bars; exits stay on the Massive options stream).

const SYMBOLS = ["SPY", "QQQ", "NVDA", "SPCX", "TSLA", "AAPL", "GOOGL", "META", "MSFT", "MU", "ASTS", "SKHY", "SNDK", "SLV", "GLD"];
const THROTTLE_MS = 1000;

const db = createClient(config.supabaseUrl, config.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

export class LiveQuoteRelay {
  private socket: WebSocket | null = null;
  private stopped = false;
  private lastWrite = new Map<string, number>();
  private pending = new Map<string, { price: number; ts: string }>();
  private flushTimer: NodeJS.Timeout | null = null;

  start() {
    this.connect();
    // Flush loop: batch the newest price per symbol once a second.
    this.flushTimer = setInterval(() => { void this.flush(); }, THROTTLE_MS);
  }

  stop() { this.stopped = true; this.socket?.close(); if (this.flushTimer) clearInterval(this.flushTimer); }

  private connect() {
    if (this.stopped) return;
    this.socket = new WebSocket("wss://stream.data.alpaca.markets/v2/iex");
    this.socket.on("open", () => {
      this.socket?.send(JSON.stringify({ action: "auth", key: config.ALPACA_API_KEY_ID, secret: config.ALPACA_API_SECRET_KEY }));
    });
    this.socket.on("message", raw => {
      try {
        const messages = JSON.parse(String(raw)) as Array<{ T: string; S?: string; p?: number; t?: string; msg?: string }>;
        for (const message of messages) {
          if (message.T === "success" && message.msg === "authenticated") {
            this.socket?.send(JSON.stringify({ action: "subscribe", trades: SYMBOLS }));
          } else if (message.T === "t" && message.S && message.p) {
            this.pending.set(message.S, { price: message.p, ts: message.t ?? new Date().toISOString() });
          }
        }
      } catch { /* non-JSON frame — ignore */ }
    });
    this.socket.on("close", () => { if (!this.stopped) setTimeout(() => this.connect(), 3000); });
    this.socket.on("error", error => console.error(JSON.stringify({ event: "live_quote_stream_error", error: String(error) })));
  }

  private async flush() {
    if (!this.pending.size) return;
    const now = Date.now();
    const rows: Array<{ symbol: string; price: number; ts: string }> = [];
    for (const [symbol, quote] of this.pending) {
      if (now - (this.lastWrite.get(symbol) ?? 0) < THROTTLE_MS) continue;
      rows.push({ symbol, price: quote.price, ts: quote.ts });
      this.lastWrite.set(symbol, now);
      this.pending.delete(symbol);
    }
    if (!rows.length) return;
    const { error } = await db.from("live_quotes").upsert(rows);
    if (error) console.error(JSON.stringify({ event: "live_quote_write_error", error: error.message }));
  }
}

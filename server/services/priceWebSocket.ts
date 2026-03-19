import WebSocket from "ws";
import { EventEmitter } from "events";

/**
 * Real-time price feed using Finnhub WebSocket API.
 * Maintains a persistent connection and an in-memory price cache.
 * Emits 'price' events when new data arrives.
 *
 * Finnhub free tier: WebSocket supported with limited symbols.
 * Upgrade to Polygon.io ($29/mo) for unlimited symbols + options data.
 */

export interface PriceUpdate {
  symbol: string;
  price: number;
  volume: number;
  timestamp: number; // Unix ms
}

class PriceWebSocketService extends EventEmitter {
  private ws: WebSocket | null = null;
  private subscribedSymbols = new Set<string>();
  private priceCache = new Map<string, PriceUpdate>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private isConnected = false;

  /**
   * Connect to Finnhub WebSocket.
   * No-ops if FINNHUB_API_KEY is not set.
   */
  connect(): void {
    const apiKey = process.env.FINNHUB_API_KEY;
    if (!apiKey) {
      console.warn("[PriceWS] FINNHUB_API_KEY not set — WebSocket price feed disabled");
      return;
    }

    if (this.ws && this.isConnected) {
      return;
    }

    const url = `wss://ws.finnhub.io?token=${apiKey}`;
    console.log("[PriceWS] Connecting to Finnhub WebSocket...");

    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      console.log("[PriceWS] Connected");
      this.isConnected = true;
      this.reconnectAttempts = 0;

      // Re-subscribe to all symbols
      Array.from(this.subscribedSymbols).forEach(symbol => {
        this.sendSubscribe(symbol);
      });
    });

    this.ws.on("message", (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "trade" && Array.isArray(msg.data)) {
          for (const trade of msg.data) {
            const update: PriceUpdate = {
              symbol: trade.s,
              price: trade.p,
              volume: trade.v,
              timestamp: trade.t,
            };
            this.priceCache.set(update.symbol, update);
            this.emit("price", update);
          }
        }
      } catch {
        // Ignore parse errors (ping frames, etc.)
      }
    });

    this.ws.on("close", () => {
      console.log("[PriceWS] Disconnected");
      this.isConnected = false;
      this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      console.error("[PriceWS] Error:", err.message);
      this.isConnected = false;
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error("[PriceWS] Max reconnect attempts reached");
      return;
    }

    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30_000);
    this.reconnectAttempts++;

    console.log(`[PriceWS] Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private sendSubscribe(symbol: string): void {
    if (this.ws && this.isConnected) {
      this.ws.send(JSON.stringify({ type: "subscribe", symbol }));
    }
  }

  private sendUnsubscribe(symbol: string): void {
    if (this.ws && this.isConnected) {
      this.ws.send(JSON.stringify({ type: "unsubscribe", symbol }));
    }
  }

  /**
   * Subscribe to real-time price updates for a symbol.
   */
  subscribe(symbol: string): void {
    const upper = symbol.toUpperCase();
    if (this.subscribedSymbols.has(upper)) return;
    this.subscribedSymbols.add(upper);
    this.sendSubscribe(upper);
    console.log(`[PriceWS] Subscribed to ${upper} (total: ${this.subscribedSymbols.size})`);
  }

  /**
   * Subscribe to multiple symbols at once.
   */
  subscribeMany(symbols: string[]): void {
    for (const s of symbols) {
      this.subscribe(s);
    }
  }

  /**
   * Unsubscribe from a symbol.
   */
  unsubscribe(symbol: string): void {
    const upper = symbol.toUpperCase();
    if (!this.subscribedSymbols.has(upper)) return;
    this.subscribedSymbols.delete(upper);
    this.sendUnsubscribe(upper);
  }

  /**
   * Get the latest cached price for a symbol.
   */
  getPrice(symbol: string): PriceUpdate | undefined {
    return this.priceCache.get(symbol.toUpperCase());
  }

  /**
   * Get all cached prices.
   */
  getAllPrices(): Map<string, PriceUpdate> {
    return new Map(this.priceCache);
  }

  /**
   * Get the set of currently subscribed symbols.
   */
  getSubscribedSymbols(): string[] {
    return Array.from(this.subscribedSymbols);
  }

  /**
   * Disconnect and clean up.
   */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
    console.log("[PriceWS] Disconnected and cleaned up");
  }

  get connected(): boolean {
    return this.isConnected;
  }
}

// Singleton instance
export const priceWS = new PriceWebSocketService();

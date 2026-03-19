// @ts-ignore - Alpaca SDK has loose typings
import Alpaca from "@alpacahq/alpaca-trade-api";

/**
 * Alpaca Markets Service
 * Free tier: real-time IEX data, paper + live trading, historical bars.
 *
 * Environment variables:
 *   ALPACA_API_KEY     - API key ID
 *   ALPACA_API_SECRET  - Secret key
 *   ALPACA_PAPER       - "true" for paper trading (default), "false" for live
 */

function getClient(): InstanceType<typeof Alpaca> | null {
  const keyId = process.env.ALPACA_API_KEY;
  const secretKey = process.env.ALPACA_API_SECRET;

  if (!keyId || !secretKey) {
    console.warn("[Alpaca] ALPACA_API_KEY and ALPACA_API_SECRET not set — Alpaca disabled");
    return null;
  }

  return new Alpaca({
    keyId,
    secretKey,
    paper: process.env.ALPACA_PAPER !== "false", // Default to paper
  });
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface AlpacaAccount {
  id: string;
  status: string;
  currency: string;
  cash: number;
  portfolioValue: number;
  buyingPower: number;
  equity: number;
  lastEquity: number;
  daytradeCount: number;
  daytradeLimit: number;
}

export interface AlpacaPosition {
  symbol: string;
  qty: number;
  side: string;
  avgEntryPrice: number;
  marketValue: number;
  currentPrice: number;
  unrealizedPL: number;
  unrealizedPLPC: number;
}

export interface AlpacaBar {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap: number;
}

export interface AlpacaOrder {
  id: string;
  symbol: string;
  side: string;
  type: string;
  qty: number;
  filledQty: number;
  filledAvgPrice: number | null;
  status: string;
  createdAt: string;
}

// ── Account & Positions ──────────────────────────────────────────────────────

export async function getAccount(): Promise<AlpacaAccount | null> {
  const client = getClient();
  if (!client) return null;

  try {
    const acct = await client.getAccount();
    return {
      id: acct.id,
      status: acct.status,
      currency: acct.currency,
      cash: parseFloat(acct.cash),
      portfolioValue: parseFloat(acct.portfolio_value),
      buyingPower: parseFloat(acct.buying_power),
      equity: parseFloat(acct.equity),
      lastEquity: parseFloat(acct.last_equity),
      daytradeCount: acct.daytrade_count,
      daytradeLimit: acct.daytrading_buying_power ? 3 : 0,
    };
  } catch (error: any) {
    console.error("[Alpaca] Error fetching account:", error.message);
    return null;
  }
}

export async function getPositions(): Promise<AlpacaPosition[]> {
  const client = getClient();
  if (!client) return [];

  try {
    const positions = await client.getPositions();
    return positions.map((p: any) => ({
      symbol: p.symbol,
      qty: parseFloat(p.qty),
      side: p.side,
      avgEntryPrice: parseFloat(p.avg_entry_price),
      marketValue: parseFloat(p.market_value),
      currentPrice: parseFloat(p.current_price),
      unrealizedPL: parseFloat(p.unrealized_pl),
      unrealizedPLPC: parseFloat(p.unrealized_plpc),
    }));
  } catch (error: any) {
    console.error("[Alpaca] Error fetching positions:", error.message);
    return [];
  }
}

// ── Market Data ──────────────────────────────────────────────────────────────

/**
 * Get latest quote for a symbol via Alpaca.
 */
export async function getLatestQuote(symbol: string): Promise<{ price: number; volume: number } | null> {
  const client = getClient();
  if (!client) return null;

  try {
    const quote = await client.getLatestTrade(symbol);
    return {
      price: quote.Price,
      volume: quote.Size,
    };
  } catch (error: any) {
    console.error(`[Alpaca] Error fetching quote for ${symbol}:`, error.message);
    return null;
  }
}

/**
 * Get historical bars for a symbol.
 */
export async function getHistoricalBars(
  symbol: string,
  timeframe: string = "1Day",
  start?: string,
  limit: number = 100,
): Promise<AlpacaBar[]> {
  const client = getClient();
  if (!client) return [];

  try {
    const startDate = start || getDateNDaysAgo(limit);
    const bars = client.getBarsV2(symbol, {
      start: startDate,
      timeframe,
      limit,
    });

    const result: AlpacaBar[] = [];
    for await (const bar of bars) {
      result.push({
        timestamp: bar.Timestamp,
        open: bar.OpenPrice,
        high: bar.HighPrice,
        low: bar.LowPrice,
        close: bar.ClosePrice,
        volume: bar.Volume,
        vwap: bar.VWAP,
      });
    }

    return result;
  } catch (error: any) {
    console.error(`[Alpaca] Error fetching bars for ${symbol}:`, error.message);
    return [];
  }
}

// ── Order Execution ──────────────────────────────────────────────────────────

/**
 * Place an order via Alpaca (paper or live depending on config).
 */
export async function placeOrder(params: {
  symbol: string;
  qty: number;
  side: "buy" | "sell";
  type: "market" | "limit" | "stop" | "stop_limit";
  limitPrice?: number;
  stopPrice?: number;
  timeInForce?: "day" | "gtc" | "ioc";
}): Promise<AlpacaOrder | null> {
  const client = getClient();
  if (!client) return null;

  try {
    const order = await client.createOrder({
      symbol: params.symbol,
      qty: params.qty,
      side: params.side,
      type: params.type,
      time_in_force: params.timeInForce || "day",
      limit_price: params.limitPrice,
      stop_price: params.stopPrice,
    });

    return {
      id: order.id,
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      qty: parseFloat(order.qty),
      filledQty: parseFloat(order.filled_qty || "0"),
      filledAvgPrice: order.filled_avg_price ? parseFloat(order.filled_avg_price) : null,
      status: order.status,
      createdAt: order.created_at,
    };
  } catch (error: any) {
    console.error("[Alpaca] Error placing order:", error.message);
    return null;
  }
}

/**
 * Get recent orders.
 */
export async function getOrders(status: "open" | "closed" | "all" = "all", limit: number = 50): Promise<AlpacaOrder[]> {
  const client = getClient();
  if (!client) return [];

  try {
    const orders = await client.getOrders({
      status,
      limit,
      until: undefined,
      after: undefined,
      direction: undefined,
      nested: undefined,
      symbols: undefined,
    } as any);
    return orders.map((o: any) => ({
      id: o.id,
      symbol: o.symbol,
      side: o.side,
      type: o.type,
      qty: parseFloat(o.qty),
      filledQty: parseFloat(o.filled_qty || "0"),
      filledAvgPrice: o.filled_avg_price ? parseFloat(o.filled_avg_price) : null,
      status: o.status,
      createdAt: o.created_at,
    }));
  } catch (error: any) {
    console.error("[Alpaca] Error fetching orders:", error.message);
    return [];
  }
}

/**
 * Check if Alpaca is configured and connected.
 */
export async function isAlpacaAvailable(): Promise<boolean> {
  const account = await getAccount();
  return account !== null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getDateNDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split("T")[0]!;
}

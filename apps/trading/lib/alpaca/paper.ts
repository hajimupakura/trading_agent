import "server-only";

const PAPER_BASE_URL = "https://paper-api.alpaca.markets";

function credentials() {
  const key = process.env.ALPACA_API_KEY_ID;
  const secret = process.env.ALPACA_API_SECRET_KEY;
  if (!key || !secret) throw new Error("Alpaca paper credentials are not configured");
  return { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret };
}

async function alpaca<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${PAPER_BASE_URL}${path}`, {
    ...init,
    cache: "no-store",
    headers: { ...credentials(), "Content-Type":"application/json", ...init.headers },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload.message === "string" ? payload.message : `Alpaca request failed (${response.status})`;
    throw new Error(message);
  }
  return payload as T;
}

export interface AlpacaAccount {
  id: string; status: string; currency: string; equity: string; last_equity: string;
  cash: string; buying_power: string; options_buying_power: string; options_approved_level: number;
}
export interface AlpacaPosition { symbol:string; asset_class:string; qty:string; market_value:string; cost_basis:string; unrealized_pl:string; unrealized_plpc:string }
export interface AlpacaOrder { id:string; client_order_id:string; symbol:string; status:string; side:string; qty:string; type:string; limit_price:string | null; filled_qty:string; created_at:string }

export const optionSymbolForAlpaca = (ticker: string) => ticker.startsWith("O:") ? ticker.slice(2) : ticker;

export async function getPaperTradingState() {
  const [account, positions, orders] = await Promise.all([
    alpaca<AlpacaAccount>("/v2/account"),
    alpaca<AlpacaPosition[]>("/v2/positions"),
    alpaca<AlpacaOrder[]>("/v2/orders?status=open&limit=100&direction=desc"),
  ]);
  return { account, positions:positions.filter(position => position.asset_class === "us_option"), orders };
}

export async function submitPaperOptionOrder(input: { symbol:string; limitPrice:number; clientOrderId:string }) {
  return alpaca<AlpacaOrder>("/v2/orders", { method:"POST", body:JSON.stringify({
    symbol:optionSymbolForAlpaca(input.symbol), qty:"1", side:"buy", type:"limit", time_in_force:"day",
    limit_price:input.limitPrice.toFixed(2), client_order_id:input.clientOrderId, position_intent:"buy_to_open",
  }) });
}

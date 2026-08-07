import "server-only";
import { callRobinhoodTool } from "./robinhood";

// Thin typed wrappers over the Robinhood MCP trading tools (schemas discovered at
// connect time and stored in broker_connections.capabilities). Response shapes are
// parsed defensively — the MCP returns JSON inside text content blocks.

function parseResult(payload: unknown): any {
  const blocks = ((payload as { content?: unknown })?.content ?? []) as Array<{ type?: string; text?: string }>;
  const text = Array.isArray(blocks) ? blocks.find(block => block?.type === "text")?.text : undefined;
  if (!text) return payload;
  try { return JSON.parse(text); } catch { return text; }
}

const asList = (raw: any): any[] => Array.isArray(raw) ? raw : raw?.results ?? raw?.accounts ?? raw?.orders ?? raw?.positions ?? [];

export async function getRobinhoodAccounts(userId: string) {
  const raw = parseResult(await callRobinhoodTool(userId, "get_accounts", {}));
  return asList(raw);
}

export async function getRobinhoodOverview(userId: string, accountNumber: string) {
  const [portfolio, positions, orders] = await Promise.all([
    callRobinhoodTool(userId, "get_portfolio", { account_number: accountNumber }).then(parseResult),
    callRobinhoodTool(userId, "get_option_positions", { account_number: accountNumber, nonzero: true }).then(parseResult).then(asList),
    callRobinhoodTool(userId, "get_option_orders", { account_number: accountNumber, placed_agent: "agentic" }).then(parseResult).then(asList).catch(() => []),
  ]);
  return { portfolio, positions, orders: orders.slice(0, 10) };
}

export async function resolveOptionInstrument(userId: string, input: { chainSymbol: string; expirationDate: string; strike: number; type: "call" | "put" }) {
  const raw = parseResult(await callRobinhoodTool(userId, "get_option_instruments", {
    chain_symbol: input.chainSymbol, expiration_dates: input.expirationDate,
    strike_price: input.strike.toFixed(4), type: input.type, state: "active", tradability: "tradable",
  }));
  const instrument = asList(raw)[0];
  if (!instrument?.id) throw new Error(`No tradable Robinhood instrument for ${input.chainSymbol} ${input.expirationDate} ${input.strike} ${input.type}`);
  return instrument as { id: string };
}

export async function reviewAndPlaceOptionOrder(userId: string, input: {
  accountNumber: string; optionId: string; side: "buy" | "sell"; positionEffect: "open" | "close";
  quantity: number; limitPrice: number; chainSymbol: string; underlyingType: "equity" | "index"; refId: string;
}) {
  const legs = [{ option_id: input.optionId, side: input.side, position_effect: input.positionEffect }];
  const common = {
    account_number: input.accountNumber, legs,
    quantity: String(Math.max(1, Math.floor(input.quantity))),
    type: "limit", price: input.limitPrice.toFixed(2), time_in_force: "gfd",
  };
  const review = parseResult(await callRobinhoodTool(userId, "review_option_order", { ...common, chain_symbol: input.chainSymbol, underlying_type: input.underlyingType }));
  const order = parseResult(await callRobinhoodTool(userId, "place_option_order", { ...common, ref_id: input.refId }));
  return { review, order };
}

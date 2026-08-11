import "server-only";
import { callRobinhoodTool } from "./robinhood";

// Thin typed wrappers over the Robinhood MCP trading tools (schemas discovered at
// connect time and stored in broker_connections.capabilities). Response shapes are
// parsed defensively — the MCP returns JSON inside text content blocks.

// Tool payloads arrive as {content:[{type:"text",text:JSON}], structuredContent?:{...}}
// where the JSON is {data:{...}, guide:"..."} — `guide` is Robinhood-authored display
// prose (untrusted); only `data` is consumed.
export function parseToolData(payload: unknown): any {
  const structured = (payload as { structuredContent?: { data?: unknown } })?.structuredContent;
  if (structured && typeof structured === "object" && "data" in structured) return (structured as any).data;
  const blocks = ((payload as { content?: unknown })?.content ?? []) as Array<{ type?: string; text?: string }>;
  const text = Array.isArray(blocks) ? blocks.find(block => block?.type === "text")?.text : undefined;
  if (!text) return payload;
  try { const parsed = JSON.parse(text); return parsed?.data ?? parsed; } catch { return text; }
}

const asList = (raw: any, key: string): any[] => Array.isArray(raw) ? raw : raw?.[key] ?? raw?.results ?? [];

export async function getRobinhoodAccounts(userId: string) {
  const raw = parseToolData(await callRobinhoodTool(userId, "get_accounts", {}));
  return asList(raw, "accounts");
}

export async function getRobinhoodOptionUpgradeUrl(userId: string, accountNumber: string): Promise<string | null> {
  const raw = parseToolData(await callRobinhoodTool(userId, "get_option_level_upgrade_info", { account_number: accountNumber }).catch(() => null));
  return raw?.upgrade_url ?? null;
}

export async function getRobinhoodOverview(userId: string, accountNumber: string) {
  const [portfolioRaw, positionsRaw, ordersRaw] = await Promise.all([
    callRobinhoodTool(userId, "get_portfolio", { account_number: accountNumber }).then(parseToolData),
    callRobinhoodTool(userId, "get_option_positions", { account_number: accountNumber, nonzero: true }).then(parseToolData),
    callRobinhoodTool(userId, "get_option_orders", { account_number: accountNumber }).then(parseToolData).catch(() => null),
  ]);
  const portfolio = {
    totalValue: Number(portfolioRaw?.total_value ?? 0),
    cash: Number(portfolioRaw?.cash ?? 0),
    buyingPower: Number(portfolioRaw?.buying_power?.buying_power ?? portfolioRaw?.buying_power ?? 0),
    optionsValue: Number(portfolioRaw?.options_value ?? 0),
    currency: String(portfolioRaw?.currency ?? "USD"),
  };
  // Tolerant list extraction — the tool has returned positions under different keys.
  const positions = Array.isArray(positionsRaw) ? positionsRaw
    : positionsRaw?.positions ?? positionsRaw?.option_positions ?? positionsRaw?.results ?? [];
  const positionsShape = Array.isArray(positionsRaw) ? `array(${positionsRaw.length})`
    : positionsRaw && typeof positionsRaw === "object" ? `keys:${Object.keys(positionsRaw).slice(0, 10).join(",")}` : String(typeof positionsRaw);
  return { portfolio, positions, positionsShape, orders: asList(ordersRaw, "orders").slice(0, 15) };
}

export async function resolveOptionInstrument(userId: string, input: { chainSymbol: string; expirationDate: string; strike: number; type: "call" | "put" }) {
  const raw = parseToolData(await callRobinhoodTool(userId, "get_option_instruments", {
    chain_symbol: input.chainSymbol, expiration_dates: input.expirationDate,
    strike_price: input.strike.toFixed(4), type: input.type, state: "active", tradability: "tradable",
  }));
  const instrument = asList(raw, "instruments")[0];
  if (!instrument?.id) {
    // Diagnose instead of shrugging: re-query WITHOUT the state/tradability filters so
    // the error names what Robinhood actually says about this contract (2026-08-11: a
    // same-day SPY put came back empty despite the account's expiration-date toggle
    // being ON — the filters below will reveal whether the API marks 0DTE instruments
    // closing-only on the agentic surface).
    const unfiltered = parseToolData(await callRobinhoodTool(userId, "get_option_instruments", {
      chain_symbol: input.chainSymbol, expiration_dates: input.expirationDate,
      strike_price: input.strike.toFixed(4), type: input.type,
    }).catch(() => null));
    const found = asList(unfiltered, "instruments")[0];
    const detail = found ? `instrument exists but state=${found.state ?? "?"} tradability=${found.tradability ?? "?"}` : "instrument not returned at all";
    throw new Error(`No tradable Robinhood instrument for ${input.chainSymbol} ${input.expirationDate} ${input.strike} ${input.type} (${detail})`);
  }
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
  const review = parseToolData(await callRobinhoodTool(userId, "review_option_order", { ...common, chain_symbol: input.chainSymbol, underlying_type: input.underlyingType }));
  const order = parseToolData(await callRobinhoodTool(userId, "place_option_order", { ...common, ref_id: input.refId }));
  return { review, order };
}

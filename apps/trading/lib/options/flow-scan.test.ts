import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Contract } from "./types";

// Regression for the 2026-11-25 monitor timeouts: a contract whose flow alert and
// flow-watch row already exist for today must cost ZERO writes on later scans.

vi.mock("server-only", () => ({}));

const createAlert = vi.fn(async (_input: { eventKey: string }) => undefined);
const recordFlowWatch = vi.fn(async (_input: { ticker: string; alreadyRecorded?: boolean }) => undefined);
vi.mock("@/lib/alerts/server", () => ({ createAlert: (input: { eventKey: string }) => createAlert(input) }));
vi.mock("./flow-watch", () => ({ recordFlowWatch: (input: { ticker: string; alreadyRecorded?: boolean }) => recordFlowWatch(input) }));

const tables: Record<string, { data: unknown; error: { message: string } | null }> = {};
const queries: string[] = [];
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from(table: string) {
      queries.push(table);
      const result = tables[table] ?? { data: [], error: null };
      const chain: Record<string, unknown> = {};
      for (const method of ["select", "eq", "gte", "like", "limit"]) chain[method] = () => chain;
      chain.maybeSingle = async () => result;
      chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
      return chain;
    },
  }),
}));

const contract = (ticker: string, overrides: Partial<Contract> = {}): Contract => ({
  ticker, underlying: "SPX", expirationDate: "2026-11-25", dte: 0, side: "call", strike: 6800,
  volume: 5000, openInterest: 100, midpoint: 2, bid: 1.9, ask: 2.1, ...overrides,
} as unknown as Contract);

describe("scanUnusualFlow", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-25T16:05:00Z")); // Wed 11:05 ET, inside RTH
    createAlert.mockClear(); recordFlowWatch.mockClear(); queries.length = 0;
    for (const key of Object.keys(tables)) delete tables[key];
    tables.profiles = { data: { id: "user-1" }, error: null };
  });
  afterEach(() => vi.useRealTimers());

  it("writes a contract the first time it qualifies", async () => {
    const { scanUnusualFlow } = await import("./flow-scan");
    await scanUnusualFlow("SPX", [contract("O:SPXW261125C06800000")]);
    expect(createAlert).toHaveBeenCalledTimes(1);
    expect(createAlert.mock.calls[0][0].eventKey).toBe("flow-O:SPXW261125C06800000-2026-11-25");
    expect(recordFlowWatch.mock.calls[0][0]).toMatchObject({ ticker: "O:SPXW261125C06800000", alreadyRecorded: false });
  });

  it("re-sends nothing for contracts already recorded today, and still writes the new one", async () => {
    tables.alerts = { data: [{ event_key: "flow-O:SPXW261125C06800000-2026-11-25" }, { event_key: "flow-O:SPXW261125P06700000-2026-11-25" }], error: null };
    tables.flow_watches = { data: [{ contract_ticker: "O:SPXW261125C06800000" }, { contract_ticker: "O:SPXW261125P06700000" }], error: null };
    const { scanUnusualFlow } = await import("./flow-scan");
    await scanUnusualFlow("SPX", [
      contract("O:SPXW261125C06800000"),
      contract("O:SPXW261125P06700000", { side: "put" }),
      contract("O:SPXW261125C06850000"),
    ]);
    expect(createAlert.mock.calls.map(call => call[0].eventKey)).toEqual(["flow-O:SPXW261125C06850000-2026-11-25"]);
    expect(recordFlowWatch.mock.calls.map(call => [call[0].ticker, call[0].alreadyRecorded])).toEqual([
      ["O:SPXW261125C06800000", true], ["O:SPXW261125P06700000", true], ["O:SPXW261125C06850000", false],
    ]);
  });

  it("falls back to writing everything when the lookup fails (slower, never silent)", async () => {
    tables.alerts = { data: null, error: { message: "boom" } };
    tables.flow_watches = { data: null, error: { message: "boom" } };
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { scanUnusualFlow } = await import("./flow-scan");
    await scanUnusualFlow("SPX", [contract("O:SPXW261125C06800000")]);
    expect(createAlert).toHaveBeenCalledTimes(1);
    expect(recordFlowWatch.mock.calls[0][0].alreadyRecorded).toBe(false);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it("does not query for known rows when nothing qualifies", async () => {
    const { scanUnusualFlow } = await import("./flow-scan");
    await scanUnusualFlow("SPX", [contract("O:SPXW261125C06800000", { volume: 10 })]);
    expect(queries).toEqual(["profiles"]);
    expect(createAlert).not.toHaveBeenCalled();
  });
});

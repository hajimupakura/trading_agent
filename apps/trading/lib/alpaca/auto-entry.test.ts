import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandCenter } from "@/lib/options/types";
vi.mock("server-only", () => ({}));
const m = vi.hoisted(() => ({ control: {} as Record<string, unknown>, inserts: [] as Record<string, unknown>[], score: vi.fn(), shadow: vi.fn(), submit: vi.fn(), risk: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from(table: string) {
  const result = () => ({ data: table === "profiles" ? { id: "owner" } : table === "position_manager_control" ? m.control : [], error: null });
  const q: Record<string, unknown> = {};
  for (const method of ["select", "eq", "gte", "neq", "limit"]) q[method] = () => q;
  q.single = q.maybeSingle = async () => table === "paper_trade_orders" ? { data: null, error: null } : result();
  q.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve);
  q.insert = async (row: Record<string, unknown>) => { m.inserts.push(row); return { error: null }; };
  return q;
} }) }));
vi.mock("@/lib/alerts/server", () => ({ createAlert: vi.fn(async () => undefined) }));
vi.mock("./paper", () => ({ getPaperTradingState: async () => ({ account: { equity: "100000", options_buying_power: "100000" }, positions: [], orders: [] }), submitPaperOptionOrder: m.submit }));
vi.mock("./risk", () => ({ PAPER_RULES: { cooldownMinutes: 10 }, computePositionSize: () => 1, entryCooldownActive: () => false, invalidAtEntry: () => false, validatePaperEntry: m.risk }));
vi.mock("@/lib/market/calendar-server", () => ({ getMarketCalendar: async () => ({}) }));
vi.mock("@/lib/settings/risk-settings", () => ({ loadRiskSettings: async () => ({ autoEntriesEnabled: true, paperTradingEnabled: true, maxTradesPerDay: 5 }) }));
vi.mock("@/lib/options/earnings-guard", () => ({ activeEarningsGuard: async () => null }));
vi.mock("@/lib/options/shadow-ledger", () => ({ recordShadowSkip: m.shadow }));
vi.mock("@/lib/ml/entry-gate", async orig => ({ ...await orig<object>(), scoreEntry: m.score }));
import { runAutoEntry } from "./auto-entry";
const snap = () => ({ signal: { id: "test", generatedAt: Date.now(), action: "enter_call", setup: "opening_range", reasons: [], market: { price: 100 }, contract: { ticker: "O:TSLA261127C00101000", ask: 1, bid: .9, midpoint: .95, dte: 1 } }, market: { bars: [] }, contracts: [] }) as unknown as CommandCenter;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-24T15:00:00Z")); vi.clearAllMocks(); m.control = {}; m.inserts = [];
  m.score.mockReset().mockReturnValue({ prob: .8, threshold: .6, skip: true, legPct: 1 }); m.shadow.mockReset().mockResolvedValue({ recorded: true });
  m.submit.mockResolvedValue({ id: "order", client_order_id: "client", status: "new" }); m.risk.mockReturnValue({ allowed: true, quantity: 1, debit: 95, equity: 100000, dayPnl: 0 });
});
afterEach(() => vi.useRealTimers());
describe("entry gate rollout", () => {
  it.each([undefined, "shadow", "unknown", null])("records and enters with mode %s", async mode => {
    m.control = { entry_gate_mode: mode }; expect((await runAutoEntry(snap(), "TSLA")).entered).toBeTruthy(); expect(m.submit).toHaveBeenCalledOnce();
    expect(m.shadow).not.toHaveBeenCalled(); // the Signal Feed's skip ledger is left for genuine skips
    expect(m.inserts[0].risk_snapshot).toMatchObject({ entryGate: { mode: "shadow", score: .8, threshold: .6, wouldSkip: true } });
  });
  it("enforces explicit enforce and preserves skip trail", async () => {
    m.control = { entry_gate_mode: "enforce" }; expect((await runAutoEntry(snap(), "TSLA")).skipped).toContain("entry scorer:"); expect(m.submit).not.toHaveBeenCalled(); expect(m.shadow).toHaveBeenCalledOnce();
  });
  it("journals passing opinions", async () => {
    m.score.mockReturnValue({ prob: .2, threshold: .6, skip: false, legPct: null }); await runAutoEntry(snap(), "TSLA"); expect(m.shadow).not.toHaveBeenCalled(); expect(m.inserts[0].risk_snapshot).toMatchObject({ entryGate: { score: .2, wouldSkip: false } });
  });
  it("does not let ledger failure veto", async () => {
    m.shadow.mockRejectedValue(new Error("ledger offline")); expect((await runAutoEntry(snap(), "TSLA")).entered).toBeTruthy();
  });
  it("leaves the skip ledger free for a genuine skip after a shadow opinion", async () => {
    m.control = { entry_gate_mode: "shadow" }; await runAutoEntry(snap(), "TSLA");
    expect(m.shadow.mock.calls.every(call => !String(call[0]?.skipReason ?? "").includes("entry scorer"))).toBe(true);
  });
  it("journals shadow score failure and enters", async () => {
    m.score.mockImplementation(() => { throw new Error("score failed"); }); expect((await runAutoEntry(snap(), "TSLA")).entered).toBeTruthy(); expect(m.inserts[0].risk_snapshot).toMatchObject({ entryGate: { mode: "shadow", error: "score failed" } });
  });
  it("respects kill switch", async () => {
    m.control = { kill_switch: true }; expect((await runAutoEntry(snap(), "TSLA")).skipped).toBe("kill switch"); expect(m.score).not.toHaveBeenCalled(); expect(m.submit).not.toHaveBeenCalled();
  });
  it("respects risk gates", async () => {
    m.risk.mockReturnValue({ allowed: false, errors: ["buying power"] }); expect((await runAutoEntry(snap(), "TSLA")).skipped).toBe("buying power"); expect(m.submit).not.toHaveBeenCalled();
  });
  it("does not let scorer module loading failure veto a shadow entry", async () => {
    vi.resetModules();
    vi.doMock("@/lib/ml/entry-gate", () => { throw new Error("model unavailable"); });
    try {
      expect((await runAutoEntry(snap(), "TSLA")).entered).toBeTruthy();
      expect(m.inserts[0].risk_snapshot).toMatchObject({ entryGate: { mode: "shadow", error: expect.stringContaining("mocking a module") } });
    } finally {
      vi.doUnmock("@/lib/ml/entry-gate"); vi.resetModules();
    }
  });

});

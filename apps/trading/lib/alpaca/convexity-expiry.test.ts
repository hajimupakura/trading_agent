import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/alerts/server", () => ({ createAlert: async () => undefined }));
vi.mock("./paper", () => ({}));
vi.mock("@/lib/settings/risk-settings", () => ({}));
vi.mock("@/lib/options/provider", () => ({}));
vi.mock("@/lib/market/calendar-server", () => ({}));
import { pickExpiry } from "./convexity-sleeve";
import { MarketCalendar } from "@/lib/market/calendar";

describe("swarm expiry choice", () => {
  const calendar = new MarketCalendar();
  it("takes the nearest Friday at least 3 days out", () => expect(pickExpiry("2026-11-23", calendar)).toEqual({ expiration: "2026-11-27", dte: 4 }));
  it("rolls Wednesday to next week's Friday", () => expect(pickExpiry("2026-11-25", calendar)).toEqual({ expiration: "2026-12-04", dte: 9 }));
  it("uses Thursday when that Friday is a market holiday (Good Friday 2027)", () => expect(pickExpiry("2027-03-22", calendar)).toEqual({ expiration: "2027-03-25", dte: 3 }));
});

import { describe, expect, it } from "vitest";
import { sessionCloseMs } from "./session-time";

describe("sessionCloseMs", () => {
  it("is 16:10 New York time in winter (EST) and in summer (EDT)", () => {
    expect(new Date(sessionCloseMs("2026-11-27")).toISOString()).toBe("2026-11-27T21:10:00.000Z");
    expect(new Date(sessionCloseMs("2026-08-17")).toISOString()).toBe("2026-08-17T20:10:00.000Z");
  });
});

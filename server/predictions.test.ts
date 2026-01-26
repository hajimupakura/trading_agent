import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createTestContext(user?: AuthenticatedUser): TrpcContext {
  const defaultUser: AuthenticatedUser = {
    id: 1,
    openId: "test-user",
    email: "test@example.com",
    name: "Test User",
    loginMethod: "manus",
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };

  return {
    user: user || defaultUser,
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

describe("Rally Predictions", () => {
  it("should fetch predicted rallies", async () => {
    const ctx = createTestContext();
    const caller = appRouter.createCaller(ctx);

    const predictions = await caller.predictions.upcoming();

    expect(Array.isArray(predictions)).toBe(true);
  });

  it("should generate new predictions", async () => {
    const ctx = createTestContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.predictions.generate();

    expect(result).toHaveProperty("success");
    expect(result.success).toBe(true);
    expect(result).toHaveProperty("count");
    expect(typeof result.count).toBe("number");
  }, 60000); // 60 second timeout for AI prediction generation
});

describe("Sector Discovery", () => {
  it("should discover emerging sectors", async () => {
    const ctx = createTestContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.sectors.discover();

    expect(result).toHaveProperty("sectors");
    expect(Array.isArray(result.sectors)).toBe(true);
    expect(result).toHaveProperty("count");
    expect(typeof result.count).toBe("number");
  }, 60000); // 60 second timeout for AI sector discovery
});

describe("YouTube Tracking", () => {
  it("should fetch recent YouTube videos", async () => {
    const ctx = createTestContext();
    const caller = appRouter.createCaller(ctx);

    const videos = await caller.youtube.recentVideos();

    expect(Array.isArray(videos)).toBe(true);
  });

  it("should sync YouTube videos", async () => {
    const ctx = createTestContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.youtube.syncVideos();

    expect(result).toHaveProperty("success");
    expect(result.success).toBe(true);
    expect(result).toHaveProperty("count");
    expect(typeof result.count).toBe("number");
  }, 60000); // 60 second timeout for AI video analysis
});

describe("YouTube Influencers", () => {
  it("should add YouTube influencer", async () => {
    const ctx = createTestContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.youtube.addInfluencer({
      userId: 1,
      channelId: "test_channel_123",
      channelName: "Test Trading Channel",
      channelUrl: "https://youtube.com/@test",
    });

    expect(result).toHaveProperty("success");
    expect(result.success).toBe(true);
  });

  it("should fetch user's YouTube influencers", async () => {
    const ctx = createTestContext();
    const caller = appRouter.createCaller(ctx);

    const influencers = await caller.youtube.influencers({ userId: 1 });

    expect(Array.isArray(influencers)).toBe(true);
  });
});

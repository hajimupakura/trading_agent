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

describe("News Feed", () => {
  it("should fetch recent news articles", async () => {
    const ctx = createTestContext();
    const caller = appRouter.createCaller(ctx);

    const news = await caller.news.recent();

    expect(Array.isArray(news)).toBe(true);
    expect(news.length).toBeGreaterThan(0);
    
    if (news.length > 0) {
      const article = news[0];
      expect(article).toHaveProperty("id");
      expect(article).toHaveProperty("title");
      expect(article).toHaveProperty("source");
      expect(article).toHaveProperty("publishedAt");
    }
  });

  it("should analyze news articles with AI", async () => {
    const ctx = createTestContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.news.analyze();

    expect(result).toHaveProperty("success");
    expect(result.success).toBe(true);
    expect(result).toHaveProperty("count");
    expect(typeof result.count).toBe("number");
  }, 30000); // 30 second timeout for AI analysis
});

describe("Watchlist", () => {
  it("should fetch user watchlist", async () => {
    const ctx = createTestContext();
    const caller = appRouter.createCaller(ctx);

    const watchlist = await caller.watchlist.list();

    expect(Array.isArray(watchlist)).toBe(true);
  });

  it("should add stock to watchlist", async () => {
    const ctx = createTestContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.watchlist.add({
      ticker: "NVDA",
      name: "NVIDIA Corporation",
      isPriority: true,
    });

    expect(result).toHaveProperty("success");
    expect(result.success).toBe(true);
  });

  it("should handle priority stocks correctly", async () => {
    const ctx = createTestContext();
    const caller = appRouter.createCaller(ctx);

    // Add priority stock
    await caller.watchlist.add({
      ticker: "GOOGL",
      name: "Alphabet Inc",
      isPriority: true,
    });

    const watchlist = await caller.watchlist.list();
    const googleStock = watchlist.find(s => s.ticker === "GOOGL");

    expect(googleStock).toBeDefined();
    if (googleStock) {
      expect(googleStock.isPriority).toBe(1);
    }
  });
});

describe("ARK Trades", () => {
  it("should fetch recent ARK trades", async () => {
    const ctx = createTestContext();
    const caller = appRouter.createCaller(ctx);

    const trades = await caller.ark.recentTrades();

    expect(Array.isArray(trades)).toBe(true);
    expect(trades.length).toBeGreaterThan(0);
    
    if (trades.length > 0) {
      const trade = trades[0];
      expect(trade).toHaveProperty("id");
      expect(trade).toHaveProperty("ticker");
      expect(trade).toHaveProperty("fund");
      expect(trade).toHaveProperty("direction");
      expect(["buy", "sell"]).toContain(trade.direction);
    }
  });

  it("should sync new ARK trades", async () => {
    const ctx = createTestContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.ark.syncTrades();

    expect(result).toHaveProperty("success");
    expect(result.success).toBe(true);
    expect(result).toHaveProperty("count");
    expect(typeof result.count).toBe("number");
  });
});

describe("Rally Events", () => {
  it("should fetch rally events", async () => {
    const ctx = createTestContext();
    const caller = appRouter.createCaller(ctx);

    const rallies = await caller.rallies.list();

    expect(Array.isArray(rallies)).toBe(true);
    expect(rallies.length).toBeGreaterThan(0);
    
    if (rallies.length > 0) {
      const rally = rallies[0];
      expect(rally).toHaveProperty("id");
      expect(rally).toHaveProperty("name");
      expect(rally).toHaveProperty("sector");
      expect(rally).toHaveProperty("startDate");
      expect(rally).toHaveProperty("status");
    }
  });

  it("should filter rallies by status", async () => {
    const ctx = createTestContext();
    const caller = appRouter.createCaller(ctx);

    const ongoingRallies = await caller.rallies.list({ status: "ongoing" });
    const endedRallies = await caller.rallies.list({ status: "ended" });

    expect(Array.isArray(ongoingRallies)).toBe(true);
    expect(Array.isArray(endedRallies)).toBe(true);
    
    // Check that all ongoing rallies have correct status
    ongoingRallies.forEach(rally => {
      expect(rally.status).toBe("ongoing");
    });
    
    // Check that all ended rallies have correct status
    endedRallies.forEach(rally => {
      expect(rally.status).toBe("ended");
    });
  });

  it("should provide rally insights", async () => {
    const ctx = createTestContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.rallies.insights({ sector: "ai" });

    expect(result).toHaveProperty("insights");
    expect(typeof result.insights).toBe("string");
    expect(result.insights.length).toBeGreaterThan(0);
  });
});

describe("Alerts", () => {
  it("should fetch user alerts", async () => {
    const ctx = createTestContext();
    const caller = appRouter.createCaller(ctx);

    const alerts = await caller.alerts.list();

    expect(Array.isArray(alerts)).toBe(true);
  });

  it("should filter unread alerts", async () => {
    const ctx = createTestContext();
    const caller = appRouter.createCaller(ctx);

    const unreadAlerts = await caller.alerts.list({ unreadOnly: true });

    expect(Array.isArray(unreadAlerts)).toBe(true);
    
    // All returned alerts should be unread
    unreadAlerts.forEach(alert => {
      expect(alert.isRead).toBe(0);
    });
  });
});

describe("Sector Momentum", () => {
  it("should fetch sector momentum data", async () => {
    const ctx = createTestContext();
    const caller = appRouter.createCaller(ctx);

    const momentum = await caller.sectors.momentum();

    expect(Array.isArray(momentum)).toBe(true);
  });
});

describe("Authentication", () => {
  it("should return current user info", async () => {
    const ctx = createTestContext();
    const caller = appRouter.createCaller(ctx);

    const user = await caller.auth.me();

    expect(user).toBeDefined();
    expect(user).toHaveProperty("id");
    expect(user).toHaveProperty("email");
    expect(user?.email).toBe("test@example.com");
  });

  it("should logout successfully", async () => {
    const clearedCookies: Array<{ name: string }> = [];
    
    const ctx: TrpcContext = {
      user: {
        id: 1,
        openId: "test-user",
        email: "test@example.com",
        name: "Test User",
        loginMethod: "manus",
        role: "user",
        createdAt: new Date(),
        updatedAt: new Date(),
        lastSignedIn: new Date(),
      },
      req: {
        protocol: "https",
        headers: {},
      } as TrpcContext["req"],
      res: {
        clearCookie: (name: string) => {
          clearedCookies.push({ name });
        },
      } as TrpcContext["res"],
    };

    const caller = appRouter.createCaller(ctx);
    const result = await caller.auth.logout();

    expect(result).toHaveProperty("success");
    expect(result.success).toBe(true);
    expect(clearedCookies.length).toBeGreaterThan(0);
  });
});

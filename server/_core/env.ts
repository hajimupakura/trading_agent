import { z } from "zod";

const envSchema = z.object({
  VITE_APP_ID: z.string().default(""),
  JWT_SECRET: z.string().min(1, "JWT_SECRET is required"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  OAUTH_SERVER_URL: z.string().default(""),
  OWNER_OPEN_ID: z.string().default(""),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  BUILT_IN_FORGE_API_URL: z.string().default(""),
  BUILT_IN_FORGE_API_KEY: z.string().default(""),
  FINNHUB_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  AGENT_PORTFOLIO_ID: z.string().optional(),
  AGENT_USER_ID: z.string().optional(),
});

// In test/dev, provide defaults for required vars so env parsing doesn't crash
const isProduction = process.env.NODE_ENV === "production";
const envWithDefaults = isProduction
  ? process.env
  : {
      ...process.env,
      JWT_SECRET: process.env.JWT_SECRET || "dev-fallback",
      DATABASE_URL: process.env.DATABASE_URL || "file:./dev.db",
    };

const parsed = envSchema.safeParse(envWithDefaults);

if (!parsed.success) {
  console.error("[ENV] Missing or invalid environment variables:");
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  }
  if (isProduction) {
    throw new Error("Invalid environment configuration");
  }
}

const env = parsed.success ? parsed.data : envSchema.parse(envWithDefaults);

export const ENV = {
  appId: env.VITE_APP_ID,
  cookieSecret: env.JWT_SECRET,
  databaseUrl: env.DATABASE_URL,
  oAuthServerUrl: env.OAUTH_SERVER_URL,
  ownerOpenId: env.OWNER_OPEN_ID,
  isProduction: env.NODE_ENV === "production",
  forgeApiUrl: env.BUILT_IN_FORGE_API_URL,
  forgeApiKey: env.BUILT_IN_FORGE_API_KEY,
  finnhubApiKey: env.FINNHUB_API_KEY,
  openrouterApiKey: env.OPENROUTER_API_KEY,
  telegramBotToken: env.TELEGRAM_BOT_TOKEN,
  telegramChatId: env.TELEGRAM_CHAT_ID,
  agentPortfolioId: env.AGENT_PORTFOLIO_ID,
  agentUserId: env.AGENT_USER_ID,
};

import { z } from "zod";

const schema = z.object({
  ALPACA_API_KEY_ID:z.string().min(1), ALPACA_API_SECRET_KEY:z.string().min(1), MASSIVE_API_KEY:z.string().min(1),
  SUPABASE_SECRET_KEY:z.string().min(1), SUPABASE_URL:z.string().url().optional(), NEXT_PUBLIC_SUPABASE_URL:z.string().url().optional(),
  PAPER_AUTO_EXITS_ENABLED:z.enum(["true","false"]).default("true"), POSITION_POLL_INTERVAL_MS:z.coerce.number().int().min(2000).max(30000).default(5000),
  PORT:z.coerce.number().int().positive().default(3001), MANAGER_INSTANCE_ID:z.string().default("railway-primary"),
});

const parsed = schema.parse(process.env);
const supabaseUrl = parsed.SUPABASE_URL ?? parsed.NEXT_PUBLIC_SUPABASE_URL;
if (!supabaseUrl) throw new Error("SUPABASE_URL is required");
export const config = { ...parsed, supabaseUrl, exitsEnabled:parsed.PAPER_AUTO_EXITS_ENABLED === "true" };

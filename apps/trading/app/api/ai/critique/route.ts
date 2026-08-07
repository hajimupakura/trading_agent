import { z } from "zod";
import { getAuthenticatedUser } from "@/lib/supabase/auth";
import { loadRiskSettings } from "@/lib/settings/risk-settings";
import { aiConfigured } from "@/lib/ai/openrouter";
import { critiqueTicket } from "@/lib/ai/review";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Devil's-advocate read of a manual ticket before the user approves it. Advisory only:
// the deterministic gates (risk caps, economic guard, kill switch) still decide.
const schema = z.object({
  underlying: z.string().min(1).max(8),
  ticker: z.string().min(4).max(40),
  side: z.enum(["call", "put"]),
  strike: z.number().positive(),
  expirationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dte: z.number().int().min(0).max(1000),
  quantity: z.number().int().min(1).max(10),
  limitPrice: z.number().min(0.01).max(500),
});

export async function POST(request: Request) {
  const user = await getAuthenticatedUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid ticket" }, { status: 400 });
  try {
    const settings = await loadRiskSettings(user.id);
    if (!settings.aiReviewEnabled) return Response.json({ error: "AI review is disabled — enable it in Settings." }, { status: 422 });
    if (!aiConfigured()) return Response.json({ error: "OPENROUTER_API_KEY is not configured on the server." }, { status: 422 });
    const critique = await critiqueTicket(parsed.data);
    return Response.json({ ok: true, critique });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Critique failed" }, { status: 502 });
  }
}

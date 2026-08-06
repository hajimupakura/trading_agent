import { refreshCommandCenter } from "@/lib/options/command-center";
import type { Underlying } from "@/lib/options/types";
import { getAuthenticatedUser } from "@/lib/supabase/auth";
import {loadRiskSettings} from "@/lib/settings/risk-settings";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const user=await getAuthenticatedUser();if(!user) return Response.json({ error:"Unauthorized" }, { status:401 });
  const symbol = new URL(request.url).searchParams.get("underlying");
  const underlying: Underlying = symbol === "SPX" ? "SPX" : "SPY";
  return Response.json(await refreshCommandCenter(underlying,await loadRiskSettings(user.id)), { headers:{ "Cache-Control":"no-store" } });
}

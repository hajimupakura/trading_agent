import { refreshCommandCenter } from "@/lib/options/command-center";
import type { Underlying } from "@/lib/options/types";
import { getAuthenticatedUser } from "@/lib/supabase/auth";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  if (!await getAuthenticatedUser()) return Response.json({ error:"Unauthorized" }, { status:401 });
  const symbol = new URL(request.url).searchParams.get("underlying");
  const underlying: Underlying = symbol === "SPX" ? "SPX" : "SPY";
  return Response.json(await refreshCommandCenter(underlying), { headers:{ "Cache-Control":"no-store" } });
}

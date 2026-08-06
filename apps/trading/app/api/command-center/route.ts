import { createClient } from "@/lib/supabase/server";
import { refreshCommandCenter } from "@/lib/options/command-center";
import type { Underlying } from "@/lib/options/types";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const supabase = await createClient(); const { data } = await supabase.auth.getClaims();
  if (!data?.claims?.sub) return Response.json({ error:"Unauthorized" }, { status:401 });
  const symbol = new URL(request.url).searchParams.get("underlying");
  const underlying: Underlying = symbol === "SPX" ? "SPX" : "SPY";
  return Response.json(await refreshCommandCenter(underlying), { headers:{ "Cache-Control":"no-store" } });
}

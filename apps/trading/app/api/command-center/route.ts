import { refreshCommandCenter } from "@/lib/options/command-center";
import type { Underlying } from "@/lib/options/types";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const symbol = new URL(request.url).searchParams.get("underlying");
  const underlying: Underlying = symbol === "SPX" ? "SPX" : "SPY";
  return Response.json(await refreshCommandCenter(underlying), { headers:{ "Cache-Control":"no-store" } });
}

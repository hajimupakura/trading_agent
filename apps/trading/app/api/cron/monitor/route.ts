import { refreshCommandCenter } from "@/lib/options/command-center";

export const maxDuration = 60;
export async function GET(request: Request) {
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) return new Response("Unauthorized", { status:401 });
  const results = await Promise.allSettled([refreshCommandCenter("SPY"), refreshCommandCenter("SPX")]);
  return Response.json({ ok:results.every(result => result.status === "fulfilled"), refreshed:["SPY","SPX"], at:new Date().toISOString() });
}

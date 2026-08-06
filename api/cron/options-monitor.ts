import type { Request, Response } from "express";
import { refreshOptionsCommandCenter } from "../../server/services/options/optionsMonitor";

export default async function handler(req: Request, res: Response) {
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });
  const expected = process.env.CRON_SECRET;
  if (!expected || req.headers.authorization !== `Bearer ${expected}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const results = await Promise.allSettled([
    refreshOptionsCommandCenter("SPY"),
    refreshOptionsCommandCenter("SPX"),
  ]);
  return res.status(200).json({
    ok: results.every(result => result.status === "fulfilled"),
    refreshed: ["SPY", "SPX"],
    at: new Date().toISOString(),
  });
}

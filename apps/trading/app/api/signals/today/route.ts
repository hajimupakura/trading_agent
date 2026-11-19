import { getAuthenticatedUser } from "@/lib/supabase/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

// Signal Feed: today's engine fires — actual paper entries plus shadow-tracked
// skips (with what each skip would have done). Server-only tables, so the read
// happens with the admin client after the session check.
export async function GET() {
  const user = await getAuthenticatedUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const admin = createAdminClient();
  const etDay = (value: string | Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(value));
  const today = etDay(new Date());
  const since = new Date(Date.now() - 36 * 3_600_000).toISOString();
  const [{ data: orders, error: ordersError }, { data: shadows, error: shadowsError }] = await Promise.all([
    admin.from("paper_trade_orders").select("action,contract_ticker,quantity,limit_price,status,risk_snapshot,created_at")
      .eq("user_id", user.id).eq("action", "buy_to_open").gte("created_at", since).order("created_at", { ascending: false }).limit(30),
    admin.from("signal_shadow_ledger").select("action,setup,contract_ticker,entry_ask,last_bid,peak_bid,skip_reason,status,created_at")
      .gte("created_at", since).order("created_at", { ascending: false }).limit(30),
  ]);
  if (ordersError || shadowsError) return Response.json({ error: (ordersError ?? shadowsError)!.message }, { status: 500 });
  const feed = [
    ...(orders ?? []).filter(row => etDay(String(row.created_at)) === today).map(row => ({
      kind: "traded" as const, at: String(row.created_at),
      action: /\d{6}P\d{8}$/.test(String(row.contract_ticker).replace("O:", "")) ? "enter_put" : "enter_call",
      setup: String((row.risk_snapshot as { strategy?: string } | null)?.strategy ?? "entry"),
      ticker: String(row.contract_ticker), quantity: Number(row.quantity), price: Number(row.limit_price), status: String(row.status),
    })),
    ...(shadows ?? []).filter(row => etDay(String(row.created_at)) === today).map(row => ({
      kind: "skipped" as const, at: String(row.created_at), action: String(row.action), setup: String(row.setup),
      ticker: String(row.contract_ticker), price: Number(row.entry_ask),
      lastBid: row.last_bid == null ? null : Number(row.last_bid), peakBid: row.peak_bid == null ? null : Number(row.peak_bid),
      skipReason: String(row.skip_reason), status: String(row.status),
    })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return Response.json({ feed }, { headers: { "Cache-Control": "no-store" } });
}

import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { getRobinhoodAccounts, getRobinhoodOverview, parseToolData, reviewAndPlaceOptionOrder } from "@/lib/brokers/robinhood-trading";
import { callRobinhoodTool } from "@/lib/brokers/robinhood";
import { createAlert } from "@/lib/alerts/server";

// Broker I/O proxy for the Railway exit worker (Bearer CRON_SECRET). The worker owns
// the exit rules and timing; this endpoint owns the Robinhood tokens (only decryptable
// at app runtime) and performs the actual MCP calls.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(request: Request) {
  return Boolean(process.env.CRON_SECRET) && request.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`;
}

async function connectionUserId() {
  const { data, error } = await createAdminClient().from("broker_connections").select("user_id").eq("broker", "robinhood").eq("status", "connected").limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  return data?.user_id as string | undefined;
}

const occTicker = (chainSymbol: string, expirationDate: string, type: "call" | "put", strike: number) =>
  `O:${chainSymbol}${expirationDate.slice(2).replaceAll("-", "")}${type === "call" ? "C" : "P"}${String(Math.round(strike * 1000)).padStart(8, "0")}`;

export async function GET(request: Request) {
  if (!authorized(request)) return new Response("Unauthorized", { status:401 });
  try {
    const userId = await connectionUserId();
    if (!userId) return Response.json({ connected:false, positions:[] });
    const accounts = await getRobinhoodAccounts(userId);
    const agentic = accounts.find((account:any) => account?.agentic_allowed === true || account?.agentic_allowed === "true");
    if (!agentic?.account_number) return Response.json({ connected:true, positions:[], error:"no agentic account" });
    const accountNumber = String(agentic.account_number);
    const { positions, orders } = await getRobinhoodOverview(userId, accountNumber);
    const longs = positions.filter((position:any) => (position?.type ?? "long") === "long" && Number(position?.quantity) > 0);
    // Enrich with instrument details (strike/expiration/type) for OCC quote lookups.
    const ids = [...new Set(longs.map((position:any) => String(position.option_id ?? position.option ?? "").split("/").filter(Boolean).pop()).filter(Boolean))];
    let instruments: any[] = [];
    if (ids.length) {
      const parsed = parseToolData(await callRobinhoodTool(userId, "get_option_instruments", { ids: ids.join(",") }));
      instruments = Array.isArray(parsed) ? parsed : parsed?.instruments ?? parsed?.results ?? [];
    }
    const enriched = longs.map((position:any) => {
      const optionId = String(position.option_id ?? position.option ?? "").split("/").filter(Boolean).pop() ?? "";
      const instrument = instruments.find((item:any) => item?.id === optionId) ?? {};
      const chainSymbol = String(instrument.chain_symbol ?? position.chain_symbol ?? "");
      const type = (instrument.type ?? "call") as "call" | "put";
      const strike = Number(instrument.strike_price ?? 0);
      const expirationDate = String(instrument.expiration_date ?? "");
      return {
        optionId, accountNumber, chainSymbol, optionType:type, strike, expirationDate,
        occTicker: chainSymbol && expirationDate ? occTicker(chainSymbol, expirationDate, type, strike) : null,
        quantity: Number(position.quantity), entryPrice: Number(position.average_price ?? position.average_open_price ?? 0),
      };
    }).filter(position => position.occTicker && position.entryPrice > 0);
    const optionOrders = orders.map((order:any) => ({
      id: String(order.id ?? ""), state: String(order.state ?? ""),
      createdAt: order.created_at ?? null, optionIds: (order.legs ?? []).map((leg:any) => String(leg.option ?? leg.option_id ?? "").split("/").filter(Boolean).pop()),
      side: order.legs?.[0]?.side ?? null, positionEffect: order.legs?.[0]?.position_effect ?? null, price: order.price ?? null,
    }));
    return Response.json({ connected:true, accountNumber, positions:enriched, orders:optionOrders }, { headers:{ "Cache-Control":"no-store" } });
  } catch (error) {
    return Response.json({ error:error instanceof Error ? error.message : "rh-exec overview failed" }, { status:502 });
  }
}

const actionSchema = z.discriminatedUnion("op", [
  z.object({ op:z.literal("close"), accountNumber:z.string().min(4), optionId:z.string().min(8), chainSymbol:z.string().min(1).max(8), underlyingType:z.enum(["equity","index"]), quantity:z.number().int().min(1).max(100), limitPrice:z.number().min(0.01).max(2000), refId:z.string().uuid(), reason:z.string().max(60) }),
  z.object({ op:z.literal("cancel"), accountNumber:z.string().min(4), orderId:z.string().min(8) }),
]);

export async function POST(request: Request) {
  if (!authorized(request)) return new Response("Unauthorized", { status:401 });
  const parsed = actionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error:"bad action" }, { status:400 });
  try {
    const userId = await connectionUserId();
    if (!userId) return Response.json({ error:"robinhood not connected" }, { status:409 });
    if (parsed.data.op === "cancel") {
      await callRobinhoodTool(userId, "cancel_option_order", { account_number:parsed.data.accountNumber, order_id:parsed.data.orderId });
      return Response.json({ ok:true });
    }
    const { order } = await reviewAndPlaceOptionOrder(userId, {
      accountNumber:parsed.data.accountNumber, optionId:parsed.data.optionId, side:"sell", positionEffect:"close",
      quantity:parsed.data.quantity, limitPrice:parsed.data.limitPrice, chainSymbol:parsed.data.chainSymbol,
      underlyingType:parsed.data.underlyingType, refId:parsed.data.refId,
    });
    await createAlert({
      userId, eventKey:`rh-exit-${parsed.data.refId}`, severity:"warning", title:"Robinhood exit submitted",
      body:`SELL ${parsed.data.quantity} ${parsed.data.chainSymbol} at a $${parsed.data.limitPrice.toFixed(2)} limit · ${parsed.data.reason.replaceAll("_"," ")}`,
      metadata:{ refId:parsed.data.refId, reason:parsed.data.reason, order },
    }).catch(error => console.error("rh exit alert failed", error));
    return Response.json({ ok:true, order });
  } catch (error) {
    return Response.json({ error:error instanceof Error ? error.message : "rh-exec action failed" }, { status:502 });
  }
}

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
    // Tolerant agentic detection: flag variants and type-named accounts both count.
    const agentic = accounts.find((account:any) =>
      [account?.agentic_allowed, account?.is_agentic].some(flag => flag === true || flag === "true" || flag === 1)
      || String(account?.account_type ?? account?.type ?? "").toLowerCase().includes("agentic"));
    if (!agentic?.account_number) {
      const summary = accounts.map((account:any) => ({ tail:String(account?.account_number ?? "").slice(-4), type:account?.account_type ?? account?.type ?? null, agentic:account?.agentic_allowed ?? account?.is_agentic ?? null }));
      return Response.json({ connected:true, positions:[], error:`no agentic account among ${accounts.length}: ${JSON.stringify(summary).slice(0, 400)}` });
    }
    const accountNumber = String(agentic.account_number);
    const { portfolio, positions, positionsShape, orders } = await getRobinhoodOverview(userId, accountNumber);
    // Persist the portfolio read (cash / buying power / total) so dashboards and
    // research can see account state without another broker round-trip.
    const adminDb = createAdminClient();
    await adminDb.from("broker_portfolio_snapshots").upsert({
      broker: "robinhood", payload: { ...portfolio, accountTail: accountNumber.slice(-4) }, updated_at: new Date().toISOString(),
    }).then(({ error }) => { if (error) console.error("rh portfolio snapshot failed", error.message); });
    // Ad-hoc instrument probes (diagnostics, e.g. the 0DTE tradability question):
    // rows inserted into rh_instrument_probes get answered here with Robinhood's raw
    // instrument state/tradability — the worker hits this endpoint every few seconds.
    const { data: probes } = await adminDb.from("rh_instrument_probes").select("id,chain_symbol,expiration_date,strike,type").eq("status", "pending").limit(3);
    for (const probe of probes ?? []) {
      try {
        const parsed = parseToolData(await callRobinhoodTool(userId, "get_option_instruments", {
          chain_symbol: probe.chain_symbol, expiration_dates: String(probe.expiration_date),
          strike_price: Number(probe.strike).toFixed(4), type: probe.type,
        }));
        const list: any[] = Array.isArray(parsed) ? parsed : parsed?.instruments ?? parsed?.results ?? (parsed && typeof parsed === "object" && parsed.id ? [parsed] : []);
        await adminDb.from("rh_instrument_probes").update({ status: "done", result: {
          count: list.length,
          instruments: list.slice(0, 2).map((item: any) => ({ id: item?.id, state: item?.state, tradability: item?.tradability, strike: item?.strike_price, expiry: item?.expiration_date })),
        } }).eq("id", probe.id);
      } catch (error) {
        await adminDb.from("rh_instrument_probes").update({ status: "error", result: { error: error instanceof Error ? error.message : String(error) } }).eq("id", probe.id);
      }
    }
    const longs = positions.filter((position:any) => (position?.type ?? "long") === "long" && Number(position?.quantity) > 0);
    // Enrich with instrument details (strike/expiration/type) for OCC quote lookups.
    const ids = [...new Set(longs.map((position:any) => String(position.option_id ?? position.option ?? "").split("/").filter(Boolean).pop()).filter(Boolean))];
    let instruments: any[] = [];
    if (ids.length) {
      const parsed = parseToolData(await callRobinhoodTool(userId, "get_option_instruments", { ids: ids.join(",") }));
      instruments = Array.isArray(parsed) ? parsed
        : parsed?.instruments ?? parsed?.results ?? (parsed && typeof parsed === "object" && (parsed.id || parsed.strike_price) ? [parsed] : []);
    }
    const enriched = longs.map((position:any) => {
      const optionId = String(position.option_id ?? position.option ?? "").split("/").filter(Boolean).pop() ?? "";
      const instrument = instruments.find((item:any) => item?.id === optionId || String(item?.url ?? "").includes(optionId) || item?.option_id === optionId) ?? {};
      const chainSymbol = String(instrument.chain_symbol ?? position.chain_symbol ?? "");
      const type = (instrument.type ?? "call") as "call" | "put";
      const strike = Number(instrument.strike_price ?? 0);
      const expirationDate = String(instrument.expiration_date ?? "");
      return {
        optionId, accountNumber, chainSymbol, optionType:type, strike, expirationDate,
        occTicker: chainSymbol && expirationDate ? occTicker(chainSymbol, expirationDate, type, strike) : null,
        // Robinhood reports average_price PER CONTRACT (the $2.05 option comes back as
        // 205.00); the exit engine works per share — normalize by the 100 multiplier.
        quantity: Number(position.quantity), entryPrice: Number(position.average_price ?? position.average_open_price ?? 0) / 100,
      };
    }).filter((position:any) => position.occTicker && position.entryPrice > 0);
    // Diagnostic covers EVERY drop path — a position must never vanish silently.
    const diag = enriched.length ? null
      : longs.length ? `enrichment dropped ${longs.length} position(s): instruments=${instruments.length}, ids=${JSON.stringify(ids)}, sampleInstrument=${JSON.stringify(instruments[0] ?? null).slice(0, 200)}, samplePosition=${JSON.stringify(longs[0]).slice(0, 300)}`
      : `no long option positions in ${accountNumber.slice(-4)} (shape ${positionsShape}; raw count ${positions.length}${positions.length ? `; sample=${JSON.stringify(positions[0]).slice(0, 300)}` : ""})`;
    const optionOrders = orders.map((order:any) => ({
      id: String(order.id ?? ""), state: String(order.state ?? ""),
      createdAt: order.created_at ?? null, optionIds: (order.legs ?? []).map((leg:any) => String(leg.option ?? leg.option_id ?? "").split("/").filter(Boolean).pop()),
      side: order.legs?.[0]?.side ?? null, positionEffect: order.legs?.[0]?.position_effect ?? null, price: order.price ?? null,
    }));
    return Response.json({ connected:true, accountNumber, positions:enriched, orders:optionOrders, diag }, { headers:{ "Cache-Control":"no-store" } });
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

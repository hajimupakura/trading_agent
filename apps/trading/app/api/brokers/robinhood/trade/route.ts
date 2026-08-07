import { z } from "zod";
import { getAuthenticatedUser } from "@/lib/supabase/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadRiskSettings } from "@/lib/settings/risk-settings";
import { resolveOptionInstrument, reviewAndPlaceOptionOrder } from "@/lib/brokers/robinhood-trading";
import { createAlert } from "@/lib/alerts/server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Manual Robinhood option order: the user builds/approves the ticket in the UI.
// Server gates: auth, kill switch (opens only), per-trade debit cap, sane bounds.
// NOTE: Robinhood positions are NOT yet covered by the automatic exit engine —
// the UI must (and does) say so.
const schema = z.object({
  accountNumber: z.string().min(4).max(30),
  chainSymbol: z.string().min(1).max(8),
  underlyingType: z.enum(["equity", "index"]),
  expirationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  strike: z.number().positive(),
  optionType: z.enum(["call", "put"]),
  side: z.enum(["buy", "sell"]),
  positionEffect: z.enum(["open", "close"]),
  quantity: z.number().int().min(1).max(10),
  limitPrice: z.number().min(0.01).max(500),
});

export async function POST(request: Request) {
  const user = await getAuthenticatedUser();
  if (!user) return Response.json({ error:"Unauthorized" }, { status:401 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error:"Invalid order ticket" }, { status:400 });
  const ticket = parsed.data;
  try {
    const admin = createAdminClient();
    if (ticket.positionEffect === "open") {
      const { data:control, error:controlError } = await admin.from("position_manager_control").select("kill_switch").eq("id", true).single();
      if (controlError) throw new Error(`Manager control unavailable: ${controlError.message}`);
      if (control.kill_switch) return Response.json({ error:"Emergency stop is active — new entries are disabled." }, { status:422 });
      const settings = await loadRiskSettings(user.id);
      const debit = ticket.quantity * ticket.limitPrice * 100;
      if (debit > settings.maxTradeDebit) return Response.json({ error:`Total debit $${debit.toFixed(0)} exceeds the $${settings.maxTradeDebit.toFixed(0)} per-trade limit` }, { status:422 });
    }
    const instrument = await resolveOptionInstrument(user.id, { chainSymbol:ticket.chainSymbol, expirationDate:ticket.expirationDate, strike:ticket.strike, type:ticket.optionType });
    const refId = crypto.randomUUID();
    const { review, order } = await reviewAndPlaceOptionOrder(user.id, {
      accountNumber:ticket.accountNumber, optionId:instrument.id, side:ticket.side, positionEffect:ticket.positionEffect,
      quantity:ticket.quantity, limitPrice:ticket.limitPrice, chainSymbol:ticket.chainSymbol, underlyingType:ticket.underlyingType, refId,
    });
    await createAlert({
      userId:user.id,
      eventKey:`robinhood-order-${refId}`,
      severity:"success",
      title:`Robinhood ${ticket.positionEffect === "open" ? "entry" : "close"} submitted`,
      body:`${ticket.side.toUpperCase()} ${ticket.quantity} ${ticket.chainSymbol} ${ticket.expirationDate} ${ticket.strike}${ticket.optionType === "call" ? "C" : "P"} at a $${ticket.limitPrice.toFixed(2)} limit. Automatic exits do NOT cover Robinhood yet — manage this position from the dashboard or the Robinhood app.`,
      metadata:{ refId, ticket, order },
    }).catch(error => console.error("Robinhood order alert failed", error));
    return Response.json({ ok:true, review, order });
  } catch (error) {
    return Response.json({ error:error instanceof Error ? error.message : "Robinhood order failed" }, { status:502 });
  }
}

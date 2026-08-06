import { config } from "./config.js";
import { evaluateExit, easternClock } from "./exit-engine.js";
import { getPositions, getSpyPrice, getTodayOrders, replaceCloseOrder, submitCloseOrder } from "./alpaca.js";
import { getSnapshotQuote, getSpxPrice, MassiveQuoteStream } from "./massive.js";
import { createWorkerAlert, getControl, getManagedPosition, heartbeat, journalExit, markMissingPositions, saveMonitor } from "./store.js";
import type { AlpacaOrder, OptionQuote } from "./types.js";

const activeOrder = (order:AlpacaOrder) => ["new","accepted","pending_new","partially_filled","accepted_for_bidding"].includes(order.status);
const marketSession = (now:Date) => { const clock = easternClock(now); return !["Sat","Sun"].includes(clock.weekday) && clock.minutes >= 570 && clock.minutes < 960; };
const fresh = (quote:OptionQuote|null,now:number) => quote && now - quote.timestamp <= 15_000 ? quote : null;
const clientOrderId = (symbol:string,reason:string,now:number) => `velocity-exit-${symbol}-${reason}-${now}`.replace(/[^a-zA-Z0-9_-]/g,"").slice(0,48);

export class PositionManager {
  readonly quotes = new MassiveQuoteStream(); lastCycleAt:number|null = null; lastError:string|null = null; managedCount = 0;
  start() { this.quotes.start(); void this.loop(); }
  stop() { this.quotes.stop(); }
  private async loop() {
    try { await this.cycle(); this.lastError = null; }
    catch (error) { this.lastError = error instanceof Error ? error.message : String(error); console.error(JSON.stringify({event:"manager_cycle_error",error:this.lastError})); }
    this.lastCycleAt = Date.now();
    try { await heartbeat({healthy:!this.lastError,positions:this.managedCount,lastError:this.lastError}); } catch (error) { console.error(JSON.stringify({event:"heartbeat_error",error:String(error)})); }
    setTimeout(() => void this.loop(),config.POSITION_POLL_INTERVAL_MS);
  }
  private async cycle() {
    const [positions,orders,control] = await Promise.all([getPositions(),getTodayOrders(),getControl()]);
    const optionPositions = positions.filter(position => position.asset_class === "us_option" && Number(position.qty) > 0);
    this.quotes.setSymbols(optionPositions.map(position => `O:${position.symbol}`)); this.managedCount = 0;
    await markMissingPositions(optionPositions.map(position => `O:${position.symbol}`),orders);
    // kill_switch halts NEW ENTRIES (enforced in the app's paper-trading route);
    // protective exits keep running regardless so an emergency stop never strands a position.
    const enabled = config.exitsEnabled && control.auto_exits_enabled;
    if (!enabled || !marketSession(new Date())) return;
    const needsSpx = optionPositions.some(position => position.symbol.startsWith("SPX"));
    const [spyPrice,spxPrice] = await Promise.all([getSpyPrice().catch(() => null), needsSpx ? getSpxPrice().catch(() => null) : Promise.resolve(null)]);
    const cycleErrors:string[] = [];
    for (const brokerPosition of optionPositions) {
      try {
        await this.managePosition(brokerPosition,orders,spyPrice,spxPrice);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        cycleErrors.push(`${brokerPosition.symbol}: ${message}`);
        console.error(JSON.stringify({event:"position_cycle_error",symbol:brokerPosition.symbol,error:message}));
      }
    }
    if (cycleErrors.length) throw new Error(cycleErrors.join(" | "));
  }
  private async managePosition(brokerPosition:{symbol:string;qty:string;avg_entry_price:string},orders:AlpacaOrder[],spyPrice:number|null,spxPrice:number|null) {
    const entryPrice = Number(brokerPosition.avg_entry_price); if (!(entryPrice > 0)) return;
    const position = await getManagedPosition(brokerPosition.symbol,entryPrice,orders); if (!position) return;
    position.quantity = Number(brokerPosition.qty); this.managedCount++;
    const now = Date.now(); const underlying = position.ticker.startsWith("O:SPX") ? "SPX":"SPY";
    const underlyingPrice = underlying === "SPX" ? spxPrice : spyPrice;
    const quote = fresh(this.quotes.get(position.ticker),now) ?? await getSnapshotQuote(underlying,position.ticker);
    if (!quote || now - quote.timestamp > 30_000) { await saveMonitor(position,{bid:0,ask:0,quoteAt:now,status:"error",error:"No fresh option quote"});await createWorkerAlert({userId:position.userId,signalId:position.signalId,eventKey:`quote-stale-${position.userId}-${position.ticker}-${position.openedAt}`,severity:"critical",title:"Option quote is stale",body:`Automatic exits cannot price ${position.ticker}. Check Alpaca and manage the position manually until data recovers.`,metadata:{contractTicker:position.ticker,openedAt:position.openedAt}}); throw new Error(`No fresh option quote for ${position.ticker}`); }
    const quoteState = {bid:quote.bid,ask:quote.ask,quoteAt:quote.timestamp};
    position.peakBid = Math.max(position.peakBid,quote.bid);
    const reason = evaluateExit({position,bid:quote.bid,underlyingPrice});
    const symbolOrders = orders.filter(order => order.symbol === position.alpacaSymbol && order.side === "sell");
    const openClose = symbolOrders.find(activeOrder); const recentlyFilled = symbolOrders.find(order => order.status === "filled" && order.filled_at && now-Date.parse(order.filled_at)<30_000);
    if (!reason) { await saveMonitor(position,{...quoteState,status:"monitoring"}); return; }
    // Urgent exits (hard stop / mandatory flat) price through the bid so they actually fill.
    const urgent = reason === "premium_stop" || reason === "mandatory_time_exit";
    const exitLimit = (aggressive:boolean) => Math.max(.01, Number((aggressive ? quote.bid * .95 : quote.bid).toFixed(2)));
    if (recentlyFilled) { const fill=Number(recentlyFilled.filled_avg_price ?? quote.bid);await journalExit(position,recentlyFilled,fill,reason);await createWorkerAlert({userId:position.userId,signalId:position.signalId,eventKey:`paper-exit-filled-${recentlyFilled.id}`,severity:"success",title:"Paper exit filled",body:`SELL ${position.quantity} ${position.alpacaSymbol} filled near $${fill.toFixed(2)} · ${reason.replaceAll("_"," ")}`,metadata:{orderId:recentlyFilled.id,contractTicker:position.ticker,fillPrice:fill,exitReason:reason}}); await saveMonitor(position,{...quoteState,status:"closing",exitReason:reason,closeOrderId:recentlyFilled.id}); return; }
    if (openClose) {
      const age = now-Date.parse(openClose.updated_at ?? openClose.created_at); const currentLimit = Number(openClose.limit_price);
      // Escalate after 30s working (or immediately for urgent reasons): cross 5% below the bid.
      const target = exitLimit(urgent || age >= 30_000);
      if (age >= 10_000 && Math.abs(currentLimit-target)>=.01) await replaceCloseOrder(openClose.id,target);
      await journalExit(position,openClose,currentLimit || quote.bid,reason);
      await createWorkerAlert({userId:position.userId,signalId:position.signalId,eventKey:`paper-exit-working-${openClose.id}`,severity:"warning",title:"Paper exit working",body:`SELL ${position.quantity} ${position.alpacaSymbol} is ${openClose.status} near $${(currentLimit||quote.bid).toFixed(2)} · ${reason.replaceAll("_"," ")}`,metadata:{orderId:openClose.id,contractTicker:position.ticker,limitPrice:currentLimit||quote.bid,exitReason:reason,status:openClose.status}});
      await saveMonitor(position,{...quoteState,status:"closing",exitReason:reason,closeOrderId:openClose.id}); return;
    }
    const submitLimit = exitLimit(urgent);
    let order:AlpacaOrder;try{order=await submitCloseOrder({symbol:position.alpacaSymbol,quantity:position.quantity,limitPrice:submitLimit,clientOrderId:clientOrderId(position.alpacaSymbol,reason,now)});}catch(error){await createWorkerAlert({userId:position.userId,signalId:position.signalId,eventKey:`paper-exit-failed-${position.userId}-${position.ticker}-${reason}-${Math.floor(now/300000)}`,severity:"critical",title:"Paper exit submission failed",body:`Could not submit SELL for ${position.alpacaSymbol}: ${error instanceof Error?error.message:String(error)}. Check Alpaca immediately.`,metadata:{contractTicker:position.ticker,exitReason:reason,bid:quote.bid}});throw error;}
    await journalExit(position,order,submitLimit,reason);
    await createWorkerAlert({userId:position.userId,signalId:position.signalId,eventKey:`paper-exit-submitted-${order.id}`,severity:"warning",title:"Paper exit submitted",body:`SELL ${position.quantity} ${position.alpacaSymbol} at a $${submitLimit.toFixed(2)} limit · ${reason.replaceAll("_"," ")}`,metadata:{orderId:order.id,contractTicker:position.ticker,limitPrice:submitLimit,exitReason:reason,status:order.status}});
    await saveMonitor(position,{...quoteState,status:"closing",exitReason:reason,closeOrderId:order.id});
    console.log(JSON.stringify({event:"paper_exit_submitted",symbol:position.alpacaSymbol,reason,limitPrice:submitLimit,orderId:order.id}));
  }
}

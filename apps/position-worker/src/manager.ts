import { config } from "./config.js";
import { evaluateExit, easternClock } from "./exit-engine.js";
import { getPositions, getSpyPrice, getTodayOrders, replaceCloseOrder, submitCloseOrder } from "./alpaca.js";
import { getSnapshotQuote, MassiveQuoteStream } from "./massive.js";
import { getControl, getManagedPosition, heartbeat, journalExit, markMissingPositions, saveMonitor } from "./store.js";
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
    await markMissingPositions(optionPositions.map(position => `O:${position.symbol}`));
    const enabled = config.exitsEnabled && control.auto_exits_enabled && !control.kill_switch;
    if (!enabled || !marketSession(new Date())) return;
    const spyPrice = await getSpyPrice().catch(() => null);
    for (const brokerPosition of optionPositions) {
      const entryPrice = Number(brokerPosition.avg_entry_price); if (!(entryPrice > 0)) continue;
      const position = await getManagedPosition(brokerPosition.symbol,entryPrice,orders); if (!position) continue;
      position.quantity = Number(brokerPosition.qty); this.managedCount++;
      const now = Date.now(); const underlying = position.ticker.startsWith("O:SPX") ? "SPX":"SPY";
      const quote = fresh(this.quotes.get(position.ticker),now) ?? await getSnapshotQuote(underlying,position.ticker);
      if (!quote || now - quote.timestamp > 30_000) { await saveMonitor(position,{bid:0,ask:0,quoteAt:now,status:"error",error:"No fresh option quote"}); throw new Error(`No fresh option quote for ${position.ticker}`); }
      const quoteState = {bid:quote.bid,ask:quote.ask,quoteAt:quote.timestamp};
      position.peakBid = Math.max(position.peakBid,quote.bid);
      const reason = evaluateExit({position,bid:quote.bid,spyPrice});
      const symbolOrders = orders.filter(order => order.symbol === position.alpacaSymbol && order.side === "sell");
      const openClose = symbolOrders.find(activeOrder); const recentlyFilled = symbolOrders.find(order => order.status === "filled" && order.filled_at && now-Date.parse(order.filled_at)<30_000);
      if (!reason) { await saveMonitor(position,{...quoteState,status:"monitoring"}); continue; }
      if (recentlyFilled) { await journalExit(position,recentlyFilled,Number(recentlyFilled.filled_avg_price ?? quote.bid),reason); await saveMonitor(position,{...quoteState,status:"closing",exitReason:reason,closeOrderId:recentlyFilled.id}); continue; }
      if (openClose) {
        const age = now-Date.parse(openClose.updated_at ?? openClose.created_at); const currentLimit = Number(openClose.limit_price);
        if (age >= 10_000 && Math.abs(currentLimit-quote.bid)>=.01) await replaceCloseOrder(openClose.id,quote.bid);
        await journalExit(position,openClose,currentLimit || quote.bid,reason);
        await saveMonitor(position,{...quoteState,status:"closing",exitReason:reason,closeOrderId:openClose.id}); continue;
      }
      const order = await submitCloseOrder({symbol:position.alpacaSymbol,quantity:position.quantity,limitPrice:quote.bid,clientOrderId:clientOrderId(position.alpacaSymbol,reason,now)});
      await journalExit(position,order,quote.bid,reason);
      await saveMonitor(position,{...quoteState,status:"closing",exitReason:reason,closeOrderId:order.id});
      console.log(JSON.stringify({event:"paper_exit_submitted",symbol:position.alpacaSymbol,reason,limitPrice:quote.bid,orderId:order.id}));
    }
  }
}

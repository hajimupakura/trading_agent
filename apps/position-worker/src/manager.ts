import { config } from "./config.js";
import { dteFromOcc, evaluateExit, easternClock } from "./exit-engine.js";
import { ENTRY_RULES, planEntryOrder } from "./entry-engine.js";
import { cancelOrder, getPositions, getSpyPrice, getTodayOrders, replaceCloseOrder, submitCloseOrder } from "./alpaca.js";
import { getSnapshotQuote, getSpxPrice, MassiveQuoteStream } from "./massive.js";
import { adoptBrokerPosition, createWorkerAlert, getControl, getEntryJournal, getManagedPosition, heartbeat, journalExit, markMissingPositions, saveMonitor, updateEntryJournal } from "./store.js";
import { RobinhoodExitManager } from "./robinhood.js";
import type { AlpacaOrder, OptionQuote } from "./types.js";

const activeOrder = (order:AlpacaOrder) => ["new","accepted","pending_new","partially_filled","accepted_for_bidding"].includes(order.status);
const marketSession = (now:Date) => { const clock = easternClock(now); return !["Sat","Sun"].includes(clock.weekday) && clock.minutes >= 570 && clock.minutes < 960; };
const fresh = (quote:OptionQuote|null,now:number) => quote && now - quote.timestamp <= 15_000 ? quote : null;
const clientOrderId = (symbol:string,reason:string,now:number) => `velocity-exit-${symbol}-${reason}-${now}`.replace(/[^a-zA-Z0-9_-]/g,"").slice(0,48);

export class PositionManager {
  readonly quotes = new MassiveQuoteStream(); readonly robinhood = new RobinhoodExitManager(); lastCycleAt:number|null = null; lastError:string|null = null; managedCount = 0; private rhSymbols:string[] = [];
  // Consecutive stale-quote cycles per ticker: a single miss (worker restart, stream
  // resubscribe) retries quietly; the critical alert fires only after the threshold.
  private quoteMisses = new Map<string, number>();
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
    const entryOrders = orders.filter(order => order.side === "buy" && activeOrder(order));
    this.quotes.setSymbols([...optionPositions.map(position => `O:${position.symbol}`), ...entryOrders.map(order => `O:${order.symbol}`), ...this.rhSymbols]); this.managedCount = 0;
    await markMissingPositions(optionPositions.map(position => `O:${position.symbol}`),orders);
    if (!marketSession(new Date())) return;
    const cycleErrors:string[] = [];
    // Working BUY orders are managed regardless of the exit toggle or kill switch —
    // an already-submitted entry must still be escalated toward the ask or canceled.
    for (const order of entryOrders) {
      try { await this.manageEntryOrder(order); }
      catch (error) { cycleErrors.push(`entry ${order.symbol}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    // kill_switch halts NEW ENTRIES (enforced in the app's paper-trading route);
    // protective exits keep running regardless so an emergency stop never strands a position.
    const enabled = config.exitsEnabled && control.auto_exits_enabled;
    if (!enabled) { if (cycleErrors.length) throw new Error(cycleErrors.join(" | ")); return; }
    const needsSpx = optionPositions.some(position => position.symbol.startsWith("SPX"));
    const [spyPrice,spxPrice] = await Promise.all([getSpyPrice().catch(() => null), needsSpx ? getSpxPrice().catch(() => null) : Promise.resolve(null)]);
    for (const brokerPosition of optionPositions) {
      try {
        await this.managePosition(brokerPosition,orders,spyPrice,spxPrice,control.auto_adopt_unmanaged !== false);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        cycleErrors.push(`${brokerPosition.symbol}: ${message}`);
        console.error(JSON.stringify({event:"position_cycle_error",symbol:brokerPosition.symbol,error:message}));
      }
    }
    // Robinhood agentic-account exits: same rules and cadence; broker I/O proxied
    // through the app's rh-exec endpoint. Errors surface without touching Alpaca work.
    try {
      const rh = await this.robinhood.cycle(this.quotes);
      this.rhSymbols = rh.symbols; this.managedCount += this.robinhood.managedCount;
      cycleErrors.push(...rh.errors);
    } catch (error) {
      cycleErrors.push(`robinhood: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (cycleErrors.length) throw new Error(cycleErrors.join(" | "));
  }
  private async manageEntryOrder(order:AlpacaOrder) {
    const ticker = `O:${order.symbol}`; const now = Date.now();
    const root = order.symbol.replace(/\d{6}[CP]\d{8}$/,"");
    const quote = fresh(this.quotes.get(ticker),now) ?? await getSnapshotQuote(root === "SPXW" ? "SPX" : root, ticker);
    if (!quote || now - quote.timestamp > 30_000) return; // no fresh quote — try again next cycle
    // Age from the journal's original submission time: an Alpaca replace creates a new
    // broker order with a reset created_at, which would otherwise restart the clock.
    const journal = await getEntryJournal(order.id);
    const ageMs = now - Date.parse(journal?.created_at ?? order.created_at);
    const plan = planEntryOrder({ ageMs, ask:quote.ask, midpoint:(quote.bid + quote.ask) / 2, currentLimit:Number(order.limit_price) });
    if (plan.action === "cancel") {
      await cancelOrder(order.id);
      await updateEntryJournal(order.id,{ status:"canceled" });
      if (journal) await createWorkerAlert({ userId:journal.user_id, signalId:journal.signal_id, eventKey:`paper-entry-canceled-${order.id}`, severity:"warning", title:"Entry canceled — not filled", body:`BUY ${order.symbol} did not fill within ${Math.round(ENTRY_RULES.cancelMs/1000)}s and was canceled; the signal that justified it is stale. No position was opened.`, metadata:{ orderId:order.id, contractTicker:ticker } });
      console.log(JSON.stringify({ event:"paper_entry_canceled", symbol:order.symbol, orderId:order.id, ageMs }));
    } else if (plan.action === "reprice") {
      const replaced = await replaceCloseOrder(order.id, plan.price);
      await updateEntryJournal(order.id,{ alpaca_order_id:replaced.id, limit_price:plan.price });
      console.log(JSON.stringify({ event:"paper_entry_repriced", symbol:order.symbol, orderId:order.id, newOrderId:replaced.id, price:plan.price, ageMs }));
    }
  }
  private async managePosition(brokerPosition:{symbol:string;qty:string;avg_entry_price:string},orders:AlpacaOrder[],spyPrice:number|null,spxPrice:number|null,autoAdopt:boolean) {
    const entryPrice = Number(brokerPosition.avg_entry_price); if (!(entryPrice > 0)) return;
    let position = await getManagedPosition(brokerPosition.symbol,entryPrice,orders);
    if (!position) {
      // No journal entry — this position was opened outside the app. Adopt it (when
      // enabled) so the standard stop/trail/time exits protect it from the broker's
      // average fill; otherwise leave it for the dashboard's unprotected banner.
      if (!autoAdopt) return;
      const ownerId = await adoptBrokerPosition(brokerPosition.symbol,entryPrice,Number(brokerPosition.qty));
      if (!ownerId) return;
      await createWorkerAlert({ userId:ownerId, signalId:null, eventKey:`position-adopted-${brokerPosition.symbol}-${new Date().toISOString().slice(0,10)}`, severity:"success", title:"Unmanaged position adopted — exits now active", body:`${brokerPosition.qty} × ${brokerPosition.symbol} was opened outside the app (likely directly in Alpaca). The worker adopted it at the $${entryPrice.toFixed(2)} average fill: 30% stop, trailing exits, and the standard time rules now apply. Close it manually anytime; disable auto-adoption from the dashboard if you want outside positions left alone.`, metadata:{ contractTicker:`O:${brokerPosition.symbol}`, entryPrice, quantity:Number(brokerPosition.qty) } });
      position = await getManagedPosition(brokerPosition.symbol,entryPrice,orders);
      if (!position) return;
    }
    position.quantity = Number(brokerPosition.qty); this.managedCount++;
    const now = Date.now();
    // Resolve the underlying from the OCC root so watch-ticker contracts (NVDA, SPCX, …)
    // quote correctly instead of being mistaken for SPY.
    const root = position.alpacaSymbol.replace(/\d{6}[CP]\d{8}$/,"");
    const underlying = root === "SPXW" ? "SPX" : root;
    const underlyingPrice = underlying === "SPX" ? spxPrice : underlying === "SPY" ? spyPrice : null;
    const quote = fresh(this.quotes.get(position.ticker),now) ?? await getSnapshotQuote(underlying,position.ticker);
    if (!quote || now - quote.timestamp > 30_000) {
      const misses = (this.quoteMisses.get(position.ticker) ?? 0) + 1;
      this.quoteMisses.set(position.ticker, misses);
      await saveMonitor(position,{bid:0,ask:0,quoteAt:now,status:"error",error:`No fresh option quote (${misses} consecutive)`});
      if (misses < 3) return; // transient (restart/resubscribe) — retry next cycle quietly
      await createWorkerAlert({userId:position.userId,signalId:position.signalId,eventKey:`quote-stale-${position.userId}-${position.ticker}-${position.openedAt}`,severity:"critical",title:"Option quote is stale",body:`Automatic exits cannot price ${position.ticker} (${misses} cycles without a fresh quote). Check Alpaca and manage the position manually until data recovers.`,metadata:{contractTicker:position.ticker,openedAt:position.openedAt}});
      throw new Error(`No fresh option quote for ${position.ticker}`);
    }
    this.quoteMisses.delete(position.ticker);
    const quoteState = {bid:quote.bid,ask:quote.ask,quoteAt:quote.timestamp};
    position.peakBid = Math.max(position.peakBid,quote.bid);
    const dte = dteFromOcc(position.alpacaSymbol);
    // TREND (ride) mode: MAX CONVEXITY — only the 50% disaster floor sells; the trail
    // and time rules are off so multi-day swings can survive option-price wobbles.
    // A one-time nudge fires at 10x suggesting cost recovery; selling stays manual.
    const trendMode = position.exitMode === "trend";
    if (trendMode && quote.bid >= position.entryPrice * 10) {
      await createWorkerAlert({ userId:position.userId, signalId:position.signalId, eventKey:`trend-10x-${position.ticker}-${position.openedAt}`, severity:"success",
        title:`RIDE MODE: ${position.alpacaSymbol} hit 10x — consider recovering your cost`,
        body:`${position.alpacaSymbol} is bidding $${quote.bid.toFixed(2)} vs your $${position.entryPrice.toFixed(2)} entry (${(quote.bid/position.entryPrice).toFixed(1)}x). Selling ${Math.max(1,Math.ceil(position.quantity/10))} of ${position.quantity} contracts here pays back the original debit — the rest rides free. The worker will NOT sell automatically in ride mode unless the bid falls below 50% of entry.`,
        metadata:{ contractTicker:position.ticker, bid:quote.bid, entryPrice:position.entryPrice } }).catch(()=>undefined);
    }
    const reason = trendMode
      ? (quote.bid <= position.entryPrice * 0.5 ? "premium_stop" as const : null)
      : evaluateExit({position,bid:quote.bid,underlyingPrice,longDated:dte != null && dte > 2});
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

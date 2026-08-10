export interface AlpacaPosition { symbol:string; asset_class:string; qty:string; avg_entry_price:string; market_value:string; unrealized_pl:string; unrealized_plpc:string }
export interface AlpacaOrder { id:string; client_order_id:string; symbol:string; status:string; side:string; qty:string; type:string; limit_price:string|null; filled_qty:string; filled_avg_price:string|null; filled_at:string|null; created_at:string; updated_at?:string }
export interface OptionQuote { symbol:string; bid:number; ask:number; timestamp:number }
export interface SignalMarket { openingRangeHigh:number; openingRangeLow:number; referencePrice:number; chartSymbol:string }
export interface ManagedPosition {
  ticker:string; alpacaSymbol:string; side:"call"|"put"; quantity:number; entryPrice:number; peakBid:number; openedAt:number;
  signalId:string; userId:string; market:SignalMarket; closeOrderId:string|null; closeOrderSubmittedAt:number|null;
  // burst = full exit engine (stop/trail/time). trend = MAX CONVEXITY ride: only the
  // 50% disaster floor sells; trail and time rules are off (multi-day convexity swings).
  exitMode:"burst"|"trend"|"scalp";
}

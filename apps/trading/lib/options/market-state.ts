import { calculateTechnicals } from "./indicators";
import type { Bar, MarketState, Underlying } from "./types";

export function marketStateAt(underlying:Underlying,bars:Bar[]):MarketState{
  const opening=bars.slice(0,15);const current=bars.at(-1)!;
  const openingRangeHigh=Math.max(...opening.map(bar=>bar.high));const openingRangeLow=Math.min(...opening.map(bar=>bar.low));
  const totalVolume=bars.reduce((sum,bar)=>sum+bar.volume,0);
  const referencePrice=totalVolume?bars.reduce((sum,bar)=>sum+(bar.vwap??bar.close)*bar.volume,0)/totalVolume:current.close;
  const technicals=calculateTechnicals(bars,underlying,openingRangeHigh,openingRangeLow);
  const regime=bars.length<15?"opening":current.close>referencePrice&&technicals.ema8>technicals.ema21?"uptrend":current.close<referencePrice&&technicals.ema8<technicals.ema21?"downtrend":"range";
  return {symbol:underlying,chartSymbol:"SPY",asOf:current.timestamp,price:current.close,displayPrice:current.close,referencePrice,referenceLabel:"VWAP",openingRangeHigh,openingRangeLow,regime,technicals,bars};
}

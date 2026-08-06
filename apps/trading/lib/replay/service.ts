import "server-only";
import { gzipSync } from "node:zlib";
import { createAdminClient } from "@/lib/supabase/admin";
import { getHistoricalSpyBars } from "@/lib/options/provider";
import type { Bar, Side, Underlying } from "@/lib/options/types";
import { findReplayTriggers, summarizeTrades } from "./engine";
import type { ReplayResult, ReplayTrade } from "./types";

const BASE="https://api.massive.com"; const STRATEGY_VERSION="orb-v2.2-prod-exits";
// Mirrors EXIT_RULES in apps/position-worker/src/exit-engine.ts — the deployed exit engine.
// Keep these in lockstep so replay results describe the strategy that actually runs.
const PROD_EXIT_RULES={stopLossPct:.30,trailActivationPct:.40,trailPct:.20,stretchActivationPct:1,stretchTrailPct:.15,noFollowThroughMs:10*60_000,followThroughPct:.10,mandatoryExitMinutes:15*60+10,sessionOpenMinutes:9*60+30} as const;
type ReferenceContract={ticker:string;contract_type:Side;strike_price:number;expiration_date:string};
type Quote={ask_price:number;bid_price:number;sip_timestamp:number};

async function massive<T>(pathOrUrl:string):Promise<T>{
  const key=process.env.MASSIVE_API_KEY; if(!key) throw new Error("MASSIVE_API_KEY is not configured");
  const url=new URL(pathOrUrl.startsWith("http")?pathOrUrl:`${BASE}${pathOrUrl}`); url.searchParams.set("apiKey",key);
  const response=await fetch(url,{cache:"no-store",signal:AbortSignal.timeout(20_000)}); if(!response.ok) throw new Error(`Massive API ${response.status} for ${url.pathname}`);
  return response.json() as Promise<T>;
}
function addDays(value:string,count:number){const date=new Date(`${value}T12:00:00Z`);date.setUTCDate(date.getUTCDate()+count);return date.toISOString().slice(0,10);}
function iso(timestamp:number){return new Date(timestamp).toISOString();}

async function getHistoricalSpot(underlying:Underlying,date:string,spyBars:Bar[]):Promise<number>{
  if(underlying==="SPY") return spyBars[14]?.close ?? spyBars[0]!.close;
  const payload=await massive<{results?:Array<{c:number;t:number}>}>(`/v2/aggs/ticker/I:SPX/range/1/minute/${date}/${date}?sort=asc&limit=50000`);
  const regular=(payload.results??[]).filter(item=>{const time=new Date(item.t).toLocaleTimeString("en-US",{timeZone:"America/New_York",hour12:false,hour:"2-digit",minute:"2-digit"});return time>="09:30"&&time<="16:00";});
  if(!regular.length) throw new Error("No historical I:SPX bars returned; your Massive account may need index-data access");
  return regular[14]?.c ?? regular[0]!.c;
}

async function getCandidateContracts(underlying:Underlying,expirationDate:string,side:Side,spot:number):Promise<ReferenceContract[]>{
  const root=underlying; let next:string|undefined=`${BASE}/v3/reference/options/contracts?underlying_ticker=${root}&expiration_date=${expirationDate}&expired=true&as_of=${expirationDate}&contract_type=${side}&limit=1000&sort=strike_price&order=asc`;
  const rows:ReferenceContract[]=[]; let pages=0;
  while(next&&pages++<3){const payload:{results?:ReferenceContract[];next_url?:string}=await massive(next);rows.push(...(payload.results??[]));next=payload.next_url;}
  return rows.filter(row=>row.ticker&&Number.isFinite(row.strike_price)).sort((a,b)=>Math.abs(a.strike_price-spot)-Math.abs(b.strike_price-spot)).slice(0,10);
}

async function inspectCandidate(contract:ReferenceContract,date:string,signalTime:number){
  const end=signalTime+11*60_000; const quotePath=`/v3/quotes/${encodeURIComponent(contract.ticker)}?timestamp.gte=${encodeURIComponent(iso(signalTime))}&timestamp.lte=${encodeURIComponent(iso(end))}&sort=timestamp&order=asc&limit=50000`;
  const barsPath=`/v2/aggs/ticker/${encodeURIComponent(contract.ticker)}/range/1/minute/${date}/${date}?sort=asc&limit=50000`;
  const [quotesPayload,barsPayload]=await Promise.all([massive<{results?:Quote[]}>(quotePath),massive<{results?:Array<{t:number;v:number}>}>(barsPath)]);
  const quotes=(quotesPayload.results??[]).map(q=>({...q,timestamp:Math.floor(q.sip_timestamp/1_000_000)})).filter(q=>q.timestamp<=end&&q.ask_price>0&&q.bid_price>=0&&q.ask_price>=q.bid_price);
  const entry=quotes.find(q=>q.timestamp>=signalTime&&q.timestamp<=signalTime+60_000); const cumulativeVolume=(barsPayload.results??[]).filter(bar=>bar.t<=signalTime).reduce((sum,bar)=>sum+(bar.v??0),0);
  if(!entry) return {contract,quotes,cumulativeVolume,eligible:false,reason:"No executable quote within 60 seconds"};
  const midpoint=(entry.bid_price+entry.ask_price)/2; const spreadPct=midpoint?(entry.ask_price-entry.bid_price)/midpoint*100:999;
  const eligible=entry.ask_price>=.1&&entry.ask_price<=8&&entry.bid_price>0&&spreadPct<=10&&cumulativeVolume>=100;
  const reason=entry.ask_price>8?"Ask exceeded $8":spreadPct>10?"Spread exceeded 10%":cumulativeVolume<100?"Cumulative volume below 100":"Eligible";
  return {contract,quotes,cumulativeVolume,entry,spreadPct,eligible,reason};
}

async function fetchSessionQuotes(ticker:string,fromTs:number,toTs:number):Promise<Array<Quote&{timestamp:number}>>{
  const path=`/v3/quotes/${encodeURIComponent(ticker)}?timestamp.gte=${encodeURIComponent(iso(fromTs))}&timestamp.lte=${encodeURIComponent(iso(toTs))}&sort=timestamp&order=asc&limit=50000`;
  const payload=await massive<{results?:Quote[]}>(path);
  return (payload.results??[]).map(q=>({...q,timestamp:Math.floor(q.sip_timestamp/1_000_000)})).filter(q=>q.ask_price>0&&q.bid_price>=0&&q.ask_price>=q.bid_price);
}

// Simulates the PRODUCTION exit engine (see PROD_EXIT_RULES) against historical quotes:
// premium stop, two-stage trailing stop, no-follow-through, underlying invalidation
// (underlying price approximated by the latest 1-minute bar close), mandatory 15:10 flat.
function simulate(candidate:Awaited<ReturnType<typeof inspectCandidate>>,trigger:ReturnType<typeof findReplayTriggers>[number],quotes:Array<Quote&{timestamp:number}>,bars:Bar[],sessionStartTs:number):ReplayTrade{
  const entry=candidate.entry!; const entryAsk=entry.ask_price;
  const mandatoryTs=sessionStartTs+(PROD_EXIT_RULES.mandatoryExitMinutes-PROD_EXIT_RULES.sessionOpenMinutes)*60_000;
  const barCloseAt=(ts:number)=>{let close:number|null=null;for(const bar of bars){if(bar.timestamp<=ts)close=bar.close;else break;}return close;};
  const after=quotes.filter(quote=>quote.timestamp>entry.timestamp);
  let peakBid=entryAsk; let exit:(Quote&{timestamp:number})|null=null; let exitReason:ReplayTrade["exitReason"]="end_of_data";
  for(const quote of after){
    peakBid=Math.max(peakBid,quote.bid_price);
    if(quote.timestamp>=mandatoryTs){exit=quote;exitReason="mandatory_time_exit";break;}
    if(quote.bid_price<=entryAsk*(1-PROD_EXIT_RULES.stopLossPct)){exit=quote;exitReason="premium_stop";break;}
    const underlyingClose=barCloseAt(quote.timestamp);
    if(underlyingClose!=null&&(trigger.side==="call"?underlyingClose<=trigger.openingRangeHigh:underlyingClose>=trigger.openingRangeLow)){exit=quote;exitReason="underlying_invalidation";break;}
    const gain=peakBid/entryAsk-1;
    const trail=gain>=PROD_EXIT_RULES.stretchActivationPct?PROD_EXIT_RULES.stretchTrailPct:gain>=PROD_EXIT_RULES.trailActivationPct?PROD_EXIT_RULES.trailPct:null;
    if(trail!=null&&quote.bid_price<=peakBid*(1-trail)){exit=quote;exitReason="trailing_stop";break;}
    if(quote.timestamp-entry.timestamp>=PROD_EXIT_RULES.noFollowThroughMs&&peakBid<entryAsk*(1+PROD_EXIT_RULES.followThroughPct)){exit=quote;exitReason="no_follow_through";break;}
  }
  if(!exit){exit=after.at(-1)??entry;exitReason="end_of_data";}
  const realized=after.filter(quote=>quote.timestamp<=exit.timestamp); const bids=realized.length?realized.map(quote=>quote.bid_price):[entry.bid_price];
  const mfePct=(Math.max(entryAsk,...bids)-entryAsk)/entryAsk*100; const maePct=(Math.min(entryAsk,...bids)-entryAsk)/entryAsk*100;
  const pnlDollars=(exit.bid_price-entryAsk)*100;
  return {signalTime:trigger.timestamp,action:trigger.side==="call"?"enter_call":"enter_put",contractTicker:candidate.contract.ticker,side:trigger.side,strike:candidate.contract.strike_price,entryAsk,exitBid:exit.bid_price,exitTime:exit.timestamp,exitReason,pnlDollars,returnPct:pnlDollars/entryAsk,mfePct,maePct,cumulativeVolume:candidate.cumulativeVolume,spreadPct:candidate.spreadPct!,passedRules:trigger.reasons};
}

export async function runHistoricalReplay(input:{ownerId:string;underlying:Underlying;sessionDate:string;dte:number}):Promise<ReplayResult>{
  const expirationDate=addDays(input.sessionDate,input.dte); const bars=await getHistoricalSpyBars(input.sessionDate); const spot=await getHistoricalSpot(input.underlying,input.sessionDate,bars);
  const triggers=findReplayTriggers(input.underlying,bars); const trades:ReplayTrade[]=[]; const noTradeReasons:string[]=[]; const rawEvents:unknown[]=[];
  for(const trigger of triggers){
    const scale=input.underlying==="SPX"?spot/trigger.spot:1; const referenceSpot=trigger.spot*scale;
    const contracts=await getCandidateContracts(input.underlying,expirationDate,trigger.side,referenceSpot);
    const inspected=await Promise.all(contracts.map(contract=>inspectCandidate(contract,input.sessionDate,trigger.timestamp)));
    rawEvents.push({trigger,referenceSpot,candidates:inspected});
    const selected=inspected.filter(candidate=>candidate.eligible).sort((a,b)=>b.cumulativeVolume-a.cumulativeVolume||a.spreadPct!-b.spreadPct!)[0];
    if(selected){
      const sessionStartTs=bars[0]!.timestamp;
      const mandatoryTs=sessionStartTs+(PROD_EXIT_RULES.mandatoryExitMinutes-PROD_EXIT_RULES.sessionOpenMinutes)*60_000;
      const quotes=await fetchSessionQuotes(selected.contract.ticker,selected.entry!.timestamp,mandatoryTs+60_000);
      trades.push(simulate(selected,trigger,quotes,bars,sessionStartTs));
    } else noTradeReasons.push(`${iso(trigger.timestamp)} ${trigger.side.toUpperCase()}: no nearby contract passed ask, spread, volume, and quote-freshness rules`);
  }
  if(!triggers.length) noTradeReasons.push("The deterministic strategy produced no qualified opening-range trigger during this session.");
  const summary={...summarizeTrades(trades),signals:triggers.length}; const status:ReplayResult["status"]=trades.length===triggers.length?"complete":"partial";
  const result:ReplayResult={underlying:input.underlying,sessionDate:input.sessionDate,dte:input.dte,expirationDate,strategyVersion:STRATEGY_VERSION,status,bars,trades,noTradeReasons,summary,limitations:["Historical fills use the first ask after a signal and subsequent bid quotes; commissions and exchange fees are excluded.","Candidate search is bounded to the 10 strikes nearest the underlying and at most three distinct intraday triggers.","Historical open interest and Greeks are not reconstructed; cumulative traded volume and spread are used for replay liquidity.","Exits simulate the production engine (30% premium stop, 40%/100% two-stage trail, 10-minute no-follow-through, opening-range invalidation, 15:10 ET mandatory flat); underlying invalidation is approximated with 1-minute bar closes instead of live trades."],createdAt:new Date().toISOString()};
  const admin=createAdminClient(); const rawPath=`${input.ownerId}/${input.sessionDate}/${crypto.randomUUID()}.json.gz`;
  const {error:uploadError}=await admin.storage.from("historical-replay").upload(rawPath,gzipSync(JSON.stringify({input,bars,events:rawEvents})),{contentType:"application/gzip",upsert:false});
  if(uploadError) throw new Error(`Replay raw-data storage failed: ${uploadError.message}`);
  const {data,error}=await admin.from("replay_runs").insert({user_id:input.ownerId,underlying:input.underlying,session_date:input.sessionDate,strategy_version:STRATEGY_VERSION,raw_storage_path:rawPath,status:"complete",configuration:{dte:input.dte,expirationDate},summary:result,completed_at:new Date().toISOString()}).select("id").single();
  if(error) throw new Error(`Replay summary persistence failed: ${error.message}`);
  if(trades.length){const {error:tradeError}=await admin.from("replay_trades").insert(trades.map(trade=>({replay_run_id:data.id,contract_ticker:trade.contractTicker,entry_at:new Date(trade.signalTime).toISOString(),entry_ask:trade.entryAsk,exit_at:new Date(trade.exitTime).toISOString(),exit_bid:trade.exitBid,max_favorable_pct:trade.mfePct,max_adverse_pct:trade.maePct,result:trade})));if(tradeError)throw new Error(`Replay trade persistence failed: ${tradeError.message}`);}
  return {...result,id:data.id};
}

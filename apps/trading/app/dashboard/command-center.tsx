"use client";
import { useCallback, useEffect, useState } from "react";
import type { CommandCenter, Underlying } from "@/lib/options/types";

const money = (value:number|null|undefined, digits=2) => value == null ? "—" : value.toLocaleString("en-US", { minimumFractionDigits:digits, maximumFractionDigits:digits });
export function CommandCenterView() {
  const [underlying, setUnderlying] = useState<Underlying>("SPY"); const [data, setData] = useState<CommandCenter | null>(null); const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    setLoading(true);
    try { const response = await fetch(`/api/command-center?underlying=${underlying}`, { cache:"no-store" }); setData(await response.json()); } finally { setLoading(false); }
  }, [underlying]);
  useEffect(() => { void refresh(); const timer = window.setInterval(refresh, 15_000); return () => window.clearInterval(timer); }, [refresh]);
  const signal = data?.signal; const t = data?.market?.technicals;
  return <>
    <div className="alert"><strong>Paper research only.</strong> 0DTE can lose 100% rapidly. Entries are deterministic; AI cannot place or override trades.</div>
    {underlying === "SPX" ? <div className="alert">SPX uses its own index bars and session mean. Confirm the intended PM-settled SPXW series before acting.</div> : null}
    {data?.errors.map(error => <div className="alert error" key={error}>{error}</div>)}
    <div className="toolbar" style={{marginBottom:14}}><button className={`button ${underlying === "SPY" ? "active" : ""}`} onClick={() => setUnderlying("SPY")}>SPY</button><button className={`button ${underlying === "SPX" ? "active" : ""}`} onClick={() => setUnderlying("SPX")}>SPX</button><button className="button" onClick={() => void refresh()} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button><span className="muted">15-second view · 1-minute durable snapshot</span></div>
    <section className="grid metrics">
      <Metric label={`${underlying} price`} value={`$${money(data?.market?.price)}`} />
      <Metric label={data?.market?.referenceLabel === "SESSION_MEAN" ? "Session mean" : "VWAP"} value={`$${money(data?.market?.referencePrice)}`} />
      <Metric label="Opening range" value={`${money(data?.market?.openingRangeLow)}–${money(data?.market?.openingRangeHigh)}`} />
      <Metric label="Regime" value={data?.market?.regime ?? "waiting"} />
    </section>
    <section className="panel" style={{marginTop:14}}><h2>Chart confluence</h2><div className="grid confluence">
      <Small label="EMA 8 / 21" value={`${money(t?.ema8)} / ${money(t?.ema21)}`} /><Small label="RSI 14" value={money(t?.rsi14,1)} /><Small label="MACD" value={`${money(t?.macd,3)} / ${money(t?.macdSignal,3)}`} /><Small label="ATR 14" value={money(t?.atr14)} /><Small label="Breakout" value={`${money(t?.breakoutAtr)} ATR`} /><Small label="Bollinger" value={`${money(t?.bollingerPosition)}σ`} /><Small label="Candle" value={t?.candlePattern.replace("_"," ") ?? "—"} /><Small label="Volume" value={t?.volumeConfirmation == null ? "N/A" : t.volumeConfirmation ? "Confirmed" : "Unconfirmed"} />
    </div></section>
    <section className="grid split" style={{marginTop:14}}><div className="panel"><h2>Current signal</h2><span className={`badge ${signal?.action === "enter_call" ? "call" : signal?.action === "enter_put" ? "put" : ""}`}>{signal?.action.replace("_"," ") ?? "waiting"}</span><span className="mono" style={{float:"right"}}>{signal?.confidence ?? 0}/100</span>{signal?.reasons.map(reason => <div className="reason" key={reason}><span>•</span><span>{reason}</span></div>)}{signal?.invalidation ? <div className="alert error"><strong>Invalidation:</strong> {signal.invalidation}</div> : null}</div><div className="panel"><h2>Selected contract · $8 ask cap</h2>{signal?.contract ? <div className="grid metrics"><Small label="Ticker" value={signal.contract.ticker} /><Small label="Bid / ask" value={`${money(signal.contract.bid)} / ${money(signal.contract.ask)}`} /><Small label="Maximum debit" value={`$${money(signal.contract.ask * 100,0)}`} /><Small label="Volume / score" value={`${signal.contract.volume.toLocaleString()} / ${signal.contract.liquidityScore}`} /></div> : <p className="muted">No eligible contract.</p>}</div></section>
    <section className="panel" style={{marginTop:14}}><h2>Highest-ranked 0–2 DTE contracts</h2><div className="table-wrap"><table className="table"><thead><tr>{["Score","Ticker","DTE","Side","Strike","Bid / Ask","Debit","Spread","Volume","Vol/OI","Delta","IV"].map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>{data?.contracts.map(contract => <tr key={contract.ticker} className={contract.eligible ? "" : "rejected"} title={contract.rejectionReasons.join(", ")}><td>{contract.liquidityScore}</td><td className="mono">{contract.ticker}</td><td>{contract.dte}</td><td className={contract.side === "call" ? "call" : "put"}>{contract.side}</td><td>{money(contract.strike)}</td><td>{money(contract.bid)} / {money(contract.ask)}</td><td>${money(contract.ask*100,0)}</td><td>{money(contract.spreadPct,1)}%</td><td>{contract.volume.toLocaleString()}</td><td>{money(contract.volumeToOpenInterest)}</td><td>{money(contract.delta)}</td><td>{contract.impliedVolatility == null ? "—" : `${money(contract.impliedVolatility*100,1)}%`}</td></tr>)}</tbody></table></div></section>
  </>;
}
function Metric({ label, value }:{label:string;value:string}) { return <div className="panel"><div className="metric-label">{label}</div><div className="metric-value">{value}</div></div>; }
function Small({ label, value }:{label:string;value:string}) { return <div><div className="metric-label">{label}</div><div className="mono" style={{marginTop:5,overflowWrap:"anywhere"}}>{value}</div></div>; }

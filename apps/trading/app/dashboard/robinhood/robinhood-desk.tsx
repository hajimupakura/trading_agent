"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, RefreshCw, Send } from "lucide-react";

interface AccountState {
  connected: boolean;
  accounts?: Array<Record<string, unknown>>;
  accountNumber?: string | null;
  overview?: { portfolio?: any; positions?: any[]; orders?: any[] } | null;
  error?: string;
}

const money = (value: unknown, digits = 2) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toLocaleString("en-US", { minimumFractionDigits:digits, maximumFractionDigits:digits }) : "—";
};

export function RobinhoodDesk() {
  const [state, setState] = useState<AccountState | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ tone:"success"|"error"; text:string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [ticket, setTicket] = useState({
    chainSymbol:"SPY", underlyingType:"equity" as "equity"|"index", expirationDate:"", strike:"",
    optionType:"call" as "call"|"put", side:"buy" as "buy"|"sell", positionEffect:"open" as "open"|"close",
    quantity:"1", limitPrice:"",
  });

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/brokers/robinhood/account", { cache:"no-store" });
      setState(await response.json());
    } catch (error) {
      setState({ connected:false, error:error instanceof Error ? error.message : "Request failed" });
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void refresh(); const timer = window.setInterval(refresh, 20_000); return () => window.clearInterval(timer); }, [refresh]);

  const submit = useCallback(async () => {
    if (!state?.accountNumber) return;
    setSubmitting(true); setMessage(null);
    try {
      const response = await fetch("/api/brokers/robinhood/trade", {
        method:"POST", headers:{ "Content-Type":"application/json" },
        body:JSON.stringify({
          accountNumber:state.accountNumber, chainSymbol:ticket.chainSymbol.toUpperCase(), underlyingType:ticket.underlyingType,
          expirationDate:ticket.expirationDate, strike:Number(ticket.strike), optionType:ticket.optionType,
          side:ticket.side, positionEffect:ticket.positionEffect, quantity:Number(ticket.quantity), limitPrice:Number(ticket.limitPrice),
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Order failed");
      setMessage({ tone:"success", text:`Order submitted for ${ticket.quantity} ${ticket.chainSymbol.toUpperCase()} ${ticket.strike}${ticket.optionType === "call" ? "C" : "P"}` });
      await refresh();
    } catch (error) {
      setMessage({ tone:"error", text:error instanceof Error ? error.message : "Order failed" });
    } finally { setSubmitting(false); }
  }, [state, ticket, refresh]);

  const portfolio = state?.overview?.portfolio ?? {};
  const positions = state?.overview?.positions ?? [];
  const debit = Number(ticket.quantity) * Number(ticket.limitPrice) * 100;

  return (
    <div className="terminal-layout">
      <main className="dashboard" style={{ padding:"24px 32px" }}>
        <header className="section-heading" style={{ marginBottom:18 }}>
          <div>
            <span>ROBINHOOD · AGENTIC ACCOUNT</span>
            <strong>MANUAL OPTION DESK</strong>
          </div>
          <div style={{ display:"flex", gap:12, alignItems:"center" }}>
            <Link className="nav-item" href="/dashboard"><ArrowLeft size={15}/> Command center</Link>
            <button className="refresh-button" onClick={() => void refresh()} disabled={loading}><RefreshCw size={15} className={loading ? "spin" : ""}/> {loading ? "Loading" : "Refresh"}</button>
          </div>
        </header>

        <section className="approval-warning" style={{ marginBottom:18 }}>
          <AlertTriangle size={14}/> Automatic exit management does not cover Robinhood positions yet. Anything opened here must be closed here (or in the Robinhood app) — the stop-loss and trailing rules only run for Alpaca paper positions.
        </section>

        {state?.error ? <p className="empty-dte">{state.error}</p> : null}
        {state && !state.connected ? <p className="empty-dte">Robinhood is not connected. Run the morning script to authorize.</p> : null}

        <section className="metric-row" style={{ marginBottom:20 }}>
          <div className="metric-card"><span>ACCOUNT</span><strong>{state?.accountNumber ?? "—"}</strong></div>
          <div className="metric-card"><span>TOTAL EQUITY</span><strong>${money(portfolio.equity ?? portfolio.total_equity ?? portfolio.market_value)}</strong></div>
          <div className="metric-card"><span>BUYING POWER</span><strong>${money(portfolio.buying_power ?? portfolio.options_buying_power ?? portfolio.withdrawable_amount)}</strong></div>
          <div className="metric-card"><span>OPEN OPTION POSITIONS</span><strong>{positions.length}</strong></div>
        </section>

        <section className="panel" style={{ marginBottom:20 }}>
          <div className="section-heading"><div><span>OPEN POSITIONS</span><strong>AGENTIC ACCOUNT</strong></div></div>
          {positions.length ? (
            <table className="contract-table"><thead><tr><th>Contract</th><th>Type</th><th>Qty</th><th>Avg price</th></tr></thead>
              <tbody>{positions.map((position:any, index:number) => (
                <tr key={position.id ?? index}>
                  <td>{position.chain_symbol ?? position.symbol ?? "—"} {position.strike_price ? `${Number(position.strike_price).toFixed(0)}` : ""} {position.expiration_date ?? ""}</td>
                  <td>{position.option_type ?? position.type ?? "—"}</td>
                  <td>{money(position.quantity, 0)}</td>
                  <td>${money(position.average_price ?? position.average_open_price)}</td>
                </tr>))}
              </tbody></table>
          ) : <p className="empty-dte">No open option positions in the agentic account.</p>}
        </section>

        <section className="panel">
          <div className="section-heading"><div><span>NEW ORDER</span><strong>SINGLE-LEG OPTION</strong></div></div>
          <div className="settings-grid" style={{ gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))", gap:14, padding:"6px 0 14px" }}>
            <label className="settings-field"><span>Underlying</span><input value={ticket.chainSymbol} onChange={event => setTicket(current => ({ ...current, chainSymbol:event.target.value.toUpperCase() }))} placeholder="SPY"/><small>SPY, SPXW, NVDA…</small></label>
            <label className="settings-field"><span>Underlying type</span><select value={ticket.underlyingType} onChange={event => setTicket(current => ({ ...current, underlyingType:event.target.value as "equity"|"index" }))}><option value="equity">equity</option><option value="index">index</option></select><small>SPXW = index</small></label>
            <label className="settings-field"><span>Expiration</span><input type="date" value={ticket.expirationDate} onChange={event => setTicket(current => ({ ...current, expirationDate:event.target.value }))}/><small>Contract expiry date</small></label>
            <label className="settings-field"><span>Strike</span><input type="number" step="1" value={ticket.strike} onChange={event => setTicket(current => ({ ...current, strike:event.target.value }))}/><small>e.g. 770</small></label>
            <label className="settings-field"><span>Call / Put</span><select value={ticket.optionType} onChange={event => setTicket(current => ({ ...current, optionType:event.target.value as "call"|"put" }))}><option value="call">call</option><option value="put">put</option></select><small>Direction of the bet</small></label>
            <label className="settings-field"><span>Action</span><select value={`${ticket.side}:${ticket.positionEffect}`} onChange={event => { const [side, positionEffect] = event.target.value.split(":"); setTicket(current => ({ ...current, side:side as "buy"|"sell", positionEffect:positionEffect as "open"|"close" })); }}><option value="buy:open">Buy to open</option><option value="sell:close">Sell to close</option></select><small>Open a new position or close one</small></label>
            <label className="settings-field"><span>Contracts</span><input type="number" min="1" max="10" value={ticket.quantity} onChange={event => setTicket(current => ({ ...current, quantity:event.target.value }))}/><small>1 contract = 100 shares</small></label>
            <label className="settings-field"><span>Limit price</span><input type="number" step="0.01" value={ticket.limitPrice} onChange={event => setTicket(current => ({ ...current, limitPrice:event.target.value }))}/><small>Per contract</small></label>
          </div>
          <p className="approval-warning">Total {ticket.positionEffect === "open" ? "debit" : "proceeds"}: <strong>${Number.isFinite(debit) ? debit.toFixed(0) : "—"}</strong> · Robinhood reviews the order, then it is placed as a day limit order in the agentic account.</p>
          {message ? <p className={message.tone === "error" ? "empty-dte" : "approval-warning"}>{message.text}</p> : null}
          <button className="approve-button" disabled={submitting || !state?.accountNumber || !ticket.expirationDate || !ticket.strike || !ticket.limitPrice} onClick={() => void submit()}>
            <Send size={14}/> {submitting ? "Submitting…" : "Review and place order"}
          </button>
        </section>
      </main>
    </div>
  );
}

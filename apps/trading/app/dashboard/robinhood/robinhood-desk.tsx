"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Activity, BarChart3, BrainCircuit, CircleDollarSign, FlaskConical, LineChart, LogOut, RefreshCw, Send, Settings, ShieldCheck, Zap } from "lucide-react";
import { logout } from "@/app/login/actions";

interface Overview { portfolio?: { totalValue:number; cash:number; buyingPower:number; optionsValue:number }; positions?: any[]; orders?: any[] }
interface AccountState { connected:boolean; accountNumber?:string|null; nickname?:string|null; optionLevel?:string; optionsEnabled?:boolean; upgradeUrl?:string|null; overview?:Overview|null; error?:string }

const money = (value: unknown, digits = 2) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toLocaleString("en-US", { minimumFractionDigits:digits, maximumFractionDigits:digits }) : "—";
};
const mask = (value: string | null | undefined) => value ? `••••${value.slice(-4)}` : "—";

export function RobinhoodDesk({ userEmail }: { userEmail:string | null }) {
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

  useEffect(() => { void refresh(); const timer = window.setInterval(refresh, 30_000); return () => window.clearInterval(timer); }, [refresh]);

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
      setMessage({ tone:"success", text:`Order submitted: ${ticket.side.toUpperCase()} ${ticket.quantity} ${ticket.chainSymbol.toUpperCase()} ${ticket.strike}${ticket.optionType === "call" ? "C" : "P"} @ $${Number(ticket.limitPrice).toFixed(2)}` });
      await refresh();
    } catch (error) {
      setMessage({ tone:"error", text:error instanceof Error ? error.message : "Order failed" });
    } finally { setSubmitting(false); }
  }, [state, ticket, refresh]);

  const portfolio = state?.overview?.portfolio;
  const positions = state?.overview?.positions ?? [];
  const debit = Number(ticket.quantity) * Number(ticket.limitPrice) * 100;
  const needsUpgrade = state?.connected && state.accountNumber && state.optionsEnabled === false;

  return (
    <div className="terminal-layout">
      <aside className="sidebar">
        <div className="brand-mark"><Zap size={17} fill="currentColor"/> VELOCITY</div>
        <div className="desk-label">OPTIONS DESK</div>
        <nav className="desk-nav" aria-label="Trading workspace">
          <Link className="nav-item" href="/dashboard"><BarChart3 size={16}/> Command center</Link>
          <span className="nav-item"><Activity size={16}/> Setups <em>Live</em></span>
          <Link className="nav-item active" href="/dashboard/robinhood"><CircleDollarSign size={16}/> Robinhood desk <em>Live</em></Link>
          <Link className="nav-item" href="/dashboard/replay"><FlaskConical size={16}/> Replay lab</Link>
          <Link className="nav-item" href="/dashboard/analytics"><LineChart size={16}/> Analytics</Link>
          <Link className="nav-item" href="/dashboard/settings"><Settings size={16}/> Risk settings</Link>
          <span className="nav-item"><BrainCircuit size={16}/> AI review <em>Soon</em></span>
        </nav>
        <div className="sidebar-note"><ShieldCheck size={17}/><div><strong>Real money</strong><span>Agentic account only · exits managed by the worker</span></div></div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div><p className="eyebrow">ROBINHOOD · AGENTIC ACCOUNT {mask(state?.accountNumber)}</p><h1>Robinhood Trading Desk</h1></div>
          <div className="topbar-actions">
            <button className="refresh-button" onClick={() => void refresh()} disabled={loading}><RefreshCw size={15} className={loading ? "spin" : ""}/> {loading ? "Loading" : "Refresh"}</button>
            <form action={logout}><button className="logout-button" title={`Sign out${userEmail ? ` ${userEmail}` : ""}`}><LogOut size={14}/> Sign out</button></form>
          </div>
        </header>
        <main className="dashboard">
          {state?.error ? <section className="system-alert">{state.error}</section> : null}
          {state && !state.connected ? <section className="system-alert">Robinhood is not connected. Run the morning script, then refresh.</section> : null}
          {needsUpgrade ? (
            <section className="system-alert">
              <strong>Options trading is not enabled on the agentic account yet.</strong>{" "}
              {state?.upgradeUrl
                ? <>Complete Robinhood&apos;s options application, then refresh: <a href={state.upgradeUrl} target="_blank" rel="noreferrer">Enable options for {mask(state.accountNumber)}</a></>
                : "Open the Robinhood app → agentic account → settings → enable options trading, then refresh."}
            </section>
          ) : null}

          <section className="paper-strip">
            <div><span>ACCOUNT VALUE</span><strong>${money(portfolio?.totalValue)}</strong></div>
            <div><span>CASH</span><strong>${money(portfolio?.cash)}</strong></div>
            <div><span>BUYING POWER</span><strong>${money(portfolio?.buyingPower)}</strong></div>
            <div><span>OPTIONS VALUE</span><strong>${money(portfolio?.optionsValue)}</strong></div>
            <div className="connection-state robinhood-state connected"><i/><span>{state?.nickname ? state.nickname.toUpperCase() : "AGENTIC"} · {mask(state?.accountNumber)}</span></div>
          </section>

          <section className="manager-strip active">
            <div><span>AUTOMATIC EXITS</span><strong>STOP · TRAIL · 15:10 FLAT</strong><small>The Railway worker manages Robinhood option positions with the same rules as paper: −30% stop, two-stage trailing stop, swing-aware time exits.</small></div>
          </section>

          <div className="decision-grid">
            <section className="signal-card">
              <div className="section-heading"><div><span>OPEN POSITIONS</span><strong>AGENTIC ACCOUNT</strong></div></div>
              {positions.length ? (
                <ul className="reason-list">
                  {positions.map((position:any, index:number) => (
                    <li key={position.option_id ?? index}>
                      {String(position.chain_symbol ?? "?")} · {money(position.quantity, 0)} contract{Number(position.quantity) === 1 ? "" : "s"} · avg ${money(position.average_price)} {position.expiration_date ? `· exp ${position.expiration_date}` : ""}
                    </li>
                  ))}
                </ul>
              ) : <p className="decision-help">No open option positions. Fills appear here and are picked up by the exit engine automatically.</p>}
            </section>

            <section className="signal-card">
              <div className="section-heading"><div><span>NEW ORDER</span><strong>SINGLE-LEG OPTION</strong></div></div>
              <div className="settings-grid" style={{ display:"grid", gridTemplateColumns:"repeat(2, minmax(0,1fr))", gap:12 }}>
                <label className="settings-field"><span>Underlying</span><input value={ticket.chainSymbol} onChange={event => setTicket(current => ({ ...current, chainSymbol:event.target.value.toUpperCase() }))} placeholder="SPY"/><small>SPY, SPXW, NVDA…</small></label>
                <label className="settings-field"><span>Type</span><select value={ticket.underlyingType} onChange={event => setTicket(current => ({ ...current, underlyingType:event.target.value as "equity"|"index" }))}><option value="equity">Equity</option><option value="index">Index (SPXW)</option></select><small>SPXW is an index</small></label>
                <label className="settings-field"><span>Expiration</span><input type="date" value={ticket.expirationDate} onChange={event => setTicket(current => ({ ...current, expirationDate:event.target.value }))}/><small>Contract expiry</small></label>
                <label className="settings-field"><span>Strike</span><input type="number" step="1" value={ticket.strike} onChange={event => setTicket(current => ({ ...current, strike:event.target.value }))} placeholder="770"/><small>Strike price</small></label>
                <label className="settings-field"><span>Direction</span><select value={ticket.optionType} onChange={event => setTicket(current => ({ ...current, optionType:event.target.value as "call"|"put" }))}><option value="call">Call (up)</option><option value="put">Put (down)</option></select><small>Your market view</small></label>
                <label className="settings-field"><span>Action</span><select value={`${ticket.side}:${ticket.positionEffect}`} onChange={event => { const [side, positionEffect] = event.target.value.split(":"); setTicket(current => ({ ...current, side:side as "buy"|"sell", positionEffect:positionEffect as "open"|"close" })); }}><option value="buy:open">Buy to open</option><option value="sell:close">Sell to close</option></select><small>Open or close</small></label>
                <label className="settings-field"><span>Contracts</span><input type="number" min="1" max="10" value={ticket.quantity} onChange={event => setTicket(current => ({ ...current, quantity:event.target.value }))}/><small>1 = 100 shares</small></label>
                <label className="settings-field"><span>Limit price</span><input type="number" step="0.01" value={ticket.limitPrice} onChange={event => setTicket(current => ({ ...current, limitPrice:event.target.value }))} placeholder="1.25"/><small>Per contract</small></label>
              </div>
              <p className="decision-help">Total {ticket.positionEffect === "open" ? "debit" : "proceeds"}: <strong>${Number.isFinite(debit) && debit > 0 ? debit.toFixed(0) : "—"}</strong> · Robinhood reviews the order (fees included), then places a day limit order in the agentic account.</p>
              {message ? <p className={`order-message ${message.tone}`}>{message.text}</p> : null}
              <button className="approve-button" disabled={submitting || Boolean(needsUpgrade) || !state?.accountNumber || !ticket.expirationDate || !ticket.strike || !ticket.limitPrice} onClick={() => void submit()}>
                <Send size={14}/> {submitting ? "Submitting…" : needsUpgrade ? "Enable options first" : "Review and place order"}
              </button>
            </section>
          </div>
        </main>
      </div>
    </div>
  );
}

"use client";

import {
  Activity,
  BarChart3,
  BrainCircuit,
  CircleDollarSign,
  Clock3,
  Crosshair,
  LogOut,
  RefreshCw,
  Send,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
  Zap,
  LineChart,
  Settings,
  Bell,
  Check,
  AlertTriangle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Bar, CommandCenter, Contract, Underlying } from "@/lib/options/types";
import { logout } from "@/app/login/actions";
import Link from "next/link";

const money = (value: number | null | undefined, digits = 2) =>
  value == null || !Number.isFinite(value)
    ? "—"
    : value.toLocaleString("en-US", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

interface PaperState {
  configured:boolean; mode:"paper"; error?:string;
  rules?:{maxTradeDebit:number;maxDailyLoss:number};
  account?:{ equity:string; buying_power:string; options_buying_power:string; status:string };
  positions?:unknown[]; orders?:unknown[];
}
interface ManagerState { online:boolean; control?:{auto_exits_enabled:boolean;kill_switch:boolean}; status?:{managed_positions:number;last_heartbeat:string}|null; brokerPositions?:Array<{symbol:string;quantity:number;managed:boolean}>; unmanagedPositions?:Array<{symbol:string;quantity:number;managed:boolean}>; error?:string }
interface AlertItem{id:string;severity:"info"|"success"|"warning"|"critical";title:string;body:string;read_at:string|null;created_at:string}
interface AlertState{alerts:AlertItem[];unread:number}

export function CommandCenterView({ userEmail }: { userEmail:string | null }) {
  const [underlying, setUnderlying] = useState<Underlying>("SPY");
  const [data, setData] = useState<CommandCenter | null>(null);
  const [loading, setLoading] = useState(true);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [paper, setPaper] = useState<PaperState | null>(null);
  const [manager, setManager] = useState<ManagerState | null>(null);
  const [alerts,setAlerts]=useState<AlertState>({alerts:[],unread:0});
  const [alertsOpen,setAlertsOpen]=useState(false);
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [orderMessage, setOrderMessage] = useState<{ tone:"success"|"error"; text:string } | null>(null);
  const [selectedDte, setSelectedDte] = useState<0|1|2>(0);

  const refreshPaper = useCallback(async () => {
    const [paperResponse,managerResponse,alertResponse] = await Promise.all([fetch("/api/paper-trading",{cache:"no-store"}),fetch("/api/position-manager",{cache:"no-store"}),fetch("/api/alerts",{cache:"no-store"})]);
    setPaper(await paperResponse.json()); setManager(await managerResponse.json());if(alertResponse.ok)setAlerts(await alertResponse.json());
  }, []);
  const markAlertsRead=useCallback(async(id?:string)=>{await fetch("/api/alerts",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(id?{id}:{all:true})});await refreshPaper();},[refreshPaper]);
  const setKillSwitch = useCallback(async (killSwitch:boolean) => {
    const response=await fetch("/api/position-manager",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({killSwitch})});
    const payload=await response.json(); if(!response.ok){setOrderMessage({tone:"error",text:payload.error??"Control update failed"});return;} setManager(payload);
  },[]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setRequestError(null);
    try {
      const response = await fetch(`/api/command-center?underlying=${underlying}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`Market scan failed (${response.status})`);
      setData(await response.json());
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : "Market scan failed");
    } finally {
      setLoading(false);
    }
  }, [underlying]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(refresh, 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => { void refreshPaper();const timer=window.setInterval(refreshPaper,10_000);return()=>window.clearInterval(timer); }, [refreshPaper]);

  const signal = data?.signal;
  const approveOrder = useCallback(async () => {
    if (!signal?.contract) return;
    setSubmitting(true); setOrderMessage(null);
    try {
      const response = await fetch("/api/paper-trading", { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ underlying, signalId:signal.id, contractTicker:signal.contract.ticker }) });
      const payload = await response.json();
      if (!response.ok) throw new Error([payload.error, ...(payload.reasons ?? [])].filter(Boolean).join(" · "));
      setOrderMessage({ tone:"success", text:`Paper order ${payload.order.status}: ${payload.order.symbol} at $${payload.order.limit_price}` });
      setApprovalOpen(false);
      await Promise.all([refresh(), refreshPaper()]);
    } catch (error) {
      setOrderMessage({ tone:"error", text:error instanceof Error ? error.message : "Paper order failed" });
    } finally { setSubmitting(false); }
  }, [signal, underlying, refresh, refreshPaper]);

  const market = data?.market;
  const technicals = market?.technicals;
  const eligible = data?.contracts.filter((contract) => contract.eligible) ?? [];
  const selectedContracts = data?.contracts.filter(contract => contract.dte === selectedDte) ?? [];
  const actionTone = signal?.action === "enter_call" ? "call" : signal?.action === "enter_put" ? "put" : "wait";
  const actionLabel = signal?.action === "enter_call" ? "CALL SETUP" : signal?.action === "enter_put" ? "PUT SETUP" : "STAND ASIDE";
  const actionDescription = signal?.action === "enter_call"
    ? "Bullish confluence is complete: two SPY closes held above VWAP and the 15-minute range, EMA and VWAP slope rise, RSI/MACD and 1.2× relative volume confirm, the move is not overextended, and an eligible call exists. Review only—not a guaranteed winner or automatic entry."
    : signal?.action === "enter_put"
      ? "Bearish confluence is complete: two SPY closes held below VWAP and the 15-minute range, EMA and VWAP slope fall, RSI/MACD and 1.2× relative volume confirm, the move is not overextended, and an eligible put exists. Review only—not a guaranteed winner or automatic entry."
      : "No qualified entry currently exists. Price structure, momentum, or contract liquidity is incomplete, so the engine recommends waiting rather than opening a position.";
  const updated = data?.asOf ? new Date(data.asOf).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" }) : "Waiting for data";

  return (
    <div className="terminal-layout">
      <aside className="sidebar">
        <div className="brand-mark"><Zap size={17} fill="currentColor" /> VELOCITY</div>
        <div className="desk-label">OPTIONS DESK</div>
        <nav className="desk-nav" aria-label="Trading workspace">
          <Link className="nav-item active" href="/dashboard"><BarChart3 size={16} /> Command center</Link>
          <span className="nav-item"><Crosshair size={16} /> Setups <em>Live</em></span>
          <Link className="nav-item" href="/dashboard/replay"><Activity size={16} /> Replay lab <em>Ready</em></Link>
          <Link className="nav-item" href="/dashboard/analytics"><LineChart size={16} /> Analytics</Link>
          <Link className="nav-item" href="/dashboard/settings"><Settings size={16} /> Risk settings</Link>
          <span className="nav-item"><BrainCircuit size={16} /> AI review <small>Soon</small></span>
        </nav>
          <div className="sidebar-note">
            <ShieldCheck size={17} />
          <div><strong>Alpaca paper</strong><span>{paper?.configured ? "Approval required" : "Connection unavailable"}</span></div>
          </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">INTRADAY OPTIONS INTELLIGENCE</p>
            <h1>0–2 DTE Command Center</h1>
          </div>
          <div className="topbar-actions"><div className="market-status"><span className="live-dot" /> LIVE DATA <b>{updated}</b></div><div className="alert-menu"><button className={`alert-button ${alerts.unread?"has-alerts":""}`} onClick={()=>setAlertsOpen(open=>!open)} title="Trading alerts"><Bell size={15}/>{alerts.unread?<b>{alerts.unread}</b>:null}</button>{alertsOpen?<div className="alert-popover"><div className="alert-popover-head"><strong>TRADING ALERTS</strong>{alerts.unread?<button onClick={()=>void markAlertsRead()}><Check size={12}/> Mark all read</button>:null}</div>{alerts.alerts.length?<div className="alert-list">{alerts.alerts.slice(0,8).map(alert=><button key={alert.id} className={`${alert.severity} ${alert.read_at?"read":""}`} onClick={()=>!alert.read_at&&void markAlertsRead(alert.id)}><i>{alert.severity==="critical"?<AlertTriangle size={13}/>:<Bell size={12}/>}</i><span><strong>{alert.title}</strong><small>{alert.body}</small><em>{new Date(alert.created_at).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"})}</em></span></button>)}</div>:<p>No trading alerts yet.</p>}</div>:null}</div><form action={logout}><button className="logout-button" title={`Sign out${userEmail ? ` ${userEmail}` : ""}`}><LogOut size={14}/> Sign out</button></form></div>
        </header>

        <main className="dashboard">
          <section className="control-strip">
            <div className="symbol-switch" aria-label="Select underlying">
              {(["SPY", "SPX"] as Underlying[]).map((symbol) => (
                <button key={symbol} className={underlying === symbol ? "selected" : ""} onClick={() => setUnderlying(symbol)}>{symbol}</button>
              ))}
            </div>
            <div className="instrument-copy">
              <strong>{underlying === "SPX" ? "S&P 500 Index Options" : "SPDR S&P 500 ETF Options"}</strong>
              <span>{underlying === "SPX" ? "Cash-settled · confirm SPXW series" : "Physically settled · American style"}</span>
            </div>
            <button className="refresh-button" onClick={() => void refresh()} disabled={loading}>
              <RefreshCw size={15} className={loading ? "spin" : ""} /> {loading ? "Scanning" : "Refresh scan"}
            </button>
          </section>

          {(requestError || data?.errors.length) ? (
            <div className="system-alert"><span>DATA NOTICE</span>{requestError ?? data?.errors.join(" · ")}</div>
          ) : null}
          {orderMessage ? <div className={`order-message ${orderMessage.tone}`}>{orderMessage.text}</div> : null}

          <section className="paper-strip">
            <div><span>PAPER EQUITY</span><strong>${money(Number(paper?.account?.equity))}</strong></div>
            <div><span>DAILY LOSS LIMIT</span><strong>${money(paper?.rules?.maxDailyLoss,0)}</strong></div>
            <div><span>MAX CONTRACT DEBIT</span><strong>${money(paper?.rules?.maxTradeDebit,0)}</strong></div>
            <div><span>OPEN POSITIONS / ORDERS</span><strong>{paper?.positions?.length ?? 0} / {paper?.orders?.length ?? 0}</strong></div>
            <div className={`connection-state ${paper?.configured ? "connected" : ""}`}><i/><span>{paper?.configured ? "ALPACA PAPER CONNECTED" : paper?.error ?? "CONNECTING"}</span></div>
          </section>
          <section className={`manager-strip ${manager?.online && !manager.control?.kill_switch && !manager.unmanagedPositions?.length ? "active":""}`}><div><span>AUTO EXIT MANAGER</span><strong>{manager?.control?.kill_switch?"KILL SWITCH ACTIVE":manager?.unmanagedPositions?.length?`${manager.unmanagedPositions.length} UNPROTECTED POSITION${manager.unmanagedPositions.length===1?"":"S"}`:manager?.online?"ONLINE · PAPER":"OFFLINE"}</strong><small>{manager?.status?.managed_positions??0} managed · {manager?.brokerPositions?.length??0} at Alpaca{manager?.unmanagedPositions?.length?` · ${manager.unmanagedPositions.map(position=>`${position.quantity}× ${position.symbol}`).join(", ")} must be managed in Alpaca`:""}</small></div><button className={manager?.control?.kill_switch?"resume-manager":"kill-manager"} onClick={()=>void setKillSwitch(!manager?.control?.kill_switch)}>{manager?.control?.kill_switch?"Resume paper exits":"Emergency stop"}</button></section>

          <section className="market-grid">
            <MarketCard label={`${underlying} LAST`} value={`$${money(market?.displayPrice)}`} detail={`${market?.regime ?? "waiting"} regime`} icon={market?.regime === "downtrend" ? <TrendingDown /> : <TrendingUp />} tone={market?.regime === "downtrend" ? "negative" : "positive"} />
            <MarketCard label={market?.referenceLabel ?? (underlying === "SPX" ? "SESSION MEAN" : "VWAP")} value={`$${money(market?.referencePrice)}`} detail={market && market.price >= market.referencePrice ? "Price above reference" : "Price below reference"} icon={<Crosshair />} />
            <MarketCard label="OPENING RANGE" value={`${money(market?.openingRangeLow)} – ${money(market?.openingRangeHigh)}`} detail={market ? `${money(market.openingRangeHigh - market.openingRangeLow)} pts wide` : "Waiting"} icon={<BarChart3 />} />
            <MarketCard label="ELIGIBLE CONTRACTS" value={eligible.length.toString()} detail={`${data?.contracts.length ?? 0} contracts scanned`} icon={<CircleDollarSign />} />
          </section>

          <section className="decision-grid">
            <article className={`signal-card ${actionTone}`}>
              <div className="card-heading"><span>TRADE DECISION</span><span className="engine-tag">RULE ENGINE</span></div>
              <div className="signal-main">
                <div>
                  <p className="signal-kicker">CURRENT READ</p>
                  <div className="decision-help" tabIndex={0} aria-describedby="decision-tooltip"><h2>{actionLabel}</h2><span className="hover-tooltip" id="decision-tooltip" role="tooltip">{actionDescription}</span></div>
                  <p className="signal-subtitle">{signal?.setup === "opening_range" ? "Opening-range continuation" : "No qualified setup yet"}</p>
                </div>
                <Confidence score={signal?.confidence ?? 0} />
              </div>
              <div className="reason-list">
                {signal?.reasons.length ? signal.reasons.map((reason) => <div key={reason}><span>✓</span>{reason}</div>) : <div><span>·</span>Waiting for complete market context</div>}
              </div>
              <div className="invalidation"><strong>INVALIDATION</strong><span>{signal?.invalidation ?? "No trade is active"}</span></div>
            </article>

            <article className="contract-card">
              <div className="card-heading"><span>BEST EXECUTABLE CONTRACT</span><span className="price-cap">ASK ≤ $8.00</span></div>
              {signal?.contract ? <><ContractSpotlight contract={signal.contract} />
                <button className="approve-button" disabled={underlying === "SPX" || !signal.action.startsWith("enter_") || !paper?.configured || submitting} onClick={() => { setOrderMessage(null); setApprovalOpen(true); }}><Send size={14}/>{underlying === "SPX" ? "SPX analysis only" : signal.action.startsWith("enter_") ? "Review paper order" : "Waiting for entry signal"}</button>
              </> : (
                <div className="empty-contract"><Clock3 size={26} /><strong>No contract selected</strong><span>The scanner is waiting for directional confirmation and executable liquidity.</span></div>
              )}
            </article>
          </section>

          <section className="analysis-grid">
            <article className="chart-card">
              <div className="section-heading"><div><span>PRICE ACTION · {underlying === "SPX" ? "MASSIVE INDEX DATA" : "ALPACA IEX"}</span><strong>{underlying} · 1 MINUTE</strong></div><div className="chart-legend"><i /> Price <i className="reference" /> {market?.referenceLabel ?? "Reference"}</div></div>
              <PriceChart bars={market?.bars ?? []} reference={market?.referencePrice ?? null} />
            </article>
            <article className="technicals-card">
              <div className="section-heading"><div><span>CONFLUENCE MATRIX</span><strong>9 FACTOR CHECK</strong></div></div>
              <div className="technical-list">
                <Technical label="EMA 8 / 21" value={`${money(technicals?.ema8)} / ${money(technicals?.ema21)}`} state={technicals && technicals.ema8 > technicals.ema21 ? "bull" : "bear"} />
                <Technical label="RSI 14" value={money(technicals?.rsi14, 1)} state={technicals?.rsi14 && technicals.rsi14 > 55 ? "bull" : technicals?.rsi14 && technicals.rsi14 < 45 ? "bear" : "neutral"} />
                <Technical label="MACD / Signal" value={`${money(technicals?.macd, 3)} / ${money(technicals?.macdSignal, 3)}`} state={technicals?.macd && technicals.macdSignal && technicals.macd > technicals.macdSignal ? "bull" : "bear"} />
                <Technical label="ATR 14" value={money(technicals?.atr14)} state="neutral" />
                <Technical label="Breakout" value={`${money(technicals?.breakoutAtr)} ATR`} state={technicals?.breakoutAtr && technicals.breakoutAtr > 0 ? "bull" : "neutral"} />
                <Technical label="Bollinger position" value={`${money(technicals?.bollingerPosition)}σ`} state="neutral" />
                <Technical label="Candle shape" value={technicals?.candlePattern.replace("_", " ") ?? "—"} state={technicals?.candlePattern.includes("bullish") || technicals?.candlePattern === "hammer" ? "bull" : technicals?.candlePattern === "none" ? "neutral" : "bear"} />
                <Technical label="Volume" value={technicals?.volumeConfirmation == null ? "N/A" : technicals.volumeConfirmation ? "Confirmed" : "Unconfirmed"} state={technicals?.volumeConfirmation ? "bull" : "neutral"} />
                <Technical label="VWAP slope · 5m" value={money(technicals?.vwapSlope, 3)} state={technicals?.vwapSlope == null ? "neutral" : technicals.vwapSlope > 0 ? "bull" : "bear"} />
              </div>
            </article>
          </section>

          <section className="contracts-card">
            <div className="section-heading table-heading"><div><span>LIQUIDITY LEADERBOARD</span><strong>HIGHEST-RANKED {selectedDte}DTE CONTRACTS</strong></div><p>Rejected rows are dimmed · hover for reason</p></div>
            <div className="dte-tabs" role="tablist" aria-label="Filter contracts by days to expiration">{([0,1,2] as const).map(dte => <button key={dte} role="tab" aria-selected={selectedDte === dte} className={selectedDte === dte ? "selected":""} onClick={()=>setSelectedDte(dte)}>{dte}DTE <span>{data?.contracts.filter(contract => contract.dte === dte).length ?? 0}</span></button>)}</div>
            <div className="table-wrap"><table>
              <thead><tr>{["Rank", "Contract", "DTE", "Type", "Strike", "Bid / Ask", "Max debit", "Spread", "Volume", "Vol / OI", "Delta", "IV"].map((label) => <th key={label}>{label}</th>)}</tr></thead>
              <tbody>{selectedContracts.length ? selectedContracts.map((contract, index) => <ContractRow key={contract.ticker} contract={contract} rank={index + 1} />) : <tr><td className="empty-dte" colSpan={12}>No {selectedDte}DTE contracts returned in this scan.</td></tr>}</tbody>
            </table></div>
          </section>

          <footer className="risk-footer"><ShieldCheck size={15} /> Paper trading only. Every entry requires explicit approval and can lose 100% of its premium.</footer>
        </main>
      </div>
      {approvalOpen && signal?.contract ? <div className="approval-backdrop" role="presentation" onMouseDown={() => !submitting && setApprovalOpen(false)}><section className="approval-modal" role="dialog" aria-modal="true" aria-labelledby="approval-title" onMouseDown={event => event.stopPropagation()}>
        <div className="approval-icon"><ShieldCheck size={21}/></div><p className="eyebrow">ALPACA PAPER · BUY TO OPEN</p><h2 id="approval-title">Approve one contract?</h2>
        <div className="approval-symbol"><strong>{signal.contract.ticker}</strong><span>{signal.contract.side.toUpperCase()} · {signal.contract.dte} DTE · {signal.contract.strike} strike</span></div>
        <div className="approval-grid"><div><span>LIMIT PRICE</span><strong>${money(signal.contract.ask)}</strong></div><div><span>MAXIMUM DEBIT</span><strong>${money(signal.contract.ask * 100, 0)}</strong></div><div><span>PLANNED 30% STOP</span><strong>≈ ${money(signal.contract.ask * 30, 0)}</strong></div><div><span>QUANTITY</span><strong>1</strong></div></div>
        <p className="approval-warning">The server will rescan the market and re-check the 1% debit limit, $1,000 daily limit, trading window, open positions and duplicate orders before submission. The Railway manager handles exits only when it is online and enabled; otherwise close the position manually in Alpaca.</p>
        {orderMessage?.tone === "error" ? <div className="auth-alert error">{orderMessage.text}</div> : null}
        <div className="approval-actions"><button className="cancel-button" onClick={() => setApprovalOpen(false)} disabled={submitting}>Cancel</button><button className="confirm-button" onClick={() => void approveOrder()} disabled={submitting}>{submitting ? "Checking risk…" : "Approve paper order"}</button></div>
      </section></div> : null}
    </div>
  );
}

function MarketCard({ label, value, detail, icon, tone = "" }: { label: string; value: string; detail: string; icon: React.ReactNode; tone?: string }) {
  return <article className={`market-card ${tone}`}><div className="market-card-top"><span>{label}</span>{icon}</div><strong>{value}</strong><p>{detail}</p></article>;
}

function Confidence({ score }: { score: number }) {
  return <div className="confidence-help" tabIndex={0} aria-describedby="confidence-tooltip"><div className="confidence" style={{ "--score": `${score * 3.6}deg` } as React.CSSProperties}><div><strong>{score}</strong><span>CONFIDENCE</span></div></div><span className="hover-tooltip confidence-tooltip" id="confidence-tooltip" role="tooltip">This score measures chart confluence and the selected contract&apos;s relative liquidity. It is not a probability of profit or an AI forecast.</span></div>;
}

function ContractSpotlight({ contract }: { contract: Contract }) {
  return <div className="contract-spotlight"><div className="contract-symbol"><span className={contract.side}>{contract.side.toUpperCase()}</span><strong>{contract.ticker}</strong><p>{contract.expirationDate} · {contract.dte} DTE · {money(contract.strike)} strike</p></div><div className="contract-price"><span>MAX DEBIT</span><strong>${money(contract.ask * 100, 0)}</strong><p>${money(contract.bid)} bid / ${money(contract.ask)} ask</p></div><div className="contract-stats"><div><span>VOLUME</span><strong>{compact.format(contract.volume)}</strong></div><div><span>SPREAD</span><strong>{money(contract.spreadPct, 1)}%</strong></div><div><span>DELTA</span><strong>{money(contract.delta)}</strong></div><div><span>LIQUIDITY</span><strong>{contract.liquidityScore}/100</strong></div></div></div>;
}

function Technical({ label, value, state }: { label: string; value: string; state: "bull" | "bear" | "neutral" }) {
  return <div className="technical"><span className={`state-dot ${state}`} /><div><span>{label}</span><strong>{value}</strong></div></div>;
}

function PriceChart({ bars, reference }: { bars: Bar[]; reference: number | null }) {
  const chart = useMemo(() => {
    const visible = bars.slice(-60);
    if (visible.length < 2) return null;
    const values = visible.flatMap((bar) => [bar.high, bar.low]);
    if (reference != null) values.push(reference);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const x = (index: number) => (index / (visible.length - 1)) * 1000;
    const y = (value: number) => 260 - ((value - min) / range) * 220;
    const points = visible.map((bar, index) => `${x(index)},${y(bar.close)}`).join(" ");
    const area = `0,280 ${points} 1000,280`;
    return { visible, min, max, points, area, referenceY: reference == null ? null : y(reference) };
  }, [bars, reference]);
  if (!chart) return <div className="chart-empty"><Activity size={24} />Chart populates when the live bar feed is available.</div>;
  return <div className="price-chart"><svg viewBox="0 0 1000 300" preserveAspectRatio="none" role="img" aria-label="Recent one-minute price chart"><defs><linearGradient id="price-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#63e6be" stopOpacity=".25"/><stop offset="100%" stopColor="#63e6be" stopOpacity="0"/></linearGradient></defs><g className="grid-lines"><line x1="0" x2="1000" y1="40" y2="40"/><line x1="0" x2="1000" y1="113" y2="113"/><line x1="0" x2="1000" y1="186" y2="186"/><line x1="0" x2="1000" y1="260" y2="260"/></g>{chart.referenceY != null ? <line className="reference-line" x1="0" x2="1000" y1={chart.referenceY} y2={chart.referenceY}/> : null}<polygon className="price-area" points={chart.area}/><polyline className="price-line" points={chart.points}/></svg><span className="chart-high">{money(chart.max)}</span><span className="chart-low">{money(chart.min)}</span></div>;
}

function ContractRow({ contract, rank }: { contract: Contract; rank: number }) {
  return <tr className={contract.eligible ? "" : "rejected"} title={contract.rejectionReasons.join(", ")}><td><span className="rank">{rank}</span></td><td className="mono contract-ticker">{contract.ticker}</td><td>{contract.dte}</td><td><span className={`side-pill ${contract.side}`}>{contract.side.toUpperCase()}</span></td><td>{money(contract.strike)}</td><td>{money(contract.bid)} / {money(contract.ask)}</td><td className="debit">${money(contract.ask * 100, 0)}</td><td>{money(contract.spreadPct, 1)}%</td><td>{contract.volume.toLocaleString()}</td><td>{money(contract.volumeToOpenInterest)}</td><td>{money(contract.delta)}</td><td>{contract.impliedVolatility == null ? "—" : `${money(contract.impliedVolatility * 100, 1)}%`}</td></tr>;
}

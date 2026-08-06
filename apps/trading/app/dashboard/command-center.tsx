"use client";

import {
  Activity,
  BarChart3,
  BrainCircuit,
  CircleDollarSign,
  Clock3,
  Crosshair,
  RefreshCw,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Bar, CommandCenter, Contract, Underlying } from "@/lib/options/types";

const money = (value: number | null | undefined, digits = 2) =>
  value == null
    ? "—"
    : value.toLocaleString("en-US", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

export function CommandCenterView() {
  const [underlying, setUnderlying] = useState<Underlying>("SPY");
  const [data, setData] = useState<CommandCenter | null>(null);
  const [loading, setLoading] = useState(true);
  const [requestError, setRequestError] = useState<string | null>(null);

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

  const signal = data?.signal;
  const market = data?.market;
  const technicals = market?.technicals;
  const eligible = data?.contracts.filter((contract) => contract.eligible) ?? [];
  const actionTone = signal?.action === "enter_call" ? "call" : signal?.action === "enter_put" ? "put" : "wait";
  const actionLabel = signal?.action === "enter_call" ? "CALL SETUP" : signal?.action === "enter_put" ? "PUT SETUP" : "STAND ASIDE";
  const updated = data?.asOf ? new Date(data.asOf).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" }) : "Waiting for data";

  return (
    <div className="terminal-layout">
      <aside className="sidebar">
        <div className="brand-mark"><Zap size={17} fill="currentColor" /> VELOCITY</div>
        <div className="desk-label">OPTIONS DESK</div>
        <nav className="desk-nav" aria-label="Trading workspace">
          <span className="nav-item active"><BarChart3 size={16} /> Command center</span>
          <span className="nav-item"><Crosshair size={16} /> Setups <em>Live</em></span>
          <span className="nav-item"><Activity size={16} /> Replay lab <small>Soon</small></span>
          <span className="nav-item"><BrainCircuit size={16} /> AI review <small>Soon</small></span>
        </nav>
        <div className="sidebar-note">
          <ShieldCheck size={17} />
          <div><strong>Paper mode</strong><span>No brokerage connected</span></div>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">INTRADAY OPTIONS INTELLIGENCE</p>
            <h1>0–2 DTE Command Center</h1>
          </div>
          <div className="market-status"><span className="live-dot" /> LIVE DATA <b>{updated}</b></div>
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

          <section className="market-grid">
            <MarketCard label={`${underlying} LAST`} value={`$${money(market?.price)}`} detail={`${market?.regime ?? "waiting"} regime`} icon={market?.regime === "downtrend" ? <TrendingDown /> : <TrendingUp />} tone={market?.regime === "downtrend" ? "negative" : "positive"} />
            <MarketCard label={market?.referenceLabel ?? "VWAP"} value={`$${money(market?.referencePrice)}`} detail={market && market.price >= market.referencePrice ? "Price above reference" : "Price below reference"} icon={<Crosshair />} />
            <MarketCard label="OPENING RANGE" value={`${money(market?.openingRangeLow)} – ${money(market?.openingRangeHigh)}`} detail={market ? `${money(market.openingRangeHigh - market.openingRangeLow)} pts wide` : "Waiting"} icon={<BarChart3 />} />
            <MarketCard label="ELIGIBLE CONTRACTS" value={eligible.length.toString()} detail={`${data?.contracts.length ?? 0} contracts scanned`} icon={<CircleDollarSign />} />
          </section>

          <section className="decision-grid">
            <article className={`signal-card ${actionTone}`}>
              <div className="card-heading"><span>TRADE DECISION</span><span className="engine-tag">RULE ENGINE</span></div>
              <div className="signal-main">
                <div>
                  <p className="signal-kicker">CURRENT READ</p>
                  <h2>{actionLabel}</h2>
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
              {signal?.contract ? <ContractSpotlight contract={signal.contract} /> : (
                <div className="empty-contract"><Clock3 size={26} /><strong>No contract selected</strong><span>The scanner is waiting for directional confirmation and executable liquidity.</span></div>
              )}
            </article>
          </section>

          <section className="analysis-grid">
            <article className="chart-card">
              <div className="section-heading"><div><span>PRICE ACTION</span><strong>{underlying} · 1 MINUTE</strong></div><div className="chart-legend"><i /> Price <i className="reference" /> {market?.referenceLabel ?? "Reference"}</div></div>
              <PriceChart bars={market?.bars ?? []} reference={market?.referencePrice ?? null} />
            </article>
            <article className="technicals-card">
              <div className="section-heading"><div><span>CONFLUENCE MATRIX</span><strong>8 FACTOR CHECK</strong></div></div>
              <div className="technical-list">
                <Technical label="EMA 8 / 21" value={`${money(technicals?.ema8)} / ${money(technicals?.ema21)}`} state={technicals && technicals.ema8 > technicals.ema21 ? "bull" : "bear"} />
                <Technical label="RSI 14" value={money(technicals?.rsi14, 1)} state={technicals?.rsi14 && technicals.rsi14 > 55 ? "bull" : technicals?.rsi14 && technicals.rsi14 < 45 ? "bear" : "neutral"} />
                <Technical label="MACD / Signal" value={`${money(technicals?.macd, 3)} / ${money(technicals?.macdSignal, 3)}`} state={technicals?.macd && technicals.macdSignal && technicals.macd > technicals.macdSignal ? "bull" : "bear"} />
                <Technical label="ATR 14" value={money(technicals?.atr14)} state="neutral" />
                <Technical label="Breakout" value={`${money(technicals?.breakoutAtr)} ATR`} state={technicals?.breakoutAtr && technicals.breakoutAtr > 0 ? "bull" : "neutral"} />
                <Technical label="Bollinger position" value={`${money(technicals?.bollingerPosition)}σ`} state="neutral" />
                <Technical label="Candle shape" value={technicals?.candlePattern.replace("_", " ") ?? "—"} state={technicals?.candlePattern.includes("bullish") || technicals?.candlePattern === "hammer" ? "bull" : technicals?.candlePattern === "none" ? "neutral" : "bear"} />
                <Technical label="Volume" value={technicals?.volumeConfirmation == null ? "N/A" : technicals.volumeConfirmation ? "Confirmed" : "Unconfirmed"} state={technicals?.volumeConfirmation ? "bull" : "neutral"} />
              </div>
            </article>
          </section>

          <section className="contracts-card">
            <div className="section-heading table-heading"><div><span>LIQUIDITY LEADERBOARD</span><strong>HIGHEST-RANKED 0–2 DTE CONTRACTS</strong></div><p>Rejected rows are dimmed · hover for reason</p></div>
            <div className="table-wrap"><table>
              <thead><tr>{["Rank", "Contract", "DTE", "Type", "Strike", "Bid / Ask", "Max debit", "Spread", "Volume", "Vol / OI", "Delta", "IV"].map((label) => <th key={label}>{label}</th>)}</tr></thead>
              <tbody>{data?.contracts.map((contract, index) => <ContractRow key={contract.ticker} contract={contract} rank={index + 1} />)}</tbody>
            </table></div>
          </section>

          <footer className="risk-footer"><ShieldCheck size={15} /> Research and paper trading only. 0DTE options can lose 100% of premium rapidly. The engine does not place orders.</footer>
        </main>
      </div>
    </div>
  );
}

function MarketCard({ label, value, detail, icon, tone = "" }: { label: string; value: string; detail: string; icon: React.ReactNode; tone?: string }) {
  return <article className={`market-card ${tone}`}><div className="market-card-top"><span>{label}</span>{icon}</div><strong>{value}</strong><p>{detail}</p></article>;
}

function Confidence({ score }: { score: number }) {
  return <div className="confidence" style={{ "--score": `${score * 3.6}deg` } as React.CSSProperties}><div><strong>{score}</strong><span>CONFIDENCE</span></div></div>;
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

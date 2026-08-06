import { useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { getLoginUrl } from "@/const";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertTriangle, Activity, Bot, Clock3, LogOut, Radio, RefreshCw, ShieldAlert, TrendingDown, TrendingUp } from "lucide-react";

type Underlying = "SPY" | "SPX";

function number(value: number | null | undefined, digits = 2) {
  return value == null ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function ContractTable({ contracts }: { contracts: any[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-[11px] uppercase tracking-wider text-muted-foreground border-b">
          <tr>{["Score", "Contract", "DTE", "Type", "Strike", "Bid / Ask", "Spread", "Volume", "Vol/OI", "Delta", "IV"].map(label => <th key={label} className="px-3 py-2 text-left font-medium">{label}</th>)}</tr>
        </thead>
        <tbody>
          {contracts.map(contract => (
            <tr key={contract.ticker} className={`border-b border-border/50 ${contract.eligible ? "hover:bg-primary/5" : "opacity-45"}`} title={contract.rejectionReasons.join(", ")}>
              <td className="px-3 py-2"><span className={`font-mono font-semibold ${contract.liquidityScore >= 75 ? "text-emerald-500" : contract.liquidityScore >= 55 ? "text-amber-500" : "text-muted-foreground"}`}>{contract.liquidityScore}</span></td>
              <td className="px-3 py-2 font-mono text-xs">{contract.ticker}</td>
              <td className="px-3 py-2">{contract.dte}</td>
              <td className={`px-3 py-2 uppercase font-semibold ${contract.side === "call" ? "text-emerald-500" : "text-rose-500"}`}>{contract.side}</td>
              <td className="px-3 py-2 font-mono">{number(contract.strike)}</td>
              <td className="px-3 py-2 font-mono">{number(contract.bid)} / {number(contract.ask)}</td>
              <td className="px-3 py-2">{number(contract.spreadPct, 1)}%</td>
              <td className="px-3 py-2 font-mono">{contract.volume.toLocaleString()}</td>
              <td className="px-3 py-2">{number(contract.volumeToOpenInterest, 2)}</td>
              <td className="px-3 py-2">{number(contract.delta, 2)}</td>
              <td className="px-3 py-2">{contract.impliedVolatility == null ? "—" : `${number(contract.impliedVolatility * 100, 1)}%`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {contracts.length === 0 && <div className="py-12 text-center text-muted-foreground">No 0–2 DTE contracts available.</div>}
    </div>
  );
}

export default function OptionsCommandCenter() {
  const { user, loading, logout } = useAuth();
  const [underlying, setUnderlying] = useState<Underlying>("SPY");
  const query = trpc.options.commandCenter.useQuery({ underlying }, {
    enabled: Boolean(user), refetchInterval: 15_000, refetchIntervalInBackground: true, retry: 1,
  });
  const data = query.data;
  const signal = data?.signal;

  if (loading) return <div className="min-h-screen grid place-items-center"><RefreshCw className="animate-spin" /></div>;
  if (!user) return (
    <div className="min-h-screen grid place-items-center bg-background"><Card className="max-w-md"><CardHeader><CardTitle>Options Command Center</CardTitle></CardHeader><CardContent className="space-y-4"><p className="text-sm text-muted-foreground">Sign in to access the private paper-trading research system.</p><Button className="w-full" onClick={() => { window.location.href = getLoginUrl(); }}>Sign in</Button></CardContent></Card></div>
  );

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b bg-background/90 backdrop-blur">
        <div className="mx-auto max-w-[1500px] px-5 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3"><div className="h-9 w-9 rounded-lg bg-primary/10 grid place-items-center"><Activity className="h-5 w-5 text-primary" /></div><div><h1 className="font-semibold tracking-tight">0–2 DTE Command Center</h1><p className="text-xs text-muted-foreground">SPX / SPY · shadow mode · no live orders</p></div></div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="gap-1"><Radio className="h-3 w-3" />15s monitor</Badge>
            <Button variant="outline" size="sm" onClick={() => query.refetch()} disabled={query.isFetching}><RefreshCw className={`h-4 w-4 ${query.isFetching ? "animate-spin" : ""}`} /></Button>
            <Button variant="ghost" size="sm" onClick={async () => { await logout(); window.location.href = "/login"; }}><LogOut className="h-4 w-4" /></Button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1500px] p-5 space-y-5">
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/8 px-4 py-3 flex gap-3 text-sm"><ShieldAlert className="h-5 w-5 text-amber-500 shrink-0" /><div><strong>Research and paper trading only.</strong> 0DTE options can lose their entire premium rapidly. AI can reject or annotate a deterministic signal; it cannot bypass liquidity or risk controls.</div></div>

        {underlying === "SPX" && <div className="rounded-xl border border-violet-500/30 bg-violet-500/8 px-4 py-3 text-sm"><strong>SPX mode:</strong> signals now use the SPX index itself, not SPY. SPX options are cash-settled, European-style, and generally use a $100 multiplier. Confirm that a same-day contract is the intended PM-settled SPXW series before acting; the snapshot alone is not treated as proof of its settlement session.</div>}

        {!data?.configured && <div className="rounded-xl border border-blue-500/30 bg-blue-500/8 px-4 py-3 text-sm"><strong>Data connection required.</strong> Add <code>MASSIVE_API_KEY</code> to the server environment. Real-time monitoring requires a real-time options plan, not delayed data.</div>}
        {data?.errors.map((error, index) => <div key={index} className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive flex gap-2"><AlertTriangle className="h-4 w-4" />{error}</div>)}

        <section className="grid gap-4 md:grid-cols-4">
          <Card><CardHeader className="pb-2"><CardTitle className="text-xs uppercase text-muted-foreground">Underlying</CardTitle></CardHeader><CardContent><div className="flex gap-2">{(["SPY", "SPX"] as Underlying[]).map(symbol => <Button key={symbol} size="sm" variant={underlying === symbol ? "default" : "outline"} onClick={() => setUnderlying(symbol)}>{symbol}</Button>)}</div></CardContent></Card>
          <Card><CardHeader className="pb-2"><CardTitle className="text-xs uppercase text-muted-foreground">{underlying} state</CardTitle></CardHeader><CardContent><div className="text-2xl font-mono font-semibold">${number(data?.market?.price)}</div><div className="text-xs text-muted-foreground">{data?.market?.referenceLabel === "SESSION_MEAN" ? "Session mean" : "VWAP"} ${number(data?.market?.referencePrice)} · {data?.market?.regime ?? "waiting"}</div></CardContent></Card>
          <Card><CardHeader className="pb-2"><CardTitle className="text-xs uppercase text-muted-foreground">Opening range</CardTitle></CardHeader><CardContent><div className="text-sm font-mono"><span className="text-emerald-500">H {number(data?.market?.openingRangeHigh)}</span><span className="mx-2 text-muted-foreground">/</span><span className="text-rose-500">L {number(data?.market?.openingRangeLow)}</span></div><div className="text-xs text-muted-foreground mt-1">First 15 one-minute bars</div></CardContent></Card>
          <Card><CardHeader className="pb-2"><CardTitle className="text-xs uppercase text-muted-foreground">Data freshness</CardTitle></CardHeader><CardContent><div className="flex items-center gap-2"><Clock3 className="h-4 w-4 text-primary" /><span className="font-mono text-sm">{data ? new Date(data.asOf).toLocaleTimeString() : "—"}</span></div><div className="text-xs text-muted-foreground mt-1">Massive / OPRA</div></CardContent></Card>
        </section>

        <Card><CardHeader><CardTitle className="text-base">Chart confluence</CardTitle></CardHeader><CardContent><div className="grid grid-cols-2 gap-4 md:grid-cols-4 lg:grid-cols-8 text-sm">
          <div><p className="text-xs text-muted-foreground">EMA 8 / 21</p><p className="font-mono">{number(data?.market?.technicals.ema8)} / {number(data?.market?.technicals.ema21)}</p></div>
          <div><p className="text-xs text-muted-foreground">RSI (14)</p><p className="font-mono">{number(data?.market?.technicals.rsi14, 1)}</p></div>
          <div><p className="text-xs text-muted-foreground">MACD / signal</p><p className="font-mono">{number(data?.market?.technicals.macd, 3)} / {number(data?.market?.technicals.macdSignal, 3)}</p></div>
          <div><p className="text-xs text-muted-foreground">ATR (14)</p><p className="font-mono">{number(data?.market?.technicals.atr14, 2)}</p></div>
          <div><p className="text-xs text-muted-foreground">Breakout strength</p><p className="font-mono">{number(data?.market?.technicals.breakoutAtr, 2)} ATR</p></div>
          <div><p className="text-xs text-muted-foreground">Bollinger position</p><p className="font-mono">{number(data?.market?.technicals.bollingerPosition, 2)}σ</p></div>
          <div><p className="text-xs text-muted-foreground">Candle shape</p><p className="capitalize">{data?.market?.technicals.candlePattern?.replace("_", " ") ?? "—"}</p></div>
          <div><p className="text-xs text-muted-foreground">Volume confirmation</p><p>{data?.market?.technicals.volumeConfirmation == null ? "N/A for SPX" : data.market.technicals.volumeConfirmation ? "Confirmed" : "Not confirmed"}</p></div>
        </div></CardContent></Card>

        <section className="grid gap-4 lg:grid-cols-[1fr_2fr]">
          <Card className={signal?.action === "enter_call" ? "border-emerald-500/40" : signal?.action === "enter_put" ? "border-rose-500/40" : ""}>
            <CardHeader><CardTitle className="flex items-center gap-2 text-base">{signal?.action === "enter_call" ? <TrendingUp className="text-emerald-500" /> : signal?.action === "enter_put" ? <TrendingDown className="text-rose-500" /> : <Activity className="text-muted-foreground" />}Current deterministic signal</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between"><Badge className="uppercase">{signal?.action?.replace("_", " ") ?? "waiting"}</Badge><span className="font-mono text-sm">{signal?.confidence ?? 0}/100</span></div>
              <div className="space-y-2 text-sm">{signal?.reasons.map((reason, index) => <div key={index} className="flex gap-2"><span className="text-primary">•</span>{reason}</div>)}</div>
              {signal?.invalidation && <div className="rounded-lg bg-destructive/8 p-3 text-xs"><strong>Invalidation:</strong> {signal.invalidation}</div>}
              {signal?.aiReview && <div className="rounded-lg border bg-muted/30 p-3 space-y-2 text-xs"><div className="flex items-center gap-2 font-semibold"><Bot className="h-4 w-4" />AI review · {signal.aiReview.verdict}</div><p>{signal.aiReview.summary}</p>{signal.aiReview.risks.map((risk: string, index: number) => <p key={index} className="text-muted-foreground">• {risk}</p>)}</div>}
              {!data?.aiReviewEnabled && <div className="rounded-lg border bg-muted/20 p-3 text-xs text-muted-foreground"><div className="flex items-center gap-2 font-semibold text-foreground"><Bot className="h-4 w-4" />AI review is off</div><p className="mt-1">The contract and entry are selected entirely by fixed market, liquidity, volume, spread, and risk rules. Set <code>AI_OPTIONS_REVIEW_ENABLED=true</code> only if you want a second-opinion explanation.</p></div>}
            </CardContent>
          </Card>
          <Card><CardHeader><CardTitle className="text-base">Selected contract · $8.00 quote cap</CardTitle></CardHeader><CardContent>{signal?.contract ? <div className="grid grid-cols-2 md:grid-cols-5 gap-4"><div><p className="text-xs text-muted-foreground">Symbol</p><p className="font-mono text-xs break-all">{signal.contract.ticker}</p></div><div><p className="text-xs text-muted-foreground">Bid / Ask</p><p className="font-mono">{number(signal.contract.bid)} / {number(signal.contract.ask)}</p></div><div><p className="text-xs text-muted-foreground">Maximum debit at ask</p><p className="font-mono">${number(signal.contract.ask * 100, 0)}</p></div><div><p className="text-xs text-muted-foreground">Volume</p><p className="font-mono">{signal.contract.volume.toLocaleString()}</p></div><div><p className="text-xs text-muted-foreground">Why this one</p><p className="font-mono">#{(data?.contracts ?? []).findIndex((contract: any) => contract.ticker === signal.contract?.ticker) + 1} liquidity rank · {signal.contract.liquidityScore}/100</p></div></div> : <p className="text-sm text-muted-foreground">No eligible contract selected below the $8.00 ask cap.</p>}</CardContent></Card>
        </section>

        <Card><CardHeader><CardTitle className="text-base">Highest-quality 0–2 DTE contracts</CardTitle></CardHeader><CardContent className="p-0"><ContractTable contracts={data?.contracts ?? []} /></CardContent></Card>
      </div>
    </main>
  );
}

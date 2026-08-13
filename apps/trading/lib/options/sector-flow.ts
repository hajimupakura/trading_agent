import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAlert } from "@/lib/alerts/server";
import { getOptionChain } from "./provider";
import { WATCH_UNDERLYINGS, type Underlying } from "./types";

// Sector money-flow radar. Answers "where is the money today — metals, semiconductors,
// aerospace?" from sector ETFs (the baskets institutions trade sectors with), and names
// a concrete, screened way to play it. Three reads:
//   1. ~8:40 pre-market map: which sectors are GAPPING vs the market (prep — volume is
//      thin before the open and options don't trade until 9:30, so this is a plan).
//   2. ~10:00 money map: confirmed with real session volume vs each sector's 20-day norm.
//   3. Intraday rotation alerts (top 2/day) when a sector crosses the strong bar —
//      including the best executable contract from that sector's own option chain,
//      screened with the same quality checks the engine uses.
// Suggested plays are MANUAL-entry only; the engine still trades SPY/SPX exclusively.
// Anything bought manually is adopted and auto-protected by the position worker.
// Data: Alpaca IEX feed; today's volume is compared against the SAME feed's 20-day
// average, so partial-feed volume stays apples-to-apples.

interface Sector { etf: string; label: string; leaders: string[] }
const SECTORS: Sector[] = [
  { etf: "SMH", label: "semiconductors", leaders: ["NVDA", "AMD", "AVGO", "TSM", "MU"] },
  { etf: "ITA", label: "aerospace & defense", leaders: ["GE", "RTX", "BA", "LMT", "NOC"] },
  { etf: "XME", label: "metals & mining", leaders: ["FCX", "NEM", "AA", "X", "CLF"] },
  { etf: "GDX", label: "gold miners", leaders: ["NEM", "GOLD", "AEM"] },
  { etf: "REMX", label: "rare earths & strategic metals", leaders: ["MP", "LYC", "TMC"] },
  { etf: "ARKX", label: "space & orbital economy", leaders: ["SPCX", "ASTS", "RKLB", "LUNR"] },
  { etf: "XLE", label: "energy (oil & gas)", leaders: ["XOM", "CVX", "COP", "SLB"] },
  { etf: "XLF", label: "big banks & finance", leaders: ["JPM", "BAC", "WFC", "GS"] },
  { etf: "KRE", label: "regional banks", leaders: ["ZION", "KEY", "RF"] },
  { etf: "XLK", label: "technology (mega-cap)", leaders: ["AAPL", "MSFT", "NVDA"] },
  { etf: "XLC", label: "communications & media", leaders: ["META", "GOOGL", "NFLX"] },
  { etf: "XLV", label: "healthcare", leaders: ["LLY", "UNH", "JNJ", "MRK"] },
  { etf: "XBI", label: "biotech", leaders: ["MRNA", "VRTX", "REGN"] },
  { etf: "XLI", label: "industrials", leaders: ["CAT", "GE", "HON", "DE"] },
  { etf: "XLB", label: "materials & chemicals", leaders: ["LIN", "SHW", "FCX", "DOW"] },
  { etf: "XLY", label: "consumer spending (discretionary)", leaders: ["AMZN", "TSLA", "HD"] },
  { etf: "XLP", label: "consumer staples", leaders: ["PG", "KO", "COST", "WMT"] },
  { etf: "XLU", label: "utilities", leaders: ["NEE", "SO", "DUK"] },
  { etf: "XLRE", label: "real estate", leaders: ["PLD", "AMT", "EQIX"] },
  { etf: "IWM", label: "small companies (Russell 2000)", leaders: [] },
];

const et = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" }).formatToParts(date);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { minutes: Number(value.hour) * 60 + Number(value.minute), weekday: value.weekday };
};
const etDate = (date = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(date);

function headers() {
  const key = process.env.ALPACA_API_KEY_ID; const secret = process.env.ALPACA_API_SECRET_KEY;
  if (!key || !secret) throw new Error("Alpaca keys are not configured");
  return { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret };
}

interface SnapshotBar { c: number; v: number; t: string }
interface Snapshot { dailyBar?: SnapshotBar; prevDailyBar?: SnapshotBar; latestTrade?: { p: number } }

// Pre-market, today's daily bar does not exist yet on the IEX feed, so a snapshot's
// `dailyBar` still holds YESTERDAY's session and `prevDailyBar` the day BEFORE that.
// Trusting the prevDailyBar slot before the open compares against a two-day-old close
// and manufactures phantom gaps (2026-08-13: "SPCX gapping +9.7%" that was really
// Tuesday's intraday move). Resolve the prior close by bar DATE, never slot position.
function priorClose(snap: Snapshot | undefined, today: string): number | null {
  if (snap?.dailyBar?.c && etDate(new Date(snap.dailyBar.t)) < today) return snap.dailyBar.c;
  return snap?.prevDailyBar?.c ?? null;
}
async function getSnapshots(symbols: string[]): Promise<Record<string, Snapshot>> {
  const url = new URL("https://data.alpaca.markets/v2/stocks/snapshots");
  url.searchParams.set("symbols", symbols.join(",")); url.searchParams.set("feed", "iex");
  const response = await fetch(url, { headers: headers(), cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Alpaca snapshots ${response.status}`);
  return await response.json() as Record<string, Snapshot>;
}

async function getAvgVolumes(symbols: string[]): Promise<Record<string, number>> {
  const url = new URL("https://data.alpaca.markets/v2/stocks/bars");
  url.searchParams.set("symbols", symbols.join(",")); url.searchParams.set("timeframe", "1Day");
  url.searchParams.set("feed", "iex"); url.searchParams.set("limit", "1000");
  url.searchParams.set("adjustment", "all"); url.searchParams.set("sort", "asc");
  const start = new Date(Date.now() - 45 * 86_400_000).toISOString().slice(0, 10);
  url.searchParams.set("start", start);
  const response = await fetch(url, { headers: headers(), cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Alpaca daily bars ${response.status}`);
  const payload = await response.json() as { bars?: Record<string, Array<{ t: string; v: number }>> };
  const today = etDate();
  const out: Record<string, number> = {};
  for (const [symbol, bars] of Object.entries(payload.bars ?? {})) {
    const history = bars.filter(bar => etDate(new Date(bar.t)) < today).slice(-20);
    if (history.length >= 10) out[symbol] = history.reduce((sum, bar) => sum + bar.v, 0) / history.length;
  }
  return out;
}

export interface SectorRead {
  etf: string; label: string; changePct: number; excessPct: number; relVolume: number; flagged: boolean; direction: "in" | "out";
}

async function ownerId(): Promise<string | null> {
  const { data } = await createAdminClient().from("profiles").select("id").limit(1).maybeSingle();
  return data?.id ?? null;
}

const pct = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;

// The concrete, screened play: pull the sector ETF's own option chain and pick the top
// contract that passes the engine-grade quality screen (spread, freshness, liquidity)
// on the side the money is flowing. Same standards as SPY — different underlying.
// Every suggestion is recorded to sector_play_suggestions so it can be graded later.
async function bestPlayLine(today: string, etf: string, direction: "in" | "out", source: "map" | "rotation"): Promise<string> {
  try {
    const chain = await getOptionChain(etf as Underlying, undefined, { monitorOnly: true });
    const side = direction === "in" ? "call" : "put";
    const pick = chain.find(contract =>
      contract.side === side && contract.eligible && contract.dte <= 7 && contract.midpoint >= 0.5 &&
      (contract.delta == null || (Math.abs(contract.delta) >= 0.2 && Math.abs(contract.delta) <= 0.5)));
    if (!pick) return "";
    await createAdminClient().from("sector_play_suggestions").upsert({
      session_date: today, etf, direction, contract_ticker: pick.ticker, side, strike: pick.strike,
      expiration_date: pick.expirationDate, ask: pick.ask, spread_pct: pick.spreadPct, delta: pick.delta, source,
    }, { onConflict: "session_date,etf,source", ignoreDuplicates: true });
    const greek = pick.delta != null ? `, delta ${Math.abs(pick.delta).toFixed(2)} (moves ~${Math.round(Math.abs(pick.delta) * 100)}¢ per $1 in ${etf})` : "";
    return ` Screened way to play it: ${etf} $${pick.strike} ${side} expiring ${pick.expirationDate} — ask $${pick.ask.toFixed(2)}, spread ${pick.spreadPct.toFixed(1)}%${greek}. Manual entry only; anything you buy is auto-protected by the worker (stop, trail, time exits).`;
  } catch { return ""; }
}

export async function runSectorFlow(): Promise<{ fired: string[]; errors: string[] }> {
  const clock = et();
  const fired: string[] = []; const errors: string[] = [];
  if (["Sat", "Sun"].includes(clock.weekday)) return { fired, errors };
  const preMarket = clock.minutes >= 510 && clock.minutes < 565;   // 8:30-9:24 ET
  const session = clock.minutes >= 580 && clock.minutes <= 965;    // 9:40-16:05 ET
  if (!preMarket && !session) return { fired, errors };
  const userId = await ownerId();
  if (!userId) return { fired, errors };
  const today = etDate();
  const admin = createAdminClient();
  const guard = async (label: string, run: () => Promise<void>) => {
    try { await run(); } catch (error) { errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
  };

  const symbols = ["SPY", ...SECTORS.map(sector => sector.etf)];

  // ---- Pre-market read: gap-based, volume-free. One alert ~8:40; feeds the 9:15 AI brief.
  if (preMarket) {
    // Watchlist single-name gap sweep: any watched ticker gapping >=3% pre-market gets
    // its own instant alert (thin pre-market trades — price is indicative, not firm).
    await guard("premarket-names", async () => {
      const snaps = await getSnapshots([...WATCH_UNDERLYINGS]);
      for (const symbol of WATCH_UNDERLYINGS) {
        const snap = snaps[symbol];
        const base = priorClose(snap, today);
        if (!snap?.latestTrade?.p || !base) continue;
        const gapPct = (snap.latestTrade.p / base - 1) * 100;
        if (Math.abs(gapPct) < 3) continue;
        const eventKey = `radar-gap-name-${today}-${symbol}`;
        const { data: seen } = await admin.from("alerts").select("id").eq("event_key", eventKey).limit(1).maybeSingle();
        if (seen) continue;
        await createAlert({
          userId, eventKey, severity: "warning",
          title: `${symbol} gapping ${pct(gapPct)} pre-market`,
          body: `${symbol} is trading around $${snap.latestTrade.p.toFixed(2)} pre-market vs yesterday's $${base.toFixed(2)} close — likely overnight news. Pre-market prices are thin and can move; check the story before doing anything. Options open at 9:30; big gaps often keep trending, but the disciplined entry waits for the first 15 minutes to confirm direction. Nothing is being bought automatically.`,
          metadata: { kind: "premarket_gap", symbol, gapPct: +gapPct.toFixed(2) },
        });
        fired.push(`gap-${symbol}`);
      }
    });
    await guard("premarket", async () => {
      const snapshots = await getSnapshots(symbols);
      const spy = snapshots.SPY;
      const spyBase = priorClose(spy, today);
      if (!spy?.latestTrade?.p || !spyBase) return;
      const spyGap = (spy.latestTrade.p / spyBase - 1) * 100;
      const moves = SECTORS.flatMap(sector => {
        const snap = snapshots[sector.etf];
        const base = priorClose(snap, today);
        if (!snap?.latestTrade?.p || !base) return [];
        const gap = (snap.latestTrade.p / base - 1) * 100;
        return [{ label: sector.label, etf: sector.etf, gap, excess: gap - spyGap }];
      }).filter(move => Math.abs(move.excess) >= 0.5)
        .sort((a, b) => Math.abs(b.excess) - Math.abs(a.excess)).slice(0, 4);
      if (!moves.length) return;
      await admin.from("sector_flow_history").insert({ session_date: today, minutes: clock.minutes, phase: "premarket", spy_change: spyGap, reads: moves }).then(({ error }) => { if (error) errors.push(`premarket history: ${error.message}`); });
      const describe = (move: { label: string; gap: number }) => `${move.label} (${pct(move.gap)})`;
      await createAlert({
        userId, eventKey: `radar-sectors-pre-${today}`, severity: "info",
        title: "Pre-market money map — sectors gapping before the open",
        body: `Vs the overall market at ${pct(spyGap)} pre-market: ${moves.map(describe).join(" · ")}. Pre-market trading is thin, so treat this as prep, not proof — and options don't trade until 9:30. The 10:00 check confirms with real volume and names a screened play. Nothing to do yet.`,
        metadata: { kind: "sector_premarket", spyGap, moves },
      });
      fired.push("premarket");
    });
    return { fired, errors };
  }

  // ---- Regular session: volume-confirmed reads.
  const [snapshots, avgVolumes] = await Promise.all([getSnapshots(symbols), getAvgVolumes(symbols)]);
  const spy = snapshots.SPY;
  // Session reads require today's bar to actually BE today's (thin IEX names can lag
  // just after the open) and price the change against the date-resolved prior close.
  const todaysBar = (snap: Snapshot | undefined) => snap?.dailyBar?.c && etDate(new Date(snap.dailyBar.t)) === today ? snap.dailyBar : null;
  const spyBar = todaysBar(spy); const spyBase = priorClose(spy, today);
  if (!spyBar || !spyBase) return { fired, errors: ["SPY snapshot missing"] };
  const spyChange = (spyBar.c / spyBase - 1) * 100;
  // Volume-so-far judged against a pro-rated share of the 20-day average (floored so
  // the first minutes don't divide by ~0).
  const pace = Math.min(1, Math.max(0.2, (clock.minutes - 570) / 390));

  const reads: SectorRead[] = [];
  for (const sector of SECTORS) {
    const snap = snapshots[sector.etf];
    const avgVol = avgVolumes[sector.etf];
    const bar = todaysBar(snap); const base = priorClose(snap, today);
    if (!bar || !base || !avgVol) continue;
    const changePct = (bar.c / base - 1) * 100;
    const excessPct = changePct - spyChange;
    const relVolume = bar.v / (avgVol * pace);
    const flagged = (Math.abs(excessPct) >= 0.7 && relVolume >= 1.3) || Math.abs(excessPct) >= 1.5 || (relVolume >= 2.2 && Math.abs(excessPct) >= 0.4);
    reads.push({ etf: sector.etf, label: sector.label, changePct, excessPct, relVolume, flagged, direction: excessPct >= 0 ? "in" : "out" });
  }
  reads.sort((a, b) => Math.abs(b.excessPct) * Math.min(b.relVolume, 3) - Math.abs(a.excessPct) * Math.min(a.relVolume, 3));

  const { error: persistError } = await admin.from("sector_flow_snapshots").upsert({ id: "latest", payload: { asOf: Date.now(), spyChange, reads }, updated_at: new Date().toISOString() });
  if (persistError) errors.push(`sector persistence: ${persistError.message}`);
  // Append every read — the raw feed for the future sector-rotation backtest.
  const { error: historyError } = await admin.from("sector_flow_history").insert({ session_date: today, minutes: clock.minutes, phase: "session", spy_change: spyChange, reads });
  if (historyError) errors.push(`sector history: ${historyError.message}`);

  // 1) Daily money map at ~10:00 — the day's rotation picture plus one screened play.
  if (clock.minutes >= 600 && clock.minutes <= 615) await guard("map", async () => {
    const { data: existing } = await admin.from("alerts").select("id").eq("event_key", `radar-sectors-${today}`).limit(1).maybeSingle();
    if (existing) return;
    const strongIn = reads.filter(read => read.direction === "in" && read.flagged).slice(0, 3);
    const strongOut = reads.filter(read => read.direction === "out" && read.flagged).slice(0, 3);
    const describe = (read: SectorRead) => `${read.label} (${pct(read.changePct)} vs market ${pct(spyChange)}, ${read.relVolume.toFixed(1)}x normal volume)`;
    const top = strongIn[0] ?? strongOut[0];
    const play = top ? await bestPlayLine(today, top.etf, top.direction, "map") : "";
    await createAlert({
      userId, eventKey: `radar-sectors-${today}`, severity: "info",
      title: "Where the money is today (10:00 check)",
      body: [
        strongIn.length ? `Money flowing IN: ${strongIn.map(describe).join(" · ")}.` : "No sector is pulling in unusual money so far.",
        strongOut.length ? `Money flowing OUT: ${strongOut.map(describe).join(" · ")}.` : "",
        play,
        "SPY/SPX remain the engine's home turf — sector plays are optional side dishes, one contract, money you can lose.",
      ].filter(Boolean).join(" "),
      metadata: { kind: "sector_map", spyChange, top: reads.slice(0, 5) },
    });
    fired.push("map");
  });

  // 2) Intraday rotation alerts: a sector crossing the strong bar, once per day each.
  for (const read of reads.filter(read => read.flagged && Math.abs(read.excessPct) >= 1).slice(0, 2)) {
    await guard(read.etf, async () => {
      const eventKey = `radar-sector-${today}-${read.etf}`;
      const { data: existing } = await admin.from("alerts").select("id").eq("event_key", eventKey).limit(1).maybeSingle();
      if (existing) return;
      const sector = SECTORS.find(candidate => candidate.etf === read.etf)!;
      let leadersLine = "";
      if (sector.leaders.length) {
        const leaderSnaps = await getSnapshots(sector.leaders).catch(() => ({} as Record<string, Snapshot>));
        const moves = sector.leaders
          .map(symbol => { const snap = leaderSnaps[symbol]; const bar = todaysBar(snap); const base = priorClose(snap, today); return bar && base ? { symbol, move: (bar.c / base - 1) * 100 } : null; })
          .filter((entry): entry is { symbol: string; move: number } => entry != null)
          .sort((a, b) => (read.direction === "in" ? b.move - a.move : a.move - b.move))
          .slice(0, 3);
        if (moves.length) leadersLine = ` Big names ${read.direction === "in" ? "leading" : "falling"}: ${moves.map(entry => `${entry.symbol} ${pct(entry.move)}`).join(", ")}.`;
      }
      const play = await bestPlayLine(today, read.etf, read.direction, "rotation");
      await createAlert({
        userId, eventKey, severity: "info",
        title: `Money is ${read.direction === "in" ? "flowing into" : "leaving"} ${read.label}`,
        body: `The ${read.label} group (${read.etf}) is ${read.direction === "in" ? "up" : "down"} ${pct(read.changePct).replace("+", "")} today while the overall market is at ${pct(spyChange)}, on ${read.relVolume.toFixed(1)}x its normal trading volume — that combination usually means real money rotating ${read.direction === "in" ? "in" : "out"}.${leadersLine}${play}`,
        metadata: { kind: "sector_rotation", ...read },
      });
      fired.push(read.etf);
    });
  }

  return { fired, errors };
}

// Latest confirmed sector reads for other modules (convexity scan, morning brief).
export async function latestSectorContext(): Promise<string> {
  try {
    const { data } = await createAdminClient().from("sector_flow_snapshots").select("payload,updated_at").eq("id", "latest").maybeSingle();
    const payload = data?.payload as { asOf?: number; spyChange?: number; reads?: SectorRead[] } | undefined;
    if (!payload?.reads || !payload.asOf || Date.now() - payload.asOf > 5 * 3_600_000) return "";
    const flagged = payload.reads.filter(read => read.flagged).slice(0, 4);
    if (!flagged.length) return "";
    const wording = (read: SectorRead) => `${read.label} ${read.direction === "in" ? "strong" : "weak"} (${pct(read.excessPct)} vs market, ${read.relVolume.toFixed(1)}x volume)`;
    return `Today's money map: ${flagged.map(wording).join(" · ")}.`;
  } catch { return ""; }
}

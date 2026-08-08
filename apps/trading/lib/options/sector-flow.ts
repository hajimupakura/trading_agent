import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAlert } from "@/lib/alerts/server";

// Sector money-flow radar. Answers one question in plain English: "where is the money
// today — metals, semiconductors, aerospace?" Measured from sector ETFs (the baskets
// institutions actually trade sectors with): unusual volume + outperformance vs SPY =
// money rotating in. Monitor-only — nothing here can trade; alerts are context.
// Data: Alpaca IEX feed. IEX volume is partial, but today's volume is compared against
// the SAME feed's 20-day average, so the ratio stays apples-to-apples.

interface Sector { etf: string; label: string; leaders: string[] }
const SECTORS: Sector[] = [
  { etf: "SMH", label: "semiconductors", leaders: ["NVDA", "AMD", "AVGO", "TSM", "MU"] },
  { etf: "ITA", label: "aerospace & defense", leaders: ["GE", "RTX", "BA", "LMT", "NOC"] },
  { etf: "XME", label: "metals & mining", leaders: ["FCX", "NEM", "AA", "X", "CLF"] },
  { etf: "GDX", label: "gold miners", leaders: ["NEM", "GOLD", "AEM"] },
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

interface SnapshotBar { c: number; v: number }
interface Snapshot { dailyBar?: SnapshotBar; prevDailyBar?: SnapshotBar }
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

export async function runSectorFlow(): Promise<{ fired: string[]; errors: string[] }> {
  const clock = et();
  const fired: string[] = []; const errors: string[] = [];
  // Market hours only, after the first 10 minutes have produced meaningful volume.
  if (["Sat", "Sun"].includes(clock.weekday) || clock.minutes < 580 || clock.minutes > 965) return { fired, errors };
  const userId = await ownerId();
  if (!userId) return { fired, errors };
  const today = etDate();

  const symbols = ["SPY", ...SECTORS.map(sector => sector.etf)];
  const [snapshots, avgVolumes] = await Promise.all([getSnapshots(symbols), getAvgVolumes(symbols)]);
  const spy = snapshots.SPY;
  if (!spy?.dailyBar?.c || !spy.prevDailyBar?.c) return { fired, errors: ["SPY snapshot missing"] };
  const spyChange = (spy.dailyBar.c / spy.prevDailyBar.c - 1) * 100;
  // How far through the session are we? Volume-so-far is judged against a pro-rated
  // share of the 20-day average (floored so the first minutes don't divide by ~0).
  const pace = Math.min(1, Math.max(0.2, (clock.minutes - 570) / 390));

  const reads: SectorRead[] = [];
  for (const sector of SECTORS) {
    const snap = snapshots[sector.etf];
    const avgVol = avgVolumes[sector.etf];
    if (!snap?.dailyBar?.c || !snap.prevDailyBar?.c || !avgVol) continue;
    const changePct = (snap.dailyBar.c / snap.prevDailyBar.c - 1) * 100;
    const excessPct = changePct - spyChange;
    const relVolume = snap.dailyBar.v / (avgVol * pace);
    const flagged = (Math.abs(excessPct) >= 0.7 && relVolume >= 1.3) || Math.abs(excessPct) >= 1.5 || (relVolume >= 2.2 && Math.abs(excessPct) >= 0.4);
    reads.push({ etf: sector.etf, label: sector.label, changePct, excessPct, relVolume, flagged, direction: excessPct >= 0 ? "in" : "out" });
  }
  reads.sort((a, b) => Math.abs(b.excessPct) * Math.min(b.relVolume, 3) - Math.abs(a.excessPct) * Math.min(a.relVolume, 3));

  const admin = createAdminClient();
  const { error: persistError } = await admin.from("sector_flow_snapshots").upsert({ id: "latest", payload: { asOf: Date.now(), spyChange, reads }, updated_at: new Date().toISOString() });
  if (persistError) errors.push(`sector persistence: ${persistError.message}`);

  const guard = async (label: string, run: () => Promise<void>) => {
    try { await run(); } catch (error) { errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
  };

  // 1) Daily money map at ~10:00 — one alert, the day's rotation picture.
  if (clock.minutes >= 600 && clock.minutes <= 615) await guard("map", async () => {
    const strongIn = reads.filter(read => read.direction === "in" && read.flagged).slice(0, 3);
    const strongOut = reads.filter(read => read.direction === "out" && read.flagged).slice(0, 3);
    const describe = (read: SectorRead) => `${read.label} (${pct(read.changePct)} vs market ${pct(spyChange)}, ${read.relVolume.toFixed(1)}x normal volume)`;
    await createAlert({
      userId, eventKey: `radar-sectors-${today}`, severity: "info",
      title: "Where the money is today (10:00 check)",
      body: [
        strongIn.length ? `Money flowing IN: ${strongIn.map(describe).join(" · ")}.` : "No sector is pulling in unusual money so far.",
        strongOut.length ? `Money flowing OUT: ${strongOut.map(describe).join(" · ")}.` : "",
        "This is context, not a signal — nothing to do. Strong sector leadership often hints at how SPY/SPX behaves the rest of the day.",
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
          .map(symbol => { const snap = leaderSnaps[symbol]; return snap?.dailyBar?.c && snap.prevDailyBar?.c ? { symbol, move: (snap.dailyBar.c / snap.prevDailyBar.c - 1) * 100 } : null; })
          .filter((entry): entry is { symbol: string; move: number } => entry != null)
          .sort((a, b) => (read.direction === "in" ? b.move - a.move : a.move - b.move))
          .slice(0, 3);
        if (moves.length) leadersLine = ` Big names ${read.direction === "in" ? "leading" : "falling"}: ${moves.map(entry => `${entry.symbol} ${pct(entry.move)}`).join(", ")}.`;
      }
      await createAlert({
        userId, eventKey, severity: "info",
        title: `Money is ${read.direction === "in" ? "flowing into" : "leaving"} ${read.label}`,
        body: `The ${read.label} group (${read.etf}) is ${read.direction === "in" ? "up" : "down"} ${pct(read.changePct).replace("+", "")} today while the overall market is at ${pct(spyChange)}, on ${read.relVolume.toFixed(1)}x its normal trading volume — that combination usually means real money rotating ${read.direction === "in" ? "in" : "out"}.${leadersLine} Nothing to do — information only.`,
        metadata: { kind: "sector_rotation", ...read },
      });
      fired.push(read.etf);
    });
  }

  return { fired, errors };
}

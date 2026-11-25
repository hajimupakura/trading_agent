import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { runCausalCorpus } from "./causal-corpus";

// DB-queued research fetches (2026-11-23). Historical replay work needs Alpaca data,
// but the market-data keys are sensitive-locked on Vercel and unusable from a local
// machine. This queue closes the loop without exposing anything: a request row is
// inserted into research_requests (via the Supabase MCP), the every-minute monitor
// cron executes ONE pending request per tick server-side where the keys live, and
// the result lands back in the row. Read-only market data only — no handler here may
// ever place orders or mutate trading state.

const DATA_BASE = "https://data.alpaca.markets";
const TIME_BUDGET_MS = 25_000;
const MAX_RESULT_BYTES = 6_000_000; // jsonb comfort zone; requester splits bigger asks

type OptionBar = { t: string; o: number; h: number; l: number; c: number; v: number; n?: number; vw?: number };

async function fetchOptionBars(params: Record<string, unknown>, deadline: number): Promise<Record<string, OptionBar[]>> {
  const symbols = Array.isArray(params.symbols) ? params.symbols.map(String).slice(0, 20) : [];
  if (!symbols.length) throw new Error("option-bars: params.symbols required");
  const headers = { "APCA-API-KEY-ID": process.env.ALPACA_API_KEY_ID ?? "", "APCA-API-SECRET-KEY": process.env.ALPACA_API_SECRET_KEY ?? "" };
  const bars: Record<string, OptionBar[]> = {};
  let pageToken: string | undefined; let pages = 0;
  do {
    if (Date.now() > deadline) throw new Error("option-bars: time budget exhausted mid-pagination — split the request");
    const url = new URL(`${DATA_BASE}/v1beta1/options/bars`);
    url.searchParams.set("symbols", symbols.join(","));
    url.searchParams.set("timeframe", String(params.timeframe ?? "1Min"));
    if (params.start) url.searchParams.set("start", String(params.start));
    if (params.end) url.searchParams.set("end", String(params.end));
    url.searchParams.set("limit", "1000");
    if (pageToken) url.searchParams.set("page_token", pageToken);
    const response = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`option-bars: Alpaca ${response.status} ${(await response.text()).slice(0, 200)}`);
    const payload = await response.json() as { bars?: Record<string, OptionBar[]>; next_page_token?: string | null };
    for (const [symbol, rows] of Object.entries(payload.bars ?? {})) bars[symbol] = [...(bars[symbol] ?? []), ...rows];
    pageToken = payload.next_page_token ?? undefined;
  } while (pageToken && ++pages < 20);
  return bars;
}

async function fetchStockBars(params: Record<string, unknown>, deadline: number): Promise<Record<string, OptionBar[]>> {
  const symbols = Array.isArray(params.symbols) ? params.symbols.map(String).slice(0, 10) : [];
  if (!symbols.length) throw new Error("stock-bars: params.symbols required");
  const headers = { "APCA-API-KEY-ID": process.env.ALPACA_API_KEY_ID ?? "", "APCA-API-SECRET-KEY": process.env.ALPACA_API_SECRET_KEY ?? "" };
  const bars: Record<string, OptionBar[]> = {};
  for (const symbol of symbols) {
    let pageToken: string | undefined; let pages = 0;
    do {
      if (Date.now() > deadline) throw new Error("stock-bars: time budget exhausted — split the request");
      const url = new URL(`${DATA_BASE}/v2/stocks/${encodeURIComponent(symbol)}/bars`);
      url.searchParams.set("timeframe", String(params.timeframe ?? "1Min"));
      url.searchParams.set("feed", String(params.feed ?? (process.env.ALPACA_DATA_PLAN === "paid" ? "sip" : "iex")));
      url.searchParams.set("adjustment", "all"); url.searchParams.set("sort", "asc"); url.searchParams.set("limit", "10000");
      if (params.start) url.searchParams.set("start", String(params.start));
      if (params.end) url.searchParams.set("end", String(params.end));
      if (pageToken) url.searchParams.set("page_token", pageToken);
      const response = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`stock-bars: Alpaca ${response.status} for ${symbol} ${(await response.text()).slice(0, 200)}`);
      const payload = await response.json() as { bars?: OptionBar[]; next_page_token?: string | null };
      bars[symbol] = [...(bars[symbol] ?? []), ...(payload.bars ?? [])];
      pageToken = payload.next_page_token ?? undefined;
    } while (pageToken && ++pages < 10);
  }
  return bars;
}

// Historical news for retro-labeling fires (the Phase-3 catalyst study does not have
// to wait for live stamps to accumulate — Alpaca serves Benzinga history).
async function fetchNewsHistory(params: Record<string, unknown>, deadline: number): Promise<Array<{ id: string; headline: string; symbols: string[]; published_at: string }>> {
  const headers = { "APCA-API-KEY-ID": process.env.ALPACA_API_KEY_ID ?? "", "APCA-API-SECRET-KEY": process.env.ALPACA_API_SECRET_KEY ?? "" };
  const out: Array<{ id: string; headline: string; symbols: string[]; published_at: string }> = [];
  let pageToken: string | undefined; let pages = 0;
  do {
    if (Date.now() > deadline) throw new Error("news-history: time budget exhausted — narrow the window");
    const url = new URL("https://data.alpaca.markets/v1beta1/news");
    if (Array.isArray(params.symbols) && params.symbols.length) url.searchParams.set("symbols", params.symbols.map(String).slice(0, 30).join(","));
    if (params.start) url.searchParams.set("start", String(params.start));
    if (params.end) url.searchParams.set("end", String(params.end));
    url.searchParams.set("limit", "50"); url.searchParams.set("sort", "asc");
    if (pageToken) url.searchParams.set("page_token", pageToken);
    const response = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`news-history: Alpaca ${response.status}`);
    const payload = await response.json() as { news?: Array<{ id: number | string; headline?: string; symbols?: string[]; created_at?: string }>; next_page_token?: string | null };
    for (const item of payload.news ?? []) if (item.id != null && item.headline) out.push({ id: String(item.id), headline: String(item.headline).slice(0, 300), symbols: (item.symbols ?? []).map(String), published_at: item.created_at ?? "" });
    pageToken = payload.next_page_token ?? undefined;
  } while (pageToken && ++pages < 40);
  return out;
}

// Historical pullback scan (user call 2026-11-23: "use the data we already have"):
// no fire records needed — each day's strongest 30-minute surge per direction is the
// event, graded with the SAME gradePullback that stamps live fires. Returns only the
// per-event summaries, so months of bars never leave the server.
async function runPullbackScan(params: Record<string, unknown>, deadline: number): Promise<Array<Record<string, unknown>>> {
  const { gradePullback } = await import("@/lib/options/pullback-grade");
  const symbol = String(params.symbol ?? "");
  if (!symbol) throw new Error("pullback-scan: params.symbol required");
  const minLegPct = Number(params.minLegPct ?? 0.8) / 100;
  const headers = { "APCA-API-KEY-ID": process.env.ALPACA_API_KEY_ID ?? "", "APCA-API-SECRET-KEY": process.env.ALPACA_API_SECRET_KEY ?? "" };
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const byDay = new Map<string, Array<{ min: number; c: number; v: number; vw: number }>>();
  let pageToken: string | undefined; let pages = 0;
  do {
    if (Date.now() > deadline) throw new Error("pullback-scan: time budget exhausted — narrow the window");
    const url = new URL(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/bars`);
    url.searchParams.set("timeframe", "1Min"); url.searchParams.set("feed", process.env.ALPACA_DATA_PLAN === "paid" ? "sip" : "iex");
    // adjustment 'raw' lets pre-split windows report the PRICES THAT ACTUALLY TRADED,
    // so option strikes built from spot match the era's real contracts (SMCI early
    // 2024). Only valid for windows containing no split; default stays 'all'.
    url.searchParams.set("adjustment", String(params.adjustment ?? "all")); url.searchParams.set("sort", "asc"); url.searchParams.set("limit", "10000");
    if (params.start) url.searchParams.set("start", String(params.start));
    if (params.end) url.searchParams.set("end", String(params.end));
    if (pageToken) url.searchParams.set("page_token", pageToken);
    const response = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`pullback-scan: Alpaca ${response.status} for ${symbol}`);
    const payload = await response.json() as { bars?: Array<{ t: string; c: number; v: number; vw?: number }>; next_page_token?: string | null };
    for (const bar of payload.bars ?? []) {
      const parts = Object.fromEntries(formatter.formatToParts(new Date(bar.t)).map(part => [part.type, part.value]));
      const min = Number(parts.hour) * 60 + Number(parts.minute);
      if (min < 570 || min > 960) continue;
      const day = `${parts.year}-${parts.month}-${parts.day}`;
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day)!.push({ min, c: Number(bar.c), v: Number(bar.v) || 0, vw: Number(bar.vw ?? bar.c) });
    }
    pageToken = payload.next_page_token ?? undefined;
  } while (pageToken && ++pages < 12);
  const events: Array<Record<string, unknown>> = [];
  for (const [day, bars] of byDay) {
    if (bars.length < 120) continue; // holiday stub or thin tape
    for (const dir of [1, -1] as const) {
      // The day's strongest 30-minute move in this direction is the "fire".
      let best = { move: 0, index: 0 };
      for (let i = 0; i + 30 < bars.length; i++) {
        const move = dir * (bars[i + 30].c - bars[i].c) / bars[i].c;
        if (move > best.move) best = { move, index: i };
      }
      if (best.move < minLegPct) continue;
      const grade = gradePullback(bars, bars[best.index].min, dir);
      if (grade.pullback === true) events.push({ sym: symbol, day, dir, fireMin: bars[best.index].min, spot: bars[best.index].c, ...grade });
    }
  }
  return events;
}

// ML corpus day-builder (2026-11-23): for one trading day's surge events, pick the
// first-OTM same-day-expiry contract from the spot at fire time (strike increment
// inferred from price, with a doubled-increment alternate in case the guess is off),
// fetch the real trade prints, and return compact premium paths. One request per
// day keeps results small; the overnight queue assembles the year.
async function fetchMlCorpusDay(params: Record<string, unknown>, deadline: number): Promise<Array<Record<string, unknown>>> {
  const day = String(params.day ?? ""); // YYYY-MM-DD (ET trading day = expiry)
  const entries = Array.isArray(params.entries) ? params.entries as Array<{ sym: string; dir: number; fireMin: number; spot: number }> : [];
  if (!day || !entries.length) throw new Error("ml-corpus: params.day and entries required");
  const yymmdd = day.slice(2).replaceAll("-", "");
  const incFor = (spot: number) => spot >= 500 ? 5 : spot >= 250 ? 2.5 : spot >= 100 ? 1 : 0.5;
  const occFor = (sym: string, dir: number, strike: number) => `${sym}${yymmdd}${dir > 0 ? "C" : "P"}${String(Math.round(strike * 1000)).padStart(8, "0")}`;
  const candidates = entries.flatMap(entry => {
    const inc = incFor(entry.spot); const alt = inc * 2.5 <= 5 ? inc * 2.5 : inc * 2;
    const pick = (step: number) => entry.dir > 0 ? Math.ceil(entry.spot / step) * step : Math.floor(entry.spot / step) * step;
    return [{ entry, occ: occFor(entry.sym, entry.dir, pick(inc)) }, { entry, occ: occFor(entry.sym, entry.dir, pick(alt)) }];
  });
  const headers = { "APCA-API-KEY-ID": process.env.ALPACA_API_KEY_ID ?? "", "APCA-API-SECRET-KEY": process.env.ALPACA_API_SECRET_KEY ?? "" };
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const paths = new Map<string, Array<[number, number]>>();
  for (let chunkStart = 0; chunkStart < candidates.length; chunkStart += 20) {
    if (Date.now() > deadline) throw new Error("ml-corpus: time budget exhausted — split the day");
    const chunk = candidates.slice(chunkStart, chunkStart + 20);
    let pageToken: string | undefined; let pages = 0;
    do {
      const url = new URL("https://data.alpaca.markets/v1beta1/options/bars");
      url.searchParams.set("symbols", chunk.map(c => c.occ).join(","));
      url.searchParams.set("timeframe", "1Min"); url.searchParams.set("limit", "1000"); url.searchParams.set("sort", "asc");
      url.searchParams.set("start", `${day}T14:00:00Z`); url.searchParams.set("end", `${day}T22:00:00Z`);
      if (pageToken) url.searchParams.set("page_token", pageToken);
      const response = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`ml-corpus: Alpaca ${response.status} on ${day}`);
      const payload = await response.json() as { bars?: Record<string, Array<{ t: string; c: number }>>; next_page_token?: string | null };
      for (const [occ, bars] of Object.entries(payload.bars ?? {})) {
        const list = paths.get(occ) ?? [];
        for (const bar of bars) {
          const parts = Object.fromEntries(formatter.formatToParts(new Date(bar.t)).map(part => [part.type, part.value]));
          list.push([Number(parts.hour) * 60 + Number(parts.minute), Number(Number(bar.c).toFixed(2))]);
        }
        paths.set(occ, list);
      }
      pageToken = payload.next_page_token ?? undefined;
    } while (pageToken && ++pages < 10);
  }
  const out: Array<Record<string, unknown>> = [];
  for (const entry of entries) {
    const mine = candidates.filter(c => c.entry === entry).map(c => ({ occ: c.occ, path: paths.get(c.occ) ?? [] }));
    const bestPick = mine.sort((a, b) => b.path.length - a.path.length)[0];
    if (!bestPick || bestPick.path.length < 30) continue; // no liquid same-day contract — skip honestly
    const path = bestPick.path.filter(([min]) => min >= entry.fireMin && min <= 915);
    const first = path[0];
    if (!first || first[1] <= 0.04) continue;
    out.push({ day, sym: entry.sym, dir: entry.dir, fireMin: entry.fireMin, occ: bestPick.occ, entryPrint: first[1], path });
  }
  return out;
}

// Swing corpus (user call 2026-11-23, the "patient OTM swarm" strategy): on strong
// momentum days, buy a 3-7 DTE Friday-expiry contract ~3-5% out of the money and
// hold THROUGH days — no stop, max loss = premium. This fetches each event's
// multi-day premium path so the distribution (win rate, monsters, losing streaks)
// is measured instead of admired. Path minutes encode day offset: min = off*1440+m.
async function fetchSwingCorpusDay(params: Record<string, unknown>, deadline: number): Promise<Array<Record<string, unknown>>> {
  const day = String(params.day ?? "");
  const entries = Array.isArray(params.entries) ? params.entries as Array<{ sym: string; dir: number; fireMin: number; spot: number }> : [];
  if (!day || !entries.length) throw new Error("ml-swing: params.day and entries required");
  // STRIKE LADDER (user call 2026-11-23: "few close to the money or many out of the
  // money?"): each event fetches FOUR moneyness levels — slightly ITM (-2%), near
  // the money (+1%), OTM (+4%), far OTM (+8%) — same expiry, so equal-dollar
  // allocations compare directly and an ML strike advisor has labels to learn from.
  const levels = Array.isArray(params.levels) ? (params.levels as number[]) : [-2, 1, 4, 8];
  const base = new Date(`${day}T12:00:00Z`);
  // Expiry mode: 'friday' (default, the 3-7 DTE patient swing) or 'nearest' (lottery
  // census, user call 2026-11-24: the 2-cent 50x repricings live on the NEAREST
  // expiries — try day+0/+1/+2 and keep whichever contract actually traded).
  const expiryMode = String(params.expiryMode ?? "friday");
  const expiryStrs: string[] = [];
  if (expiryMode === "nearest") {
    for (const add of [0, 1, 2]) {
      const candidate = new Date(base.getTime() + add * 86_400_000);
      const dow = candidate.getUTCDay();
      if (dow >= 1 && dow <= 5) expiryStrs.push(candidate.toISOString().slice(0, 10));
    }
  } else {
    const dow = base.getUTCDay(); // 1=Mon..5=Fri
    const toFriday = 5 - dow; const add = toFriday >= 3 ? toFriday : toFriday + 7;
    expiryStrs.push(new Date(base.getTime() + add * 86_400_000).toISOString().slice(0, 10));
  }
  const lastExpiry = expiryStrs[expiryStrs.length - 1];
  const incFor = (spot: number) => spot >= 500 ? 5 : spot >= 250 ? 2.5 : spot >= 100 ? 1 : 0.5;
  const occFor = (sym: string, dir: number, strike: number, yymmdd: string) => `${sym}${yymmdd}${dir > 0 ? "C" : "P"}${String(Math.round(strike * 1000)).padStart(8, "0")}`;
  const candidates = entries.flatMap(entry => levels.flatMap(lvl => expiryStrs.flatMap(expiryStr => {
    const yymmdd = expiryStr.slice(2).replaceAll("-", "");
    const inc = incFor(entry.spot); const alt = inc * 2.5 <= 5 ? inc * 2.5 : inc * 2;
    const target = entry.spot * (1 + (lvl / 100) * entry.dir);
    const pick = (step: number) => entry.dir > 0 ? Math.ceil(target / step) * step : Math.floor(target / step) * step;
    return [{ entry, lvl, expiryStr, occ: occFor(entry.sym, entry.dir, pick(inc), yymmdd) }, { entry, lvl, expiryStr, occ: occFor(entry.sym, entry.dir, pick(alt), yymmdd) }];
  })));
  const headers = { "APCA-API-KEY-ID": process.env.ALPACA_API_KEY_ID ?? "", "APCA-API-SECRET-KEY": process.env.ALPACA_API_SECRET_KEY ?? "" };
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const dayMs = 86_400_000; const baseUtc = Date.parse(`${day}T00:00:00Z`);
  const paths = new Map<string, Array<[number, number]>>();
  for (let chunkStart = 0; chunkStart < candidates.length; chunkStart += 20) {
    if (Date.now() > deadline) throw new Error("ml-swing: time budget exhausted — split the day");
    const chunk = candidates.slice(chunkStart, chunkStart + 20);
    let pageToken: string | undefined; let pages = 0;
    do {
      const url = new URL("https://data.alpaca.markets/v1beta1/options/bars");
      url.searchParams.set("symbols", chunk.map(c => c.occ).join(","));
      url.searchParams.set("timeframe", "5Min"); url.searchParams.set("limit", "1000"); url.searchParams.set("sort", "asc");
      url.searchParams.set("start", `${day}T14:00:00Z`); url.searchParams.set("end", `${lastExpiry}T22:00:00Z`);
      if (pageToken) url.searchParams.set("page_token", pageToken);
      const response = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`ml-swing: Alpaca ${response.status} on ${day}`);
      const payload = await response.json() as { bars?: Record<string, Array<{ t: string; c: number }>>; next_page_token?: string | null };
      for (const [occ, bars] of Object.entries(payload.bars ?? {})) {
        const list = paths.get(occ) ?? [];
        for (const bar of bars) {
          const parts = Object.fromEntries(formatter.formatToParts(new Date(bar.t)).map(part => [part.type, part.value]));
          const minute = Number(parts.hour) * 60 + Number(parts.minute);
          if (minute < 570 || minute > 960) continue;
          const offset = Math.max(0, Math.round((Date.parse(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`) - baseUtc) / dayMs));
          list.push([offset * 1440 + minute, Number(Number(bar.c).toFixed(2))]);
        }
        paths.set(occ, list);
      }
      pageToken = payload.next_page_token ?? undefined;
    } while (pageToken && ++pages < 10);
  }
  const out: Array<Record<string, unknown>> = [];
  for (const entry of entries) {
    for (const lvl of levels) {
      const mine = candidates.filter(c => c.entry === entry && c.lvl === lvl).map(c => ({ occ: c.occ, path: paths.get(c.occ) ?? [] }));
      const bestPick = mine.sort((a, b) => b.path.length - a.path.length)[0];
      if (!bestPick || bestPick.path.length < 30) continue;
      const path = bestPick.path.filter(([min]) => min >= entry.fireMin);
      const first = path[0];
      if (!first || first[1] <= 0.02) continue;
      out.push({ day, sym: entry.sym, dir: entry.dir, lvl, fireMin: entry.fireMin, occ: bestPick.occ, entryPrint: first[1], path });
    }
  }
  return out;
}

// ML corpus export: bundle every done ml-corpus result into one CSV in Supabase
// Storage (public research bucket) so training can download it without any secret.
async function runMlExport(params: Record<string, unknown> = {}, deadline: number = Date.now() + TIME_BUDGET_MS): Promise<{ url: string; positions: number; rows: number }> {
  const sourceKind = String(params.sourceKind ?? "ml-corpus");
  // Optional day-range window (on params->>'day') so oversized corpora export in parts.
  const dayGte = typeof params.dayGte === "string" ? params.dayGte : null;
  const dayLt = typeof params.dayLt === "string" ? params.dayLt : null;
  const gen = typeof params.gen === "string" ? params.gen : null;
  const admin = createAdminClient();
  // STOCK-BARS export (2026-11-24, the live-context backfill): results are
  // Record<sym, bars>; rows become day,sym,min(ET),close,vol,vw — session minutes
  // only (VWAP/volume state is a session concept). Windowing keys on params->>start.
  if (sourceKind === "stock-bars") {
    const lines = ["day,sym,min,open,high,low,close,vol,vw"];
    const et = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" });
    const etMin = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    const pageSize = 10; let from = 0; let bars = 0;
    for (;;) {
      let query = admin.from("research_requests").select("result").eq("kind", "stock-bars").eq("status", "done").is("params->>probe", null);
      if (dayGte) query = query.gte("params->>start", dayGte);
      if (dayLt) query = query.lt("params->>start", dayLt);
      if (Date.now() > deadline) throw new Error("ml-export: time budget exhausted — narrow the day window");
      const { data, error } = await query.order("id").range(from, from + pageSize - 1);
      if (error) throw new Error(`ml-export read: ${error.message}`);
      if (!data?.length) break;
      for (const row of data) {
        for (const [sym, series] of Object.entries((row.result as Record<string, Array<{ t: string; o?: number; h?: number; l?: number; c: number; v: number; vw?: number }>>) ?? {})) {
          for (const bar of series ?? []) {
            const when = new Date(bar.t);
            const parts = Object.fromEntries(etMin.formatToParts(when).map(part => [part.type, part.value]));
            const minute = Number(parts.hour) * 60 + Number(parts.minute);
            if (minute < 570 || minute > 960) continue; // session only
            bars++;
            lines.push(`${et.format(when)},${sym},${minute},${bar.o ?? bar.c},${bar.h ?? bar.c},${bar.l ?? bar.c},${bar.c},${bar.v},${bar.vw ?? ""}`);
          }
        }
      }
      if (data.length < pageSize) break;
      from += pageSize;
    }
    const name = `stock-bars${dayGte ? `-from-${dayGte.slice(0, 10)}` : ""}${dayLt ? `-to-${dayLt.slice(0, 10)}` : ""}-${Date.now()}.csv`;
    const { error: uploadError } = await admin.storage.from("research").upload(name, lines.join("\n"), { contentType: "text/csv", upsert: true });
    if (uploadError) throw new Error(`ml-export upload: ${uploadError.message}`);
    const { data: urlData } = admin.storage.from("research").getPublicUrl(name);
    return { url: urlData.publicUrl, positions: 0, rows: bars };
  }
  // ml-causal positions carry setup + spot and long two-session tapes: one line per
  // position with the path packed as min:price|min:price keeps a month under ~10 MB.
  const packed = sourceKind === "ml-causal";
  const lines: string[] = [packed ? "day,sym,dir,lvl,occ,fireMin,entryPrint,setup,spot,path" : "day,sym,dir,lvl,occ,fireMin,entryPrint,min,price"];
  let positions = 0;
  const pageSize = 50; let from = 0;
  for (;;) {
    // Order by id: bulk-queued rows share created_at, which made page boundaries
    // non-deterministic (rows dropped/duplicated across pages).
    let query = admin.from("research_requests").select("result").eq("kind", sourceKind).eq("status", "done");
    // Generation tag (2026-11-25): the first corpus entered at hindsight-chosen minutes;
    // rebuilt rows carry params.gen so the two never mix in one export.
    query = gen ? query.eq("params->>gen", gen) : query.is("params->>gen", null);
    if (dayGte) query = query.gte("params->>day", dayGte);
    if (dayLt) query = query.lt("params->>day", dayLt);
    if (Date.now() > deadline) throw new Error("ml-export: time budget exhausted — narrow the day window");
    const { data, error } = await query.order("id").range(from, from + pageSize - 1);
    if (error) throw new Error(`ml-export read: ${error.message}`);
    if (!data?.length) break;
    for (const row of data) {
      for (const position of (row.result as Array<{ day: string; sym: string; dir: number; lvl?: number; occ: string; fireMin: number; entryPrint: number; path: Array<[number, number]> }> ?? [])) {
        positions++;
        if (packed) { const extra = position as unknown as { setup?: string; spot?: number }; lines.push(`${position.day},${position.sym},${position.dir},${position.lvl ?? 0},${position.occ},${position.fireMin},${position.entryPrint},${extra.setup ?? ""},${extra.spot ?? ""},${(position.path ?? []).map(([min, price]) => `${min}:${price}`).join("|")}`); continue; }
        for (const [min, price] of position.path ?? []) lines.push(`${position.day},${position.sym},${position.dir},${position.lvl ?? 0},${position.occ},${position.fireMin},${position.entryPrint},${min},${price}`);
      }
    }
    if (data.length < pageSize) break;
    from += pageSize;
  }
  const body = lines.join("\n");
  const name = `${sourceKind}${gen ? `-${gen}` : ""}${dayGte ? `-from-${dayGte}` : ""}${dayLt ? `-to-${dayLt}` : ""}-${Date.now()}.csv`;
  const { error: uploadError } = await admin.storage.from("research").upload(name, body, { contentType: "text/csv", upsert: true });
  if (uploadError) throw new Error(`ml-export upload: ${uploadError.message}`);
  const { data: urlData } = admin.storage.from("research").getPublicUrl(name);
  return { url: urlData.publicUrl, positions, rows: lines.length - 1 };
}

// Kinds that read or build megabytes (bundled exports, the causal replay). In session
// they wait: on 2026-11-25 quarter-wide exports queued at 10:17 ET ran the monitor
// tick into its 60s limit 19 times in 40 minutes, killing the blind-spot checks and
// job-health heartbeat that run after this queue. Off-hours, or with
// research_full_throttle on, they run normally.
const HEAVY_KINDS = ["ml-export", "ml-causal"];

export async function runResearchQueue(tickStartedAt: number = Date.now()): Promise<{ ran: string | null; error?: string }> {
  // The tick owns 60s in total; research may only use what is left of the first 48s,
  // and never starts with less than 12s in hand.
  const hardStop = tickStartedAt + 48_000;
  if (hardStop - Date.now() < 12_000) return { ran: null, error: "tick budget spent before research" };
  // A row left 'running' means its function died mid-request (timeout). Say so instead
  // of leaving it to look in-flight forever.
  await createAdminClient().from("research_requests").update({ status: "error", error: "stalled: the cron tick ended before this request finished — split or narrow it", updated_at: new Date().toISOString() })
    .eq("status", "running").lt("updated_at", new Date(Date.now() - 3 * 60_000).toISOString());
  // Off-hours the monitor tick is light and the queue is the only customer, so it
  // may chew a BATCH per tick (bulk corpus nights finish by morning instead of in
  // days). During the trading session it stays strictly one request per tick so
  // research can never crowd the live jobs (2026-11-23).
  const { minutes, weekday } = (() => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" }).formatToParts(new Date()).map(part => [part.type, part.value]));
    return { minutes: Number(parts.hour) * 60 + Number(parts.minute), weekday: String(parts.weekday) };
  })();
  const inSession = !["Sat", "Sun"].includes(weekday) && minutes >= 565 && minutes <= 975;
  // FULL-THROTTLE override (user call 2026-11-24 "we are done trading today — go full
  // throttle"): research_full_throttle on the control row lifts the in-session
  // one-per-tick limit so bulk backfills batch like off-hours. Flip it back off with:
  //   update position_manager_control set research_full_throttle=false where id=true;
  const { data: control } = await createAdminClient().from("position_manager_control").select("research_full_throttle").eq("id", true).maybeSingle();
  const fullThrottle = Boolean((control as { research_full_throttle?: boolean } | null)?.research_full_throttle);
  const lightOnly = inSession && !fullThrottle;
  const batchDeadline = Math.min(hardStop, Date.now() + (lightOnly ? 0 : 34_000)); // 0 extra = single pass in session
  let last: { ran: string | null; error?: string } = { ran: null };
  for (;;) {
    last = await runOneResearchRequest(hardStop, lightOnly);
    if (last.ran == null) return last; // queue empty
    if (Date.now() > batchDeadline - 5_000) return last; // not enough budget for another
  }
}

async function runOneResearchRequest(hardStop: number, lightOnly: boolean): Promise<{ ran: string | null; error?: string }> {
  const admin = createAdminClient();
  let pending = admin.from("research_requests").select("id,kind,params").eq("status", "pending");
  if (lightOnly) pending = pending.not("kind", "in", `(${HEAVY_KINDS.join(",")})`);
  const { data: request } = await pending.order("created_at", { ascending: true }).limit(1).maybeSingle();
  if (!request) return { ran: null };
  // Optimistic claim: only proceed if we flipped pending→running (cron overlap safety).
  const { data: claimed } = await admin.from("research_requests").update({ status: "running", updated_at: new Date().toISOString() }).eq("id", request.id).eq("status", "pending").select("id");
  if (!claimed?.length) return { ran: null };
  const deadline = Math.min(Date.now() + TIME_BUDGET_MS, hardStop);
  try {
    const params = (request.params ?? {}) as Record<string, unknown>;
    let result: unknown;
    if (request.kind === "option-bars") result = await fetchOptionBars(params, deadline);
    else if (request.kind === "stock-bars") result = await fetchStockBars(params, deadline);
    else if (request.kind === "news-history") result = await fetchNewsHistory(params, deadline);
    else if (request.kind === "pullback-scan") result = await runPullbackScan(params, deadline);
    else if (request.kind === "ml-corpus") result = await fetchMlCorpusDay(params, deadline);
    else if (request.kind === "ml-swing") result = await fetchSwingCorpusDay(params, deadline);
    else if (request.kind === "ml-lottery") result = await fetchSwingCorpusDay({ ...params, expiryMode: "nearest", levels: Array.isArray(params.levels) ? params.levels : [6, 10, 15] }, deadline);
    else if (request.kind === "ml-causal") result = await runCausalCorpus(params, deadline);
    else if (request.kind === "ml-export") result = await runMlExport(params, deadline);
    else throw new Error(`unknown research kind: ${request.kind}`);
    const encoded = JSON.stringify(result);
    if (encoded.length > MAX_RESULT_BYTES) throw new Error(`result too large (${encoded.length}b) — split the request`);
    await admin.from("research_requests").update({ status: "done", result, error: null, updated_at: new Date().toISOString() }).eq("id", request.id);
    return { ran: request.id as string };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await admin.from("research_requests").update({ status: "error", error: message.slice(0, 500), updated_at: new Date().toISOString() }).eq("id", request.id);
    return { ran: request.id as string, error: message };
  }
}

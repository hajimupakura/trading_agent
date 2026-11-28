import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAlert } from "@/lib/alerts/server";
import { getPaperTradingState, submitPaperOptionOrder } from "./paper";
import { PAPER_RULES, computePositionSize, entryCooldownActive, invalidAtEntry, validatePaperEntry } from "./risk";
import { STOCK_FEED } from "./data-plan";
import { getMarketCalendar } from "@/lib/market/calendar-server";
import { loadRiskSettings } from "@/lib/settings/risk-settings";
import { activeEarningsGuard } from "@/lib/options/earnings-guard";
import { recordShadowSkip } from "@/lib/options/shadow-ledger";
import type { CommandCenter } from "@/lib/options/types";

// Fully autonomous PAPER entries — SPY plus every watchlist ticker (SPX excluded:
// Alpaca has no index options). Runs from the every-minute cron right after each
// refresh: if a fresh engine signal exists and EVERY deterministic gate passes
// (window, cooldown, sizing, daily loss, trades/day, one position, economic guard,
// kill switch — all GLOBAL across tickers), the order submits itself. Purpose:
// measure the strategies cleanly — a paper record built without waiting on a human
// is the evidence the promotion ladder needs.
// Off by default (settings.autoEntriesEnabled). Every entry telegrams instantly.

async function entriesToday(userId: string) {
  const now = new Date();
  const dateParts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now).map(part => [part.type, part.value]));
  const midnightGuess = Date.UTC(Number(dateParts.year), Number(dateParts.month) - 1, Number(dateParts.day));
  const localAtGuess = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(midnightGuess)).map(part => [part.type, part.value]));
  const representedAsUtc = Date.UTC(Number(localAtGuess.year), Number(localAtGuess.month) - 1, Number(localAtGuess.day), Number(localAtGuess.hour), Number(localAtGuess.minute), Number(localAtGuess.second));
  const since = new Date(midnightGuess - (representedAsUtc - midnightGuess)).toISOString();
  // Sleeve-aware (2026-11-23): index (SPX/SPY) and equity entries count separately.
  // Convexity-swarm rows (2026-11-24) belong to the THIRD sleeve and count toward
  // neither — without this filter one swarm would silently eat an equity slot.
  const { data, error } = await createAdminClient().from("paper_trade_orders").select("underlying,created_at,risk_snapshot").eq("user_id", userId).eq("action", "buy_to_open").gte("created_at", since).neq("status", "rejected");
  if (error) throw new Error(`Trade journal unavailable: ${error.message}`);
  // Explore-mode entries taken OUTSIDE the old budget (2026-11-25) are excluded too, so
  // the budget keeps counting exactly what it would have allowed on its own.
  const rows = (data ?? []).filter(row => { const snap = row.risk_snapshot as { strategy?: string; outsideBudget?: boolean } | null; return snap?.strategy !== "convexity-swarm" && snap?.outsideBudget !== true; });
  const index = rows.filter(row => ["SPX", "SPY"].includes(String(row.underlying))).length;
  // Morning sub-count for the equity sleeve's budget: entries before 12:30 ET.
  const morningCutoff = new Date(new Date(since).getTime() + 750 * 60_000).toISOString();
  const equityRows = rows.filter(row => !["SPX", "SPY"].includes(String(row.underlying)));
  return { index, equity: equityRows.length, equityMorning: equityRows.filter(row => String(row.created_at) < morningCutoff).length };
}

// Housekeeping skips — the setup is already expressed (holding / duplicate id) or
// the lane deliberately doesn't cover the symbol. EVERY skip of a fresh qualified
// fire is recorded and displayed (user call, 2026-11-19: "I want to see those
// skipped rows"); this list only decides which ones ALSO page Telegram, so a held
// position doesn't ping the phone every hour while the setup keeps re-firing.
const SILENT_SKIPS = ["paper lane is SPX-only", "stale signal", "signal already traded", "already holding this contract", "already traded this name this side today", "opening hold", "scalp lane off", "morning budget"];

export async function runAutoEntry(snapshot: CommandCenter | null, underlying: string): Promise<{ entered: string | null; skipped?: string }> {
  // FAIL LOUD (2026-11-23): a throw inside the gate chain used to escape to the cron
  // route's catch — PAST shadow recording — so the 13:24 SPX 7270C fire vanished with
  // no order, no shadow row, no reason. An exception in the entry path is an incident
  // (the rh lane has paged on this since 8/11); now it records like any skip AND pages.
  const result = await evaluateAutoEntry(snapshot, underlying).catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const { data: owner } = await createAdminClient().from("profiles").select("id").limit(1).maybeSingle();
    if (owner && snapshot?.signal && ["enter_call", "enter_put"].includes(snapshot.signal.action)) await createAlert({
      userId: owner.id, eventKey: `paper-entry-error-${snapshot.signal.id}`, severity: "critical",
      title: `Paper entry lane hit an unexpected error on a live ${underlying} signal`,
      body: `A qualified ${underlying} fire could not be processed: ${message.slice(0, 250)}. No order was placed; the miss is shadow-tracked. If this repeats, the paper lane needs attention.`,
      metadata: { kind: "paper_entry_error", underlying, signalId: snapshot.signal.id, error: message },
    }).catch(() => undefined);
    return { entered: null, skipped: `error: ${message.slice(0, 160)}` };
  });
  const signal = snapshot?.signal;
  if (result.skipped && signal?.contract && ["enter_call", "enter_put"].includes(signal.action)
    && Date.now() - signal.generatedAt <= 120_000) {
    try {
      // recordShadowSkip dedupes to one row per action+setup per hour; the Telegram
      // alert rides the same gate so a persisting setup pings once, not every minute.
      const { recorded } = await recordShadowSkip({ signal, underlying, skipReason: result.skipped });
      if (recorded && !SILENT_SKIPS.some(prefix => result.skipped!.startsWith(prefix))) {
        const { data: owner } = await createAdminClient().from("profiles").select("id").limit(1).maybeSingle();
        if (owner) {
          const side = signal.action === "enter_call" ? "CALL" : "PUT";
          await createAlert({
            userId: owner.id, signalId: signal.id, eventKey: `signal-skip-${underlying}-${signal.action}-${signal.generatedAt}`, severity: "warning",
            title: `SIGNAL fired, NOT traded: ${underlying} ${side} (${signal.setup.replaceAll("_", " ")})`,
            body: `The engine qualified ${signal.contract.ticker.replace("O:", "")} asking $${signal.contract.ask.toFixed(2)} with ${underlying} at ${signal.market.price.toFixed(2)}, but the paper lane skipped it: ${result.skipped}. ${signal.reasons[0] ?? ""} The miss is now shadow-tracked — the dashboard's Signal Feed shows what it would have done.`,
            metadata: { kind: "signal_skip", underlying, contractTicker: signal.contract.ticker, ask: signal.contract.ask, skipReason: result.skipped },
          });
        }
      }
    } catch (shadowError) { console.error("shadow skip recording failed", shadowError instanceof Error ? shadowError.message : shadowError); }
  }
  return result;
}

async function evaluateAutoEntry(snapshot: CommandCenter | null, underlying: string): Promise<{ entered: string | null; skipped?: string }> {
  // FULL-WATCHLIST SPEC (user call, 2026-11-23, reversing the 11-19 SPX-only rule for
  // PAPER only): "trade all the stocks in my watchlist — $500 max per ticker, 5
  // tickers a day." Which names may trade is config now (settings.allowedUnderlyings
  // via validatePaperEntry), the $500/ticker rides maxTradeDebit, 5/day rides
  // maxTradesPerDay, 5 concurrent rides maxOpenPositions. The ledger answers "would
  // this make money" with a measured record before any real dollar follows — two hot
  // days (one of them a crash tape) are not evidence, the next month is.
  // SPX keeps its PAIR structure (quality + convex kicker) below.
  const signal = snapshot?.signal;
  let contract = signal?.contract;
  if (!signal || !contract || !["enter_call", "enter_put"].includes(signal.action)) return { entered: null };
  // Freshness: act only on signals generated within the last two minutes.
  if (Date.now() - signal.generatedAt > 120_000) return { entered: null, skipped: "stale signal" };
  // OPENING HOLD (user call 2026-11-25): no new paper entries before 9:45 ET. History,
  // with the cutoff chosen on validation months and confirmed on two unseen windows
  // (7/day cap, on top of the entry gate): Jun-Sep $101k/77% win vs $90k/65% taking
  // opening fires; Oct-Nov holdout $58k/80% vs $54k/73%. The opening's few monsters
  // don't pay for the slots its many early stop-outs consume. Skips are shadow-tracked;
  // names that fire again after 9:45 remain fully eligible.
  {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map(part => [part.type, part.value]));
    if (Number(p.hour) * 60 + Number(p.minute) < 585) return { entered: null, skipped: "opening hold: no new entries before 9:45 ET" };
  }
  const admin = createAdminClient();
  const { data: owner } = await admin.from("profiles").select("id").limit(1).maybeSingle();
  if (!owner) return { entered: null };
  const settings = await loadRiskSettings(owner.id);
  if (!settings.autoEntriesEnabled || !settings.paperTradingEnabled) return { entered: null, skipped: "autonomy off" };
  if (signal.setup === "scalp_reclaim" && !settings.scalpEntriesEnabled) return { entered: null, skipped: "scalp lane off" };
  // One order per signal, ever.
  const { data: existing } = await admin.from("paper_trade_orders").select("id").eq("signal_id", signal.id).limit(1).maybeSingle();
  if (existing) return { entered: null, skipped: "signal already traded" };
  const { data: control } = await admin.from("position_manager_control").select("kill_switch,paper_explore_all").eq("id", true).single();
  if (control?.kill_switch) return { entered: null, skipped: "kill switch" };
  // EXPLORE MODE (user call 2026-11-25: "does it make sense to cap the number of trades
  // on the paper account — we are missing some real bangers"). Paper losses are free and
  // missing data is not: with the flag on, the EQUITY sleeve takes every first signal per
  // name per side per day. The count budgets below (cross-name cooldown, morning budget,
  // last-slots gate, trades/day, concurrent cap, daily-loss stop) stop being vetoes and
  // become a TAG — risk_snapshot.outsideBudget + budgetReason — so the capped record
  // (the real-money rehearsal) is still there, alongside the full picture. Their own
  // justification came from the hindsight-entry corpus and is unvalidated. Everything
  // that is not a count budget still applies: opening hold, entry gate, one entry per
  // name per side, earnings guard, $ per-trade cap, buying power, entry window, kill
  // switch. The index sleeve (SPX/SPY) and real money are untouched.
  const exploreAll = Boolean((control as { paper_explore_all?: boolean } | null)?.paper_explore_all) && !["SPX", "SPY"].includes(underlying);
  let budgetReason: string | null = null;
  // ENTRY-QUALITY GATE (2026-11-24, walk-forward 54%->81% win on unseen months): the
  // scorer estimates P(this fire never reaches +10%) from fire-time facts and skips
  // the historically-dying profile. Visible skip — shadow-tracked, so the ledger
  // keeps score on every trade the gate refuses.
  {
    const { scoreEntry } = await import("@/lib/ml/entry-gate");
    const etParts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map(part => [part.type, part.value]));
    const verdict = scoreEntry({
      bars: ((snapshot?.market as { bars?: Array<{ close: number }> })?.bars ?? []),
      etMinutes: Number(etParts.hour) * 60 + Number(etParts.minute),
      dir: signal.action === "enter_call" ? 1 : -1,
      isIndex: ["SPX", "SPY", "QQQ", "GLD", "SLV"].includes(underlying),
      dow: ["Mon", "Tue", "Wed", "Thu", "Fri"].indexOf(String(etParts.weekday)),
      premium: contract.ask,
    });
    if (verdict.skip) return { entered: null, skipped: `entry scorer: dying-trade profile (score ${verdict.prob.toFixed(4)} above ${verdict.threshold.toFixed(4)}${verdict.legPct != null ? `, 30-min leg ${verdict.legPct.toFixed(2)}%` : ", leg unknown"})` };
  }
  const [trading, tradesToday, { data: recentExits, error: recentExitsError }] = await Promise.all([
    getPaperTradingState(), entriesToday(owner.id),
    admin.from("paper_trade_orders").select("contract_ticker,risk_snapshot,updated_at").eq("user_id", owner.id).eq("action", "sell_to_close").gte("updated_at", new Date(Date.now() - PAPER_RULES.cooldownMinutes * 60_000).toISOString()),
  ]);
  // FAIL CLOSED (2026-08-18 doctrine): an unanswerable cooldown question means NO —
  // a transient query error must never read as "no recent exits, clear to enter".
  if (recentExitsError) return { entered: null, skipped: `cooldown data unavailable: ${recentExitsError.message}` };
  const cooldown = entryCooldownActive({ action: signal.action, recentExits: (recentExits ?? []).map(row => ({ contractTicker: String(row.contract_ticker), exitReason: (row.risk_snapshot as { exitReason?: string } | null)?.exitReason ?? null, at: String(row.updated_at) })) });
  // The cooldown is global across names (it exists to protect the trades/day budget);
  // same-name same-side re-entry is already barred below, so in explore mode it only tags.
  if (cooldown) { if (!exploreAll) return { entered: null, skipped: "cooldown" }; budgetReason ??= "cooldown after a same-side stop-out"; }
  const etMin = (() => { const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()); return Number(parts.find(part => part.type === "hour")?.value) * 60 + Number(parts.find(part => part.type === "minute")?.value); })();
  // MORNING-ONLY RULE REMOVED (user call, 2026-11-19): the 2026-08-27 cutoff was
  // measured on 10:00-10:59 CHASES of spent moves; on 11/19 it vetoed a FRESH
  // 11:55 AM opening-range breakdown (SPX 7275P, +~175% unbought). The engine's
  // 0.10-0.65 ATR extension gate is the anti-chase control now — it only qualifies
  // breakouts as they happen, at any hour. The configurable risk-settings window
  // (currently 9:30-14:45 ET in validatePaperEntry) remains the outer bound.
  const earningsBlock = await activeEarningsGuard(underlying, { swingEntry: etMin >= 930 });
  if (earningsBlock) return { entered: null, skipped: earningsBlock };
  // Never re-enter a contract already held: with maxOpenPositions > 1 the global cap
  // permits a second position, but doubling the SAME contract is unintended averaging.
  const pickTicker = contract.ticker;
  if (trading.positions.some(position => `O:${position.symbol}` === pickTicker)) return { entered: null, skipped: "already holding this contract" };
  // NOTE: event-day caution applies to the REAL-MONEY lane only — paper deliberately
  // trades unfiltered (its record measures the raw strategy, event days included).
  // TWO SLEEVES (user call, 2026-11-23: "give SPX and SPY their own budget of 2000 —
  // their own lane, and the rest their own"): the index sleeve runs $1,800 quality +
  // $200 SPX kicker (= the $2,000 budget), ONE position at a time (SPX and SPY are
  // the same market), 3 entries/day. The equity sleeve keeps the watchlist spec:
  // $500/ticker, 5/day, 5 concurrent (= the $2,500 budget). Positions and daily
  // counts are classified by OCC root so the sleeves can never consume each other's
  // slots: five equity entries leave the SPX lane fully armed, and vice versa.
  const isIndex = ["SPX", "SPY"].includes(underlying);
  const sleeveSettings = isIndex ? { ...settings, maxTradeDebit: 1800, maxOpenPositions: 1, maxTradesPerDay: 3 } : settings;
  const isIndexOcc = (symbol: string) => /^(SPXW|SPX|SPY)\d/.test(symbol.replace(/^O:/, ""));
  // Convexity-swarm positions (third sleeve, 3-7 DTE) share OCC roots with the equity
  // sleeve — exclude them so a live swarm never consumes an equity concurrency slot.
  const { data: convexityRows } = await admin.from("paper_trade_orders").select("contract_ticker").eq("action", "buy_to_open").eq("risk_snapshot->>strategy", "convexity-swarm").gte("created_at", new Date(Date.now() - 14 * 86_400_000).toISOString());
  const convexityTickers = new Set((convexityRows ?? []).map(row => String(row.contract_ticker)));
  // Outside-budget explore positions do not occupy the budget's concurrency slots either.
  const { data: outsideRows } = await admin.from("paper_trade_orders").select("contract_ticker").eq("action", "buy_to_open").eq("risk_snapshot->>outsideBudget", "true").gte("created_at", new Date(Date.now() - 14 * 86_400_000).toISOString());
  const outsideTickers = new Set((outsideRows ?? []).map(row => String(row.contract_ticker)));
  const sleevePositions = trading.positions.filter(position => isIndexOcc(String(position.symbol)) === isIndex && !convexityTickers.has(`O:${position.symbol}`) && !outsideTickers.has(`O:${position.symbol}`));
  const sleeveTradesToday = isIndex ? tradesToday.index : tradesToday.equity;
  // ONE ENTRY PER NAME PER SIDE PER DAY (2026-11-24, after NVDA fired twice in 5
  // minutes and the lane bought both strikes): the research corpus that validated
  // every rule records exactly ONE event per (day, symbol, direction) — a same-day
  // same-side re-entry is behavior the backtests never measured. Align live with
  // what was validated. Convexity swarms are exempt (their own lane, own budget).
  const sideChar = signal.action === "enter_call" ? "C" : "P";
  const { data: todaysSameName } = await admin.from("paper_trade_orders").select("contract_ticker")
    .eq("action", "buy_to_open").eq("underlying", underlying)
    .gte("created_at", `${new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date())}T00:00:00-05:00`)
    .neq("status", "rejected");
  const sameSideToday = (todaysSameName ?? []).some(row => {
    const ticker = String(row.contract_ticker);
    return !convexityTickers.has(ticker) && new RegExp(`\\d{6}${sideChar}\\d{8}$`).test(ticker);
  });
  if (sameSideToday) return { entered: null, skipped: "already traded this name this side today" };
  // AFTERNOON RESERVE (recalibrated same night, 2026-11-23): the first version capped
  // mornings at 2 of 5 entries, fitted to the 11/23 replay where afternoon fires
  // carried the day (+$46 vs +$966). A 1-year scan of 3,028 real surge events across
  // the watchlist then showed 11/23 was the OUTLIER: 47% of strong surges start
  // 9:30-10:00, morning follow-through 68.7% decaying monotonically to 54.2% after
  // 12:30 (user's instinct, confirmed). The durable lesson from 11/23 is only "never
  // exhaust every slot": mornings may now spend all but TWO of the day's entries;
  // two stay reserved for afternoon continuation re-fires. Skips remain shadow-
  // tracked, so the ledger keeps scoring whatever this reserve costs or saves.
  const afternoonReserve = 2;
  if (!isIndex && etMin < 750 && tradesToday.equityMorning >= Math.max(1, sleeveSettings.maxTradesPerDay - afternoonReserve)) {
    const reason = `morning budget: ${sleeveSettings.maxTradesPerDay - afternoonReserve} equity entries already taken before 12:30 ET — ${afternoonReserve} slots held for afternoon setups`;
    if (!exploreAll) return { entered: null, skipped: reason };
    budgetReason ??= reason;
  }
  // LAST-SLOTS HEALTH GATE (user call 2026-11-23: "can things like vwap be used to
  // choose"): when the equity sleeve is down to its final 2 daily entries, a fire may
  // spend one only if the name's dip today HELD session VWAP (health >= 1) — the
  // 1-year scan's accumulation tell (held: 85.6% second-leg vs 57-65% broken; 97%
  // when morning+held). Early slots trade as normal: fresh surges often have no
  // pullback yet (health 0) and the year says they are the best cohort — only the
  // LAST bullets demand proof. Best-effort (a bars hiccup scores 0, which only
  // matters in the last-2 regime); every veto is shadow-tracked like all skips.
  if (!isIndex && budgetReason == null && sleeveSettings.maxTradesPerDay - sleeveTradesToday <= 2) {
    const { pullbackHealthNow } = await import("@/lib/options/pullback-grade");
    const health = await pullbackHealthNow(underlying, signal.action === "enter_call" ? 1 : -1).catch(() => 0);
    if (health < 1) {
      const reason = `last ${sleeveSettings.maxTradesPerDay - sleeveTradesToday} slots are reserved for proven setups — ${underlying}'s dip has not held VWAP today (health ${health})`;
      if (!exploreAll) return { entered: null, skipped: reason };
      budgetReason ??= reason;
    }
  }
  // CHEAPER-STRIKE FALLBACK (user call 2026-11-23: MU fired 11 times, every pick
  // $1,000+, all skipped on the $500 cap): when the signal's quality pick busts the
  // sleeve's per-trade cap, buy the highest-delta ELIGIBLE strike that fits instead —
  // the same capped-quality-pick rule the Telegram cards already use. Never sit out
  // a live thesis on a technicality (participation-over-perfection doctrine).
  if (contract.ask * 100 > sleeveSettings.maxTradeDebit) {
    const pick = contract;
    const affordable = (snapshot?.contracts ?? [])
      .filter(row => row.side === pick.side && row.expirationDate === pick.expirationDate && row.eligible && row.bid > 0 && row.ask > 0 && row.ask * 100 <= sleeveSettings.maxTradeDebit && row.ticker !== pick.ticker)
      .sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0))[0];
    if (!affordable) return { entered: null, skipped: `pick costs $${(pick.ask * 100).toFixed(0)} (cap $${sleeveSettings.maxTradeDebit}) and no eligible cheaper strike fits` };
    contract = affordable;
    if (trading.positions.some(position => `O:${position.symbol}` === affordable.ticker)) return { entered: null, skipped: "already holding this contract" };
  }
  const quantity = computePositionSize({ ask: contract.ask, equity: Number(trading.account.equity), optionsBuyingPower: Number(trading.account.options_buying_power), settings: sleeveSettings });
  // "An order is already open" is account-wide; in explore mode several names can fire in
  // the same minute, so only a pending order on THIS name blocks.
  const gateOrders = exploreAll ? trading.orders.filter(order => order.symbol.startsWith(underlying) && /\d/.test(order.symbol.charAt(underlying.length))) : trading.orders;
  const calendar = await getMarketCalendar();
  let risk = validatePaperEntry({ signal, contract, calendar, ...trading, orders: gateOrders, positions: sleevePositions, tradesToday: sleeveTradesToday, settings: sleeveSettings, quantity });
  if (!risk.allowed && exploreAll) {
    // Count budgets inside the risk gate (entries/day, concurrent positions, daily-loss
    // stop) tag instead of veto; every other risk error still blocks.
    const isBudgetError = (message: string) => /entries per day reached|open option positions reached|Daily loss limit/.test(message);
    const budgetErrors = risk.errors.filter(isBudgetError);
    if (budgetErrors.length) {
      budgetReason ??= budgetErrors[0]!;
      risk = validatePaperEntry({ signal, contract, calendar, ...trading, orders: gateOrders, positions: [], tradesToday: 0, settings: { ...sleeveSettings, maxTradesPerDay: 10_000, maxOpenPositions: 10_000, maxDailyLoss: Number.MAX_SAFE_INTEGER }, quantity });
    }
  }
  if (!risk.allowed) return { entered: null, skipped: risk.errors[0] ?? "risk gate" };
  // Last check before the order: is this position already one the worker would sell?
  // Only SPY and SPX carry the underlying-invalidation exit (the worker has a live
  // price for those two alone), and scalp entries are exempt from it. A missing or
  // stale price never vetoes. The skip is shadow-tracked and alerted like every other.
  if ((underlying === "SPY" || underlying === "SPX") && signal.setup !== "scalp_reclaim") {
    const livePrice = underlying === "SPY" ? await latestTradePrice("SPY").catch(() => null) : snapshot?.spotPrice ?? null;
    if (invalidAtEntry({ action: signal.action, market: signal.market, price: livePrice })) {
      const call = signal.action === "enter_call";
      const level = call ? signal.market.openingRangeHigh : signal.market.openingRangeLow;
      return { entered: null, skipped: `already invalid at entry: ${underlying} at ${Number(livePrice).toFixed(2)} is back ${call ? "at or below" : "at or above"} ${level.toFixed(2)}, the level the exit rule sells on` };
    }
  }
  const outsideBudget = budgetReason != null;
  const clientOrderId = `velocity-auto-${signal.id}`.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48);
  const entryLimit = Math.max(0.01, Number(contract.midpoint.toFixed(2)));
  // 1-2 DAY TEST (user call 2026-11-27, after the 34-month replay showed same-signal
  // contracts with 1-2 more days stop out half as often: 19% vs 38% on 2,070 matched
  // signals, profit +1.8 pts/trade but not proven). Every same-day entry gets a twin
  // in the next listed expiry within two trading sessions: same signal, side and delta,
  // the same premium budget, and the SAME exit rules (the worker treats the twin as a
  // same-day trade: 15:10 flat, stops and trails unchanged). Twins are tagged
  // dteTest.arm = "next-expiry"; the primary is tagged "same-day". Paper only.
  const testArm = contract.dte === 0 && signal.setup !== "scalp_reclaim" ? await pickNextExpiryTwin(snapshot, contract, sleeveSettings, entryLimit * risk.quantity) : null;
  const order = await submitPaperOptionOrder({ symbol: contract.ticker, limitPrice: entryLimit, clientOrderId, quantity: risk.quantity });
  await createAlert({
    userId: owner.id, signalId: signal.id, eventKey: `paper-entry-${order.id}`, severity: "success",
    title: `AUTONOMOUS entry: bought ${risk.quantity} ${signal.action === "enter_call" ? "call" : "put"}${risk.quantity === 1 ? "" : "s"} on ${underlying}`,
    body: `The engine fired a ${signal.setup.replaceAll("_", " ")} signal (confidence ${signal.confidence}) and entered on its own: BUY ${risk.quantity} × ${contract.ticker} at a $${entryLimit.toFixed(2)} limit — about $${risk.debit.toFixed(0)} at risk, sized to the account. The worker guards the exit from here (stop, trail, time rules). Emergency stop in the dashboard halts future entries anytime.${outsideBudget ? ` EXPLORE entry — outside the old daily budget (${budgetReason}); taken because paper now trades every first signal per name and tags it.` : ""}`,
    metadata: { kind: "auto_entry", orderId: order.id, contractTicker: contract.ticker, limitPrice: entryLimit, quantity: risk.quantity, maxDebit: risk.debit, outsideBudget, budgetReason },
  }).catch(error => console.error("auto entry alert failed", error));
  const { error: journalError } = await admin.from("paper_trade_orders").insert({
    user_id: owner.id, signal_id: signal.id, alpaca_order_id: order.id, client_order_id: order.client_order_id,
    action: "buy_to_open", underlying, contract_ticker: contract.ticker,
    quantity: risk.quantity, order_type: "limit", limit_price: entryLimit, max_debit: risk.debit, status: order.status,
    risk_snapshot: { autonomous: true, strategy: signal.setup, equity: risk.equity, dayPnl: risk.dayPnl, rules: settings, systemCaps: PAPER_RULES, outsideBudget, budgetReason,
      ...(contract.dte === 0 ? { dteTest: { arm: "same-day", pairedWith: testArm?.contract.ticker ?? null, skipped: testArm ? null : "no next-expiry contract within two sessions that passes the same quality screen and fits the same budget" } } : {}) },
    broker_response: order,
    decision_bid: contract.bid, decision_ask: contract.ask, decision_quote_at: contract.quoteUpdatedAt ? new Date(contract.quoteUpdatedAt).toISOString() : null,
  });
  if (journalError) console.error("auto entry journal failed", journalError);
  if (testArm) await placeTestTwin({ owner: String(owner.id), signalId: signal.id, setup: signal.setup, underlying, primary: contract, primaryLimit: entryLimit, primaryQuantity: risk.quantity, twin: testArm.contract, sessionsOut: testArm.sessionsOut });
  // CONVEX KICKER (user call, 2026-11-19): alongside the quality contract, one cheap
  // away-from-the-money contract under $200 — highest-delta eligible strike at ask
  // <= $2.00, same side and expiry. Its failure never voids the primary entry.
  // SPX-only (2026-11-23): on watch names the kicker would stack past the user's
  // $500-per-ticker spec; the index PAIR keeps its original design.
  if (underlying === "SPX") try {
    // NOT gated on `eligible`: the quality screens (10% spread cap especially) are
    // built for the primary leg and structurally reject every sub-$2 contract — a
    // $0.10 spread on a $0.60 option is 17%. The kicker's screen is a two-sided
    // market with real volume; the ticket price caps the risk.
    const lottery = (snapshot?.contracts ?? [])
      .filter(candidate => candidate.side === contract.side && candidate.expirationDate === contract.expirationDate
        && candidate.ticker !== contract.ticker && candidate.ask > 0 && candidate.ask <= 2 && candidate.bid > 0 && candidate.volume >= 50)
      .sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0))[0];
    if (lottery) {
      const lotteryLimit = Math.max(0.01, Number(lottery.midpoint.toFixed(2)));
      const lotteryOrder = await submitPaperOptionOrder({ symbol: lottery.ticker, limitPrice: lotteryLimit, clientOrderId: `velocity-auto-lot-${signal.id}`.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48), quantity: 1 });
      await admin.from("paper_trade_orders").insert({
        user_id: owner.id, signal_id: signal.id, alpaca_order_id: lotteryOrder.id, client_order_id: lotteryOrder.client_order_id,
        action: "buy_to_open", underlying, contract_ticker: lottery.ticker,
        quantity: 1, order_type: "limit", limit_price: lotteryLimit, max_debit: lotteryLimit * 100, status: lotteryOrder.status,
        risk_snapshot: { autonomous: true, strategy: `${signal.setup}-kicker`, pairedWith: contract.ticker }, broker_response: lotteryOrder,
      }).then(({ error }) => { if (error) console.error("kicker journal failed", error.message); });
      await createAlert({
        userId: owner.id, signalId: signal.id, eventKey: `paper-entry-kicker-${lotteryOrder.id}`, severity: "info",
        title: `Convex kicker: 1 × ${lottery.ticker.replace("O:", "")} at $${lotteryLimit.toFixed(2)}`,
        body: `Paired with the ${contract.ticker.replace("O:", "")} entry — about $${(lotteryLimit * 100).toFixed(0)} at risk, the ticket IS the stop. If the drive runs, this is the convexity.`,
        metadata: { kind: "auto_entry_kicker", contractTicker: lottery.ticker, pairedWith: contract.ticker },
      }).catch(() => undefined);
    }
  } catch (kickerError) { console.error("convex kicker failed", kickerError instanceof Error ? kickerError.message : kickerError); }
  return { entered: contract.ticker };
}

// Latest trade for a stock, or null when it cannot be had FRESH (a delayed or failed
// feed must not veto an entry — see the 2026-11-25 delayed-feed incident).
async function latestTradePrice(symbol: string): Promise<number | null> {
  const key = process.env.ALPACA_API_KEY_ID; const secret = process.env.ALPACA_API_SECRET_KEY;
  if (!key || !secret) return null;
  const url = new URL(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/trades/latest`);
  url.searchParams.set("feed", STOCK_FEED);
  const response = await fetch(url, { headers: { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret }, cache: "no-store", signal: AbortSignal.timeout(4_000) });
  if (!response.ok) return null;
  const payload = await response.json() as { trade?: { p?: number; t?: string } };
  const price = Number(payload.trade?.p); const at = payload.trade?.t ? Date.parse(payload.trade.t) : NaN;
  return price > 0 && Number.isFinite(at) && Date.now() - at < 60_000 ? price : null;
}

// The 1-2 day test's twin: the next listed expiry after today, within two trading
// sessions, same side, nearest the primary's |delta| (0.45 when unknown), with a real
// two-sided book and a fresh quote. Null when no such contract is in the scan.
type ScanContract = CommandCenter["contracts"][number];
// Codex audit (2026-11-28): the twin must pass the SAME quality screen as the primary
// (spread and volume limits from the lane's settings) and fit the SAME budget — a
// minimum of one contract used to let a $400 twin pair with a $300 primary. A twin
// that cannot be bought inside the primary's budget is skipped and the skip recorded.
async function pickNextExpiryTwin(snapshot: CommandCenter | null, primary: ScanContract, settings: { maxSpreadPct: number; minContractVolume: number }, budget: number): Promise<{ contract: ScanContract; sessionsOut: number } | null> {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
  const later = (snapshot?.contracts ?? []).filter(candidate => candidate.side === primary.side && candidate.expirationDate > today
    && candidate.bid > 0 && candidate.ask > 0 && candidate.spreadPct <= settings.maxSpreadPct && candidate.volume >= settings.minContractVolume
    && candidate.midpoint > 0 && candidate.midpoint <= budget
    && candidate.quoteUpdatedAt != null && Date.now() - candidate.quoteUpdatedAt < 10 * 60_000);
  if (!later.length) return null;
  const nextExpiry = later.map(candidate => candidate.expirationDate).sort()[0]!;
  const sessionsOut = (await getMarketCalendar()).tradingDaysBetween(today, nextExpiry);
  if (sessionsOut < 1 || sessionsOut > 2) return null;
  const targetDelta = Math.abs(primary.delta ?? 0.45);
  const contract = later.filter(candidate => candidate.expirationDate === nextExpiry)
    .sort((a, b) => Math.abs(Math.abs(a.delta ?? 0.45) - targetDelta) - Math.abs(Math.abs(b.delta ?? 0.45) - targetDelta) || b.liquidityScore - a.liquidityScore)[0];
  return contract ? { contract, sessionsOut } : null;
}

// Places and journals the twin. Never blocks or undoes the primary; a failure pages.
async function placeTestTwin(input: { owner: string; signalId: string; setup: string; underlying: string; primary: ScanContract; primaryLimit: number; primaryQuantity: number; twin: ScanContract; sessionsOut: number }): Promise<void> {
  const admin = createAdminClient();
  const { twin, primary } = input;
  const short = (ticker: string) => ticker.replace("O:", "");
  try {
    const budget = input.primaryLimit * input.primaryQuantity;
    const twinLimit = Math.max(0.01, Number(twin.midpoint.toFixed(2)));
    const twinQuantity = Math.floor(budget / twinLimit);
    if (twinQuantity < 1) throw new Error(`twin costs $${(twinLimit * 100).toFixed(0)} per contract, over the primary's $${(budget * 100).toFixed(0)} budget`);
    const twinOrder = await submitPaperOptionOrder({ symbol: twin.ticker, limitPrice: twinLimit, quantity: twinQuantity,
      clientOrderId: ("velocity-dte2-" + input.signalId).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48) });
    // signal_id stays null: one buy_to_open per signal_id is a unique index (the primary
    // owns it); the worker reads sourceSignalId for the market context.
    const { error } = await admin.from("paper_trade_orders").insert({
      user_id: input.owner, signal_id: null, alpaca_order_id: twinOrder.id, client_order_id: twinOrder.client_order_id,
      action: "buy_to_open", underlying: input.underlying, contract_ticker: twin.ticker,
      quantity: twinQuantity, order_type: "limit", limit_price: twinLimit, max_debit: twinLimit * twinQuantity * 100, status: twinOrder.status,
      risk_snapshot: { autonomous: true, strategy: input.setup, sourceSignalId: input.signalId, outsideBudget: true, budgetReason: "1-2 day test twin",
        dteTest: { arm: "next-expiry", pairedWith: primary.ticker, sessionsOut: input.sessionsOut, primaryDebit: Number((budget * 100).toFixed(2)) } },
      broker_response: twinOrder,
      decision_bid: twin.bid, decision_ask: twin.ask, decision_quote_at: twin.quoteUpdatedAt ? new Date(twin.quoteUpdatedAt).toISOString() : null,
    });
    if (error) throw new Error("journal: " + error.message);
    await createAlert({
      userId: input.owner, signalId: input.signalId, eventKey: "paper-entry-" + twinOrder.id, severity: "success",
      title: "1-2 DAY TEST: also bought " + twinQuantity + " x " + short(twin.ticker),
      body: "Same signal, same side and the same ~$" + (budget * 100).toFixed(0) + " budget as the same-day buy (" + short(primary.ticker) + "), but expiring " + twin.expirationDate + " (" + input.sessionsOut + " trading session" + (input.sessionsOut === 1 ? "" : "s") + " later). Both follow the same exit rules, so the record shows what extra time alone does. Paper only.",
      metadata: { kind: "dte_test_twin", orderId: twinOrder.id, contractTicker: twin.ticker, pairedWith: primary.ticker, quantity: twinQuantity, limitPrice: twinLimit },
    }).catch(alertError => console.error("dte test alert failed", alertError));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("dte test twin failed", message);
    await createAlert({ userId: input.owner, eventKey: ("dte-test-failed-" + input.signalId).slice(0, 120), severity: "warning",
      title: "1-2 day test twin not placed: " + input.underlying,
      body: "The same-day entry went in, but its 1-2 day twin (" + short(twin.ticker) + ") failed: " + message.slice(0, 200) + ". That pair is missing from the test.",
      metadata: { kind: "dte_test_failed", signalId: input.signalId, error: message } }).catch(() => undefined);
  }
}

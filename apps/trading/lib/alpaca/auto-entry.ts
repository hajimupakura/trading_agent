import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAlert } from "@/lib/alerts/server";
import { getPaperTradingState, submitPaperOptionOrder } from "./paper";
import { PAPER_RULES, computePositionSize, entryCooldownActive, validatePaperEntry } from "./risk";
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
  const rows = (data ?? []).filter(row => (row.risk_snapshot as { strategy?: string } | null)?.strategy !== "convexity-swarm");
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
  const { data: control } = await admin.from("position_manager_control").select("kill_switch").eq("id", true).single();
  if (control?.kill_switch) return { entered: null, skipped: "kill switch" };
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
  if (cooldown) return { entered: null, skipped: "cooldown" };
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
  const sleevePositions = trading.positions.filter(position => isIndexOcc(String(position.symbol)) === isIndex && !convexityTickers.has(`O:${position.symbol}`));
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
  if (!isIndex && etMin < 750 && tradesToday.equityMorning >= Math.max(1, sleeveSettings.maxTradesPerDay - afternoonReserve)) return { entered: null, skipped: `morning budget: ${sleeveSettings.maxTradesPerDay - afternoonReserve} equity entries already taken before 12:30 ET — ${afternoonReserve} slots held for afternoon setups` };
  // LAST-SLOTS HEALTH GATE (user call 2026-11-23: "can things like vwap be used to
  // choose"): when the equity sleeve is down to its final 2 daily entries, a fire may
  // spend one only if the name's dip today HELD session VWAP (health >= 1) — the
  // 1-year scan's accumulation tell (held: 85.6% second-leg vs 57-65% broken; 97%
  // when morning+held). Early slots trade as normal: fresh surges often have no
  // pullback yet (health 0) and the year says they are the best cohort — only the
  // LAST bullets demand proof. Best-effort (a bars hiccup scores 0, which only
  // matters in the last-2 regime); every veto is shadow-tracked like all skips.
  if (!isIndex && sleeveSettings.maxTradesPerDay - sleeveTradesToday <= 2) {
    const { pullbackHealthNow } = await import("@/lib/options/pullback-grade");
    const health = await pullbackHealthNow(underlying, signal.action === "enter_call" ? 1 : -1).catch(() => 0);
    if (health < 1) return { entered: null, skipped: `last ${sleeveSettings.maxTradesPerDay - sleeveTradesToday} slots are reserved for proven setups — ${underlying}'s dip has not held VWAP today (health ${health})` };
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
  const risk = validatePaperEntry({ signal, contract, ...trading, positions: sleevePositions, tradesToday: sleeveTradesToday, settings: sleeveSettings, quantity });
  if (!risk.allowed) return { entered: null, skipped: risk.errors[0] ?? "risk gate" };
  const clientOrderId = `velocity-auto-${signal.id}`.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48);
  const entryLimit = Math.max(0.01, Number(contract.midpoint.toFixed(2)));
  const order = await submitPaperOptionOrder({ symbol: contract.ticker, limitPrice: entryLimit, clientOrderId, quantity: risk.quantity });
  await createAlert({
    userId: owner.id, signalId: signal.id, eventKey: `paper-entry-${order.id}`, severity: "success",
    title: `AUTONOMOUS entry: bought ${risk.quantity} ${signal.action === "enter_call" ? "call" : "put"}${risk.quantity === 1 ? "" : "s"} on ${underlying}`,
    body: `The engine fired a ${signal.setup.replaceAll("_", " ")} signal (confidence ${signal.confidence}) and entered on its own: BUY ${risk.quantity} × ${contract.ticker} at a $${entryLimit.toFixed(2)} limit — about $${risk.debit.toFixed(0)} at risk, sized to the account. The worker guards the exit from here (stop, trail, time rules). Emergency stop in the dashboard halts future entries anytime.`,
    metadata: { kind: "auto_entry", orderId: order.id, contractTicker: contract.ticker, limitPrice: entryLimit, quantity: risk.quantity, maxDebit: risk.debit },
  }).catch(error => console.error("auto entry alert failed", error));
  const { error: journalError } = await admin.from("paper_trade_orders").insert({
    user_id: owner.id, signal_id: signal.id, alpaca_order_id: order.id, client_order_id: order.client_order_id,
    action: "buy_to_open", underlying, contract_ticker: contract.ticker,
    quantity: risk.quantity, order_type: "limit", limit_price: entryLimit, max_debit: risk.debit, status: order.status,
    risk_snapshot: { autonomous: true, strategy: signal.setup, equity: risk.equity, dayPnl: risk.dayPnl, rules: settings, systemCaps: PAPER_RULES }, broker_response: order,
  });
  if (journalError) console.error("auto entry journal failed", journalError);
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

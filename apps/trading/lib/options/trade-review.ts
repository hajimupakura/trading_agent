import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAlert } from "@/lib/alerts/server";
import { aiConfigured, chatComplete } from "@/lib/ai/openrouter";

// Self-healing loop, step 1: every closed trade gets an automatic autopsy.
// For each filled sell_to_close, pull the contract's minute tape (research_fetches
// queue), measure what actually happened around our entry and exit, classify the
// trade, and write a plain-English lesson to trade_reviews + a Telegram alert.
// DESIGN GUARDRAIL: this loop diagnoses per-trade but NEVER changes rules. Rules
// change only when a verdict pattern accumulates across many trades AND the proposed
// fix survives the replay gauntlet — one trade is an anecdote, not a lesson.
// Prices are journal limit prices (approximate fills), same convention as the
// weekly post-mortem.

const etDate = (ts: number | string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(ts));

interface OrderRow { id: number; action: string; contract_ticker: string; quantity: number; limit_price: number | string | null; created_at: string; risk_snapshot: Record<string, unknown> | null; underlying: string | null }

async function ownerId(): Promise<string | null> {
  const { data } = await createAdminClient().from("profiles").select("id").limit(1).maybeSingle();
  return data?.id ?? null;
}

// Stage 1: create review rows (+ tape fetch requests) for unreviewed closed trades.
async function stageNewReviews(): Promise<number> {
  const admin = createAdminClient();
  const { data: sells } = await admin.from("paper_trade_orders")
    .select("id,action,contract_ticker,quantity,limit_price,created_at,risk_snapshot,underlying")
    .eq("action", "sell_to_close").eq("status", "filled")
    .order("created_at", { ascending: false }).limit(20);
  if (!sells?.length) return 0;
  const { data: existing } = await admin.from("trade_reviews").select("sell_order_id").in("sell_order_id", sells.map(row => row.id));
  const reviewed = new Set((existing ?? []).map(row => Number(row.sell_order_id)));
  let staged = 0;
  for (const sell of (sells as OrderRow[]).filter(row => !reviewed.has(Number(row.id))).slice(0, 3)) {
    const { data: buys } = await admin.from("paper_trade_orders")
      .select("id,limit_price,created_at")
      .eq("action", "buy_to_open").eq("contract_ticker", sell.contract_ticker)
      .lte("created_at", sell.created_at)
      .order("created_at", { ascending: false }).limit(1);
    const buy = buys?.[0];
    const entryAt = buy?.created_at ?? sell.created_at;
    const fromDate = etDate(entryAt); const toDate = etDate(sell.created_at);
    // Tape request covers entry through the exit session (post-exit window included).
    const { data: fetchExists } = await admin.from("research_fetches").select("id")
      .eq("ticker", sell.contract_ticker).eq("from_date", fromDate).eq("to_date", toDate).limit(1).maybeSingle();
    if (!fetchExists) await admin.from("research_fetches").insert({ ticker: sell.contract_ticker, from_date: fromDate, to_date: toDate, timeframe: "1Min" });
    await admin.from("trade_reviews").insert({
      sell_order_id: sell.id, contract_ticker: sell.contract_ticker, underlying: sell.underlying,
      quantity: sell.quantity, entry_price: buy?.limit_price ?? null, exit_price: sell.limit_price,
      entry_at: entryAt, exit_at: sell.created_at,
      exit_reason: (sell.risk_snapshot as { exitReason?: string } | null)?.exitReason ?? null,
    });
    staged += 1;
  }
  return staged;
}

// Stage 2: analyze reviews whose tape has arrived.
async function analyzeReadyReviews(): Promise<string[]> {
  const admin = createAdminClient();
  const done: string[] = [];
  const { data: pending } = await admin.from("trade_reviews").select("*").eq("status", "pending_data").limit(3);
  for (const review of pending ?? []) {
    const { data: fetch } = await admin.from("research_fetches").select("bars,status")
      .eq("ticker", review.contract_ticker).eq("from_date", etDate(review.entry_at)).eq("to_date", etDate(review.exit_at))
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (!fetch || fetch.status === "queued" || fetch.status === "running") continue;
    try {
      if (fetch.status === "error") throw new Error("tape fetch failed");
      const bars = (fetch.bars as number[][] | null) ?? [];
      const entryTs = Date.parse(String(review.entry_at)); const exitTs = Date.parse(String(review.exit_at));
      const entry = Number(review.entry_price ?? 0); const exit = Number(review.exit_price ?? 0);
      if (!bars.length || !entry || !exit) throw new Error("insufficient tape or prices");
      const hold = bars.filter(bar => bar[0] >= entryTs - 60_000 && bar[0] <= exitTs + 60_000);
      const post = bars.filter(bar => bar[0] > exitTs + 60_000);
      const peakHold = hold.length ? Math.max(...hold.map(bar => bar[2])) : entry;
      const lowHold = hold.length ? Math.min(...hold.map(bar => bar[3])) : entry;
      const postPeak = post.length ? Math.max(...post.map(bar => bar[2])) : null;
      const postClose = post.length ? post[post.length - 1][4] : null;
      const pnlPct = (exit / entry - 1) * 100;
      const bestSeen = Math.max(peakHold, postPeak ?? 0);
      const metrics = {
        pnlPct: +pnlPct.toFixed(1), holdMinutes: Math.round((exitTs - entryTs) / 60_000),
        peakDuringHold: peakHold, lowDuringHold: lowHold,
        postExitPeak: postPeak, postExitClose: postClose,
        exitEfficiencyPct: bestSeen > 0 ? +((exit / bestSeen) * 100).toFixed(0) : null,
        leftOnTablePct: postPeak && postPeak > exit ? +((postPeak / exit - 1) * 100).toFixed(0) : 0,
        savedPct: postClose != null && postClose < exit ? +((1 - postClose / exit) * 100).toFixed(0) : 0,
      };
      const verdict =
        postPeak != null && postPeak >= exit * 1.5 ? "sold_too_early"
        : postClose != null && postClose <= exit * 0.6 ? "exit_saved_capital"
        : metrics.exitEfficiencyPct != null && metrics.exitEfficiencyPct >= 75 ? "well_harvested"
        : pnlPct < 0 && peakHold >= entry * 1.3 ? "gave_back_gains"
        : pnlPct < 0 && peakHold < entry * 1.1 ? "entry_thesis_failed"
        : "mixed";
      let lesson = "";
      if (aiConfigured()) {
        lesson = await chatComplete({
          system: "You write a 3-4 sentence plain-English post-trade lesson for a beginner options trader. Use ONLY the numbers given; never invent any. Name what went right or wrong (entry, exit rule, or just market luck) and what pattern to watch for across future trades. One trade proves nothing — say the lesson is a tally mark, not a rule change, when relevant.",
          user: `Trade: ${review.contract_ticker}, entered $${entry}, exited $${exit} (${metrics.pnlPct}%) after ${metrics.holdMinutes} minutes via rule "${review.exit_reason ?? "unknown"}". During the hold the option peaked at $${peakHold} and bottomed at $${lowHold}. After our exit it ${postPeak != null ? `peaked at $${postPeak} and closed at $${postClose}` : "had no further trades"}. Verdict classification: ${verdict}.`,
          maxTokens: 400,
        }).catch(() => "");
      }
      await admin.from("trade_reviews").update({ status: "done", metrics, verdict, lesson: lesson || null, processed_at: new Date().toISOString() }).eq("id", review.id);
      const userId = await ownerId();
      if (userId) await createAlert({
        userId, eventKey: `ai-trade-review-${review.sell_order_id}`, severity: "info",
        title: `Trade autopsy: ${review.contract_ticker.replace("O:", "")} — ${verdict.replace(/_/g, " ")}`,
        body: `${metrics.pnlPct >= 0 ? "Made" : "Lost"} ${Math.abs(metrics.pnlPct)}% in ${metrics.holdMinutes} min (exit rule: ${review.exit_reason ?? "unknown"}). Exit captured ${metrics.exitEfficiencyPct ?? "—"}% of the best price the tape ever offered${metrics.leftOnTablePct ? `; the option later ran ${metrics.leftOnTablePct}% above our exit` : ""}${metrics.savedPct ? `; exiting saved ${metrics.savedPct}% vs holding to the close` : ""}. ${lesson || "Tape analyzed; no AI narrative available."}`,
        metadata: { kind: "trade_review", verdict, ...metrics },
      });
      done.push(verdict);
    } catch (error) {
      await admin.from("trade_reviews").update({ status: "error", error: error instanceof Error ? error.message : String(error), processed_at: new Date().toISOString() }).eq("id", review.id);
    }
  }
  return done;
}

// Self-healing loop, step 2: tally counter -> drafted proposal. When the same verdict
// accumulates across enough trades, draft a rule proposal AND pre-score it by replaying
// candidate exit rules over the stored tapes of every reviewed trade (not just the
// pattern members — a rule must help the whole book, not the cherry-picked losers).
// Output is a proposal row + a plain-English Telegram insight. Nothing here changes
// live rules: adoption stays a human decision after the full replay gauntlet.
const TALLY_THRESHOLD = 3;
const TRAIL_ARM = 1.3;   // candidate: arm the trail once up 30%...
const TRAIL_KEEP = 0.75; // ...then exit if price gives back to 75% of its peak.

function simulateTrail(bars: number[][], entry: number, entryTs: number, exitTs: number, actualExit: number, ride: boolean): number {
  let peak = 0, armed = false;
  for (const bar of bars) {
    if (bar[0] < entryTs - 60_000) continue;
    if (!ride && bar[0] > exitTs + 60_000) break;
    peak = Math.max(peak, bar[2]);
    if (!armed && peak >= entry * TRAIL_ARM) armed = true;
    if (armed && bar[3] <= peak * TRAIL_KEEP) return peak * TRAIL_KEEP;
    // ride mode without an armed trail still respects the actual (time) exit.
    if (ride && !armed && bar[0] >= exitTs) return actualExit;
  }
  return actualExit;
}

async function aggregateLessons(): Promise<string[]> {
  const admin = createAdminClient();
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const { data: reviews } = await admin.from("trade_reviews").select("id,contract_ticker,entry_at,exit_at,entry_price,exit_price,verdict")
    .eq("status", "done").gte("processed_at", since).limit(100);
  if (!reviews?.length) return [];
  const tallies = new Map<string, number>();
  for (const review of reviews) tallies.set(String(review.verdict), (tallies.get(String(review.verdict)) ?? 0) + 1);
  const drafted: string[] = [];
  for (const [pattern, count] of tallies) {
    if (count < TALLY_THRESHOLD || !["gave_back_gains", "sold_too_early"].includes(pattern)) continue;
    const { data: open } = await admin.from("rule_proposals").select("id").eq("pattern", pattern).eq("status", "proposed").limit(1).maybeSingle();
    if (open) continue;
    // Score the candidate trail rule over EVERY reviewed trade with a stored tape.
    const perTrade: Array<{ ticker: string; actualPct: number; bankPct: number; ridePct: number }> = [];
    for (const review of reviews) {
      const entry = Number(review.entry_price ?? 0); const exit = Number(review.exit_price ?? 0);
      if (!entry || !exit) continue;
      const { data: fetch } = await admin.from("research_fetches").select("bars,status")
        .eq("ticker", review.contract_ticker).eq("from_date", etDate(review.entry_at)).eq("to_date", etDate(review.exit_at))
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      const bars = (fetch?.status === "done" ? fetch.bars as number[][] : null) ?? [];
      if (!bars.length) continue;
      const entryTs = Date.parse(String(review.entry_at)); const exitTs = Date.parse(String(review.exit_at));
      const bank = simulateTrail(bars, entry, entryTs, exitTs, exit, false);
      const rideExit = simulateTrail(bars, entry, entryTs, exitTs, exit, true);
      perTrade.push({ ticker: review.contract_ticker, actualPct: +((exit / entry - 1) * 100).toFixed(1), bankPct: +((bank / entry - 1) * 100).toFixed(1), ridePct: +((rideExit / entry - 1) * 100).toFixed(1) });
    }
    if (perTrade.length < TALLY_THRESHOLD) continue;
    const avg = (key: "actualPct" | "bankPct" | "ridePct") => +(perTrade.reduce((sum, row) => sum + row[key], 0) / perTrade.length).toFixed(1);
    const summary = { trades: perTrade.length, patternCount: count, avgActualPct: avg("actualPct"), avgBankTrailPct: avg("bankPct"), avgRideTrailPct: avg("ridePct") };
    const best = Math.max(summary.avgBankTrailPct, summary.avgRideTrailPct);
    const helps = best > summary.avgActualPct + 2; // must beat reality by a real margin
    const proposedRule = summary.avgBankTrailPct >= summary.avgRideTrailPct
      ? `Arm a ${Math.round((1 - TRAIL_KEEP) * 100)}% trailing stop once a position is up ${Math.round((TRAIL_ARM - 1) * 100)}% (banked before any time exit)`
      : `Once up ${Math.round((TRAIL_ARM - 1) * 100)}%, let a ${Math.round((1 - TRAIL_KEEP) * 100)}% trail override the time exit and ride the trend`;
    await admin.from("rule_proposals").insert({ pattern, proposed_rule: proposedRule, status: helps ? "proposed" : "rejected_by_replay", evidence: { ...summary, perTrade } });
    const userId = await ownerId();
    if (userId) await createAlert({
      userId, eventKey: `ai-rule-proposal-${pattern}-${etDate(Date.now())}`, severity: "info",
      title: helps ? `Pattern confirmed ${count}× — the engine drafted a rule change for you` : `Pattern seen ${count}× — but the fix failed its replay test`,
      body: helps
        ? `"${pattern.replace(/_/g, " ")}" has now happened ${count} times in 30 days, so the tally became a draft rule: ${proposedRule}. Replayed over the last ${summary.trades} real trades' price tapes it would have averaged ${best >= 0 ? "+" : ""}${best}% per trade vs ${summary.avgActualPct >= 0 ? "+" : ""}${summary.avgActualPct}% actual. This changes NOTHING yet — it needs the full backtest gauntlet and your sign-off before going live.`
        : `"${pattern.replace(/_/g, " ")}" has happened ${count} times, and the obvious fix (${proposedRule.toLowerCase()}) was auto-replayed over ${summary.trades} real trades — it would have averaged ${best}% vs ${summary.avgActualPct}% actual, so it does NOT survive the evidence and was shelved automatically. The tape keeps accumulating; a better variant may be proposed later.`,
      metadata: { kind: "rule_proposal", pattern, ...summary },
    }).catch(error => console.error("rule proposal alert failed", error));
    drafted.push(pattern);
  }
  return drafted;
}

export async function runTradeReviews(): Promise<{ staged: number; analyzed: string[]; proposals?: string[] }> {
  const staged = await stageNewReviews();
  const analyzed = await analyzeReadyReviews();
  const proposals = analyzed.length ? await aggregateLessons().catch(error => { console.error("lesson aggregation failed", error); return []; }) : [];
  return { staged, analyzed, proposals };
}

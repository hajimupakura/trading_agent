import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadRiskSettings } from "@/lib/settings/risk-settings";
import { telegramConfigured } from "@/lib/notify/telegram";
import { sendWithButtons, type InlineButton } from "./api";
import type { CommandCenter, Contract, Signal } from "@/lib/options/types";

// SIGNAL FEED → Telegram buy proposals (user call, 2026-11-21): every engine fire on
// EVERY watch name becomes a one-tap Robinhood ticket — on 11/20 the feed printed 21
// correct fires (SPY/QQQ/MSFT/NVDA/META/TSLA/MU/GOOGL puts) while the SPX lane was
// data-blind; the human could have acted on any of them with one tap. Semi-agentic by
// design: the engine proposes, ONLY a button tap executes. Two buttons when the
// signal's quality pick exceeds the Robinhood cap: the capped size, and the full pick
// with its real dollar cost spelled out (the tap is the override authorization).

const FINGERPRINT_COOLDOWN_MS = 45 * 60_000; // one card per underlying+side+setup per 45 min

export async function proposeTelegramTrade(signal: Signal, snapshot: CommandCenter): Promise<void> {
  if (!telegramConfigured() || !process.env.TELEGRAM_WEBHOOK_SECRET) return; // bot not wired yet
  const contract = signal.contract;
  if (!contract || !["enter_call", "enter_put"].includes(signal.action)) return;
  if (Date.now() - signal.generatedAt > 120_000) return; // stale scans never propose
  const underlying = contract.underlying;
  const admin = createAdminClient();
  const { data: owner } = await admin.from("profiles").select("id").limit(1).maybeSingle();
  if (!owner) return;
  const fingerprint = `${underlying}:${signal.action}:${signal.setup}`;
  // Dedupe: a recent card for this exact setup, or ANY undecided card on this
  // underlying+side, suppresses a new one — a persistent fire must not spam a card
  // per scan tick (the scan re-generates the signal every minute while it holds).
  const { data: recent, error: dedupeError } = await admin.from("tg_tickets").select("id,status,created_at,payload")
    .eq("kind", "buy").gte("created_at", new Date(Date.now() - FINGERPRINT_COOLDOWN_MS).toISOString())
    .or(`fingerprint.eq.${fingerprint},status.eq.proposed`);
  if (dedupeError) return; // fail closed: no dedupe data, no proposal (never spam)
  const duplicate = (recent ?? []).some(row => {
    const payload = row.payload as { underlying?: string; side?: string } | null;
    return row.status === "proposed"
      ? payload?.underlying === underlying && payload?.side === contract.side
      : true; // same-fingerprint row inside the cooldown window
  });
  if (duplicate) return;
  const userId = String(owner.id);
  const settings = await loadRiskSettings(userId);
  const cap = underlying === "SPX" ? settings.rhMaxTradeDebitSpx : settings.rhMaxTradeDebit;
  // Capped sizing mirrors the auto-entry quality pick: nearest-0.45|Δ| eligible
  // contract under the cap, quantity filling it. The signal pick rides regardless.
  const sameExpiry = [contract, ...(snapshot.contracts ?? [])].filter(candidate =>
    candidate.eligible && candidate.side === contract.side && candidate.expirationDate === contract.expirationDate
    && candidate.ask > 0 && candidate.delta != null);
  const cappedPick = sameExpiry.filter(candidate => candidate.ask * 100 <= cap && Math.abs(candidate.delta!) >= 0.3)
    .sort((a, b) => Math.abs(Math.abs(a.delta!) - 0.45) - Math.abs(Math.abs(b.delta!) - 0.45) || b.liquidityScore - a.liquidityScore)[0]
    ?? sameExpiry.filter(candidate => candidate.ask * 100 <= cap)
      .sort((a, b) => Math.abs(b.delta!) - Math.abs(a.delta!))[0];
  const describe = (pick: Contract, quantity: number) => `${quantity}× ${pick.ticker.replace("O:", "")} ~$${(quantity * pick.ask * 100).toFixed(0)}`;
  const options: Array<{ pick: Contract; quantity: number; overCap: boolean }> = [];
  if (cappedPick) options.push({ pick: cappedPick, quantity: Math.max(1, Math.floor(cap / (cappedPick.ask * 100))), overCap: false });
  if (contract.ask * 100 > cap && (!cappedPick || cappedPick.ticker !== contract.ticker)) options.push({ pick: contract, quantity: 1, overCap: true });
  if (!options.length) options.push({ pick: contract, quantity: 1, overCap: contract.ask * 100 > cap });

  const payloadFor = (option: { pick: Contract; quantity: number; overCap: boolean }) => ({
    underlying, side: contract.side, signalId: signal.id, setup: signal.setup,
    ticker: option.pick.ticker, strike: option.pick.strike, expirationDate: option.pick.expirationDate,
    quantity: option.quantity, askAtProposal: option.pick.ask, override: option.overCap, cap,
  });
  const inserted: Array<{ id: string; label: string }> = [];
  for (const option of options) {
    const { data: row, error } = await admin.from("tg_tickets").insert({
      user_id: userId, kind: "buy", source: "engine", fingerprint, payload: payloadFor(option),
    }).select("id").single();
    if (error || !row) { console.error("tg ticket insert failed", error?.message); continue; }
    inserted.push({ id: String(row.id), label: option.overCap ? `💥 Buy ${describe(option.pick, option.quantity)} (OVER $${cap} cap)` : `⚡ Buy ${describe(option.pick, option.quantity)}` });
  }
  if (!inserted.length) return;
  const buttons: InlineButton[][] = [
    ...inserted.map(entry => [{ text: entry.label, callback_data: `cf:${entry.id}` }]),
    // callback_data is capped at 64 bytes — one id only; the skip handler widens to
    // every proposed ticket on the same card via tg_message_id.
    [{ text: "✖ Skip", callback_data: `cx:${inserted[0].id}` }],
  ];
  const sideWord = contract.side === "put" ? "PUT" : "CALL";
  // News is context, never a gate: a failed lookup must not delay or kill the card.
  const news = await import("@/lib/news/market-news").then(module => module.latestNewsFor(underlying)).catch(() => null);
  const text = `🔔 ${underlying} ${signal.setup.replaceAll("_", " ")} — ${sideWord} (confidence ${signal.confidence})\n`
    + `${signal.reasons[0] ?? ""}\n`
    + (news ? `📰 ${news.headline.slice(0, 140)} (${(await import("@/lib/news/market-news")).newsAge(news.publishedAt)})\n` : "")
    + `Engine pick: ${contract.ticker.replace("O:", "")} asking $${contract.ask.toFixed(2)}${contract.ask * 100 > cap ? ` — above the $${cap} RH cap, the over-cap button is your explicit override` : ""}.\n`
    + `Tap to buy on Robinhood (worker guards the exit after the fill), or reply e.g. "buy 2 ${underlying === "SPX" ? "6900" : Math.round(contract.strike)}${contract.side === "put" ? "p" : "c"}" to pick your own strike/size/expiry.`;
  const messageId = await sendWithButtons(text, buttons).catch(error => { console.error("tg proposal send failed", error); return null; });
  if (messageId) await admin.from("tg_tickets").update({ tg_message_id: messageId }).in("id", inserted.map(entry => entry.id));
}

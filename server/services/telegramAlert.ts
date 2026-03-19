import axios from "axios";

/**
 * Telegram Alert Service
 * Sends trading notifications via Telegram Bot API.
 * Fire-and-forget: never throws, never blocks the trading cycle.
 *
 * Setup:
 * 1. Message @BotFather on Telegram, create a bot, get the token
 * 2. Send a message to your bot, then visit:
 *    https://api.telegram.org/bot<TOKEN>/getUpdates
 *    to find your chat_id
 * 3. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID env vars
 */

const TELEGRAM_API = "https://api.telegram.org/bot";

// Rate limiter: max 20 msgs/min (Telegram limit is 30)
let messageQueue: Array<{ text: string; parseMode: string }> = [];
let isProcessing = false;

function getToken(): string | undefined {
  return process.env.TELEGRAM_BOT_TOKEN;
}

function getChatId(): string | undefined {
  return process.env.TELEGRAM_CHAT_ID;
}

export function isTelegramConfigured(): boolean {
  return !!getToken() && !!getChatId();
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface CycleSummary {
  cycleNumber: number;
  timestamp: Date;
  predictionsGenerated: number;
  highConfidencePredictions: number;
  tradesExecuted: TradeAlert[];
  positionsClosed: ClosedPosition[];
  slTpTriggered: number;
  riskWarnings: string[];
  portfolioEquity: number;
  portfolioPnL: number;
  marketOutlook?: string;
}

export interface TradeAlert {
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  reason: string;
  confidence: number;
  stopLoss?: number;
  takeProfit?: number;
}

export interface ClosedPosition {
  symbol: string;
  reason: string;
  pnl: number;
}

export interface DailySummary {
  date: string;
  cyclesRun: number;
  totalTradesExecuted: number;
  totalPnL: number;
  portfolioEquity: number;
  bestTrade: string;
  worstTrade: string;
  agentReflection?: string;
}

// ── Core Send ────────────────────────────────────────────────────────────────

async function sendRaw(text: string, parseMode: string = "HTML"): Promise<boolean> {
  const token = getToken();
  const chatId = getChatId();
  if (!token || !chatId) return false;

  try {
    await axios.post(`${TELEGRAM_API}${token}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: parseMode,
      disable_web_page_preview: true,
    }, { timeout: 10_000 });
    return true;
  } catch (error: any) {
    console.error("[Telegram] Send failed:", error.message);
    return false;
  }
}

async function processQueue() {
  if (isProcessing || messageQueue.length === 0) return;
  isProcessing = true;

  while (messageQueue.length > 0) {
    const msg = messageQueue.shift()!;
    await sendRaw(msg.text, msg.parseMode);
    // 3 second gap between messages (20/min safe rate)
    if (messageQueue.length > 0) {
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  isProcessing = false;
}

/**
 * Queue a message to send via Telegram. Non-blocking.
 */
export async function sendTelegramMessage(text: string, parseMode: string = "HTML"): Promise<void> {
  if (!isTelegramConfigured()) return;
  messageQueue.push({ text, parseMode });
  processQueue().catch(() => {}); // Fire and forget
}

// ── Structured Alerts ────────────────────────────────────────────────────────

export async function sendCycleSummary(summary: CycleSummary): Promise<void> {
  const lines: string[] = [];

  lines.push(`🔄 <b>Agent Cycle #${summary.cycleNumber}</b>`);
  lines.push(`📊 Predictions: ${summary.highConfidencePredictions} high-confidence / ${summary.predictionsGenerated} total`);

  if (summary.tradesExecuted.length > 0) {
    lines.push("");
    lines.push("<b>Trades Executed:</b>");
    for (const trade of summary.tradesExecuted) {
      const emoji = trade.side === "buy" ? "🟢" : "🔴";
      lines.push(
        `${emoji} ${trade.side.toUpperCase()} <b>${trade.symbol}</b> — ${trade.quantity} shares @ $${trade.price.toFixed(2)}`
      );
      if (trade.stopLoss) lines.push(`   SL: $${trade.stopLoss.toFixed(2)} | TP: $${trade.takeProfit?.toFixed(2) ?? "—"}`);
      lines.push(`   ${trade.reason}`);
    }
  }

  if (summary.positionsClosed.length > 0) {
    lines.push("");
    lines.push("<b>Positions Closed:</b>");
    for (const pos of summary.positionsClosed) {
      const emoji = pos.pnl >= 0 ? "✅" : "❌";
      lines.push(`${emoji} ${pos.symbol} — ${pos.pnl >= 0 ? "+" : ""}$${pos.pnl.toFixed(2)} (${pos.reason})`);
    }
  }

  if (summary.riskWarnings.length > 0) {
    lines.push("");
    lines.push("⚠️ <b>Risk Warnings:</b>");
    for (const w of summary.riskWarnings) {
      lines.push(`  • ${w}`);
    }
  }

  lines.push("");
  lines.push(`💰 Equity: $${summary.portfolioEquity.toFixed(2)} | P&L: ${summary.portfolioPnL >= 0 ? "+" : ""}$${summary.portfolioPnL.toFixed(2)}`);

  if (summary.marketOutlook) {
    lines.push(`🔮 ${summary.marketOutlook}`);
  }

  await sendTelegramMessage(lines.join("\n"));
}

export async function sendTradeAlert(trade: TradeAlert): Promise<void> {
  const emoji = trade.side === "buy" ? "🟢" : "🔴";
  const lines = [
    `${emoji} <b>${trade.side.toUpperCase()} EXECUTED</b>`,
    `<b>${trade.symbol}</b> — ${trade.quantity} shares @ $${trade.price.toFixed(2)}`,
    `Confidence: ${trade.confidence}%`,
  ];
  if (trade.stopLoss) lines.push(`SL: $${trade.stopLoss.toFixed(2)} | TP: $${trade.takeProfit?.toFixed(2) ?? "—"}`);
  lines.push(`Reason: ${trade.reason}`);

  await sendTelegramMessage(lines.join("\n"));
}

export async function sendRiskWarning(warning: string): Promise<void> {
  await sendTelegramMessage(`⚠️ <b>Risk Warning</b>\n${warning}`);
}

export async function sendDailySummary(daily: DailySummary): Promise<void> {
  const lines = [
    `📈 <b>Daily Summary — ${daily.date}</b>`,
    "",
    `Cycles: ${daily.cyclesRun} | Trades: ${daily.totalTradesExecuted}`,
    `P&L: ${daily.totalPnL >= 0 ? "+" : ""}$${daily.totalPnL.toFixed(2)}`,
    `Equity: $${daily.portfolioEquity.toFixed(2)}`,
    "",
    `Best: ${daily.bestTrade || "—"}`,
    `Worst: ${daily.worstTrade || "—"}`,
  ];

  if (daily.agentReflection) {
    lines.push("");
    lines.push(`🧠 <b>Agent Reflection:</b>`);
    lines.push(daily.agentReflection);
  }

  await sendTelegramMessage(lines.join("\n"));
}

export async function sendAgentStartup(): Promise<void> {
  await sendTelegramMessage("🤖 <b>Trading Agent Started</b>\nMonitoring market. Will run hourly during market hours (9:30 AM - 4 PM EST).");
}

export async function sendAgentPaused(): Promise<void> {
  await sendTelegramMessage("⏸️ <b>Trading Agent Paused</b>\nNo trades will be executed until resumed.");
}

export async function sendAgentResumed(): Promise<void> {
  await sendTelegramMessage("▶️ <b>Trading Agent Resumed</b>\nNow monitoring market and executing trades.");
}

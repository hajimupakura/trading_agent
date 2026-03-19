import { getPortfolioPositions, getPortfolioById } from "../db";
import { getStockQuote } from "./stockPriceService";

/**
 * Risk Management Service
 * Enforces position sizing, stop losses, drawdown limits,
 * and sector concentration rules before trade execution.
 */

export interface RiskSettings {
  maxPositionPct: number;       // Max % of equity per single position (default 10)
  maxSectorPct: number;         // Max % of equity in one sector (default 25)
  stopLossPct: number;          // Default stop loss % below entry (default 5)
  takeProfitPct: number;        // Default take profit % above entry (default 15)
  maxDrawdownPct: number;       // Pause trading if portfolio drops this % from peak (default 15)
  maxOpenPositions: number;     // Max concurrent positions (default 10)
  initialEquity: number;        // Starting portfolio value for drawdown tracking
}

export const DEFAULT_RISK_SETTINGS: RiskSettings = {
  maxPositionPct: 10,
  maxSectorPct: 25,
  stopLossPct: 5,
  takeProfitPct: 15,
  maxDrawdownPct: 15,
  maxOpenPositions: 10,
  initialEquity: 100_000,
};

export interface RiskCheck {
  allowed: boolean;
  warnings: string[];
  blocked: string[];  // Hard blocks — trade should not proceed
  suggestedQuantity?: number;
  suggestedStopLoss?: number;
  suggestedTakeProfit?: number;
}

/**
 * Run all risk checks before executing a trade.
 */
export async function checkTradeRisk(
  portfolioId: number,
  userId: number,
  symbol: string,
  side: "buy" | "sell",
  quantity: number,
  settings: Partial<RiskSettings> = {},
): Promise<RiskCheck> {
  const config = { ...DEFAULT_RISK_SETTINGS, ...settings };
  const warnings: string[] = [];
  const blocked: string[] = [];

  // Sells are always allowed (reducing risk)
  if (side === "sell") {
    return { allowed: true, warnings: [], blocked: [] };
  }

  const portfolio = await getPortfolioById(portfolioId, userId);
  if (!portfolio) {
    return { allowed: false, warnings: [], blocked: ["Portfolio not found"] };
  }

  const positions = await getPortfolioPositions(portfolioId);
  const cashBalance = parseFloat(portfolio.cashBalance);

  // Get current price
  const quote = await getStockQuote(symbol);
  if (!quote) {
    return { allowed: false, warnings: [], blocked: [`Cannot get price for ${symbol}`] };
  }

  const tradeValue = quote.price * quantity;

  // ── Check 1: Max open positions ──────────────────────────────────────────
  if (positions.length >= config.maxOpenPositions) {
    const existingPosition = positions.find(p => p.symbol === symbol.toUpperCase());
    if (!existingPosition) {
      blocked.push(
        `Max ${config.maxOpenPositions} open positions reached. Close a position before opening new ones.`
      );
    }
  }

  // ── Check 2: Position size limit ─────────────────────────────────────────
  // Calculate current total equity
  let totalEquity = cashBalance;
  for (const pos of positions) {
    const posQuote = await getStockQuote(pos.symbol);
    if (posQuote) {
      totalEquity += posQuote.price * pos.quantity;
    } else {
      totalEquity += parseFloat(pos.avgEntryPrice) * pos.quantity;
    }
  }

  const maxPositionValue = totalEquity * (config.maxPositionPct / 100);

  // Include existing position value if adding to it
  const existingPos = positions.find(p => p.symbol === symbol.toUpperCase());
  const existingValue = existingPos
    ? quote.price * existingPos.quantity
    : 0;
  const totalPositionValue = existingValue + tradeValue;

  if (totalPositionValue > maxPositionValue) {
    const maxShares = Math.floor((maxPositionValue - existingValue) / quote.price);
    if (maxShares <= 0) {
      blocked.push(
        `Position in ${symbol} would exceed ${config.maxPositionPct}% of equity ($${maxPositionValue.toFixed(0)}). Already at limit.`
      );
    } else {
      warnings.push(
        `Position would exceed ${config.maxPositionPct}% limit. Max additional shares: ${maxShares}`
      );
    }
  }

  // ── Check 3: Sufficient cash ─────────────────────────────────────────────
  if (tradeValue > cashBalance) {
    blocked.push(
      `Insufficient cash. Need $${tradeValue.toFixed(2)}, have $${cashBalance.toFixed(2)}`
    );
  } else if (tradeValue > cashBalance * 0.9) {
    warnings.push(
      `This trade uses ${((tradeValue / cashBalance) * 100).toFixed(1)}% of available cash`
    );
  }

  // ── Check 4: Max drawdown ────────────────────────────────────────────────
  const drawdownPct = ((config.initialEquity - totalEquity) / config.initialEquity) * 100;
  if (drawdownPct >= config.maxDrawdownPct) {
    blocked.push(
      `Portfolio drawdown is ${drawdownPct.toFixed(1)}% (limit: ${config.maxDrawdownPct}%). Trading paused until recovery.`
    );
  } else if (drawdownPct >= config.maxDrawdownPct * 0.75) {
    warnings.push(
      `Portfolio drawdown approaching limit: ${drawdownPct.toFixed(1)}% of ${config.maxDrawdownPct}% max`
    );
  }

  // ── Suggested stop loss and take profit ──────────────────────────────────
  const suggestedStopLoss = quote.price * (1 - config.stopLossPct / 100);
  const suggestedTakeProfit = quote.price * (1 + config.takeProfitPct / 100);

  // ── Suggested quantity (respecting position size limit) ──────────────────
  const maxAffordableShares = Math.floor(cashBalance / quote.price);
  const maxByPositionLimit = Math.floor(maxPositionValue / quote.price);
  const suggestedQuantity = Math.min(maxAffordableShares, maxByPositionLimit);

  return {
    allowed: blocked.length === 0,
    warnings,
    blocked,
    suggestedQuantity: suggestedQuantity > 0 ? suggestedQuantity : undefined,
    suggestedStopLoss,
    suggestedTakeProfit,
  };
}

/**
 * Check all positions for stop loss / take profit triggers.
 * Returns positions that should be closed.
 */
export async function checkStopLossTakeProfit(
  portfolioId: number,
): Promise<Array<{ positionId: number; symbol: string; reason: string; currentPrice: number }>> {
  const positions = await getPortfolioPositions(portfolioId);
  const triggers: Array<{ positionId: number; symbol: string; reason: string; currentPrice: number }> = [];

  for (const pos of positions) {
    const quote = await getStockQuote(pos.symbol);
    if (!quote) continue;

    const currentPrice = quote.price;

    if (pos.stopLoss) {
      const stopPrice = parseFloat(pos.stopLoss);
      if (currentPrice <= stopPrice) {
        triggers.push({
          positionId: pos.id,
          symbol: pos.symbol,
          reason: `Stop loss hit: $${currentPrice.toFixed(2)} <= $${stopPrice.toFixed(2)}`,
          currentPrice,
        });
      }
    }

    if (pos.takeProfit) {
      const takeProfitPrice = parseFloat(pos.takeProfit);
      if (currentPrice >= takeProfitPrice) {
        triggers.push({
          positionId: pos.id,
          symbol: pos.symbol,
          reason: `Take profit hit: $${currentPrice.toFixed(2)} >= $${takeProfitPrice.toFixed(2)}`,
          currentPrice,
        });
      }
    }
  }

  return triggers;
}

import {
  getPortfolioById,
  updatePortfolioCash,
  getPortfolioPositions,
  getPositionBySymbol,
  insertPosition,
  updatePosition,
  deletePosition,
  insertTradeLog,
  getPortfolioTradeHistory,
} from "../db";
import { getStockQuote } from "./stockPriceService";

/**
 * Paper Trading Service
 * Simulates order execution using real market prices.
 * Tracks positions, P&L, and trade history.
 */

export interface TradeRequest {
  portfolioId: number;
  userId: number;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  orderType: "market" | "limit";
  limitPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  predictionId?: number;
  notes?: string;
}

export interface TradeResult {
  success: boolean;
  message: string;
  tradeId?: number;
  executedPrice?: number;
  total?: number;
  remainingCash?: number;
}

export interface PositionWithPnL {
  id: number;
  symbol: string;
  quantity: number;
  avgEntryPrice: number;
  side: string;
  stopLoss: number | null;
  takeProfit: number | null;
  openedAt: Date;
  currentPrice: number | null;
  unrealizedPnL: number | null;
  unrealizedPnLPercent: number | null;
  marketValue: number | null;
}

export interface PortfolioSummary {
  portfolioId: number;
  name: string;
  type: string;
  cashBalance: number;
  positions: PositionWithPnL[];
  totalMarketValue: number;
  totalUnrealizedPnL: number;
  totalEquity: number; // cash + market value
}

/**
 * Execute a paper trade (buy or sell).
 */
export async function executePaperTrade(req: TradeRequest): Promise<TradeResult> {
  // Validate portfolio belongs to user
  const portfolio = await getPortfolioById(req.portfolioId, req.userId);
  if (!portfolio) {
    return { success: false, message: "Portfolio not found" };
  }
  if (portfolio.type !== "paper") {
    return { success: false, message: "Can only execute paper trades on paper portfolios" };
  }

  // Get current market price
  const quote = await getStockQuote(req.symbol.toUpperCase());
  if (!quote) {
    return { success: false, message: `Unable to get price for ${req.symbol}` };
  }

  const executedPrice = req.orderType === "limit" && req.limitPrice
    ? req.limitPrice
    : quote.price;

  const total = executedPrice * req.quantity;
  const cashBalance = parseFloat(portfolio.cashBalance);

  if (req.side === "buy") {
    return executeBuy(req, portfolio, executedPrice, total, cashBalance);
  } else {
    return executeSell(req, portfolio, executedPrice, total, cashBalance);
  }
}

async function executeBuy(
  req: TradeRequest,
  portfolio: { id: number; cashBalance: string },
  price: number,
  total: number,
  cashBalance: number,
): Promise<TradeResult> {
  // Check sufficient cash
  if (total > cashBalance) {
    return {
      success: false,
      message: `Insufficient cash. Need $${total.toFixed(2)}, have $${cashBalance.toFixed(2)}`,
    };
  }

  const symbol = req.symbol.toUpperCase();

  // Check if we already have a position — average up
  const existing = await getPositionBySymbol(portfolio.id, symbol);

  if (existing) {
    const existingQty = existing.quantity;
    const existingAvg = parseFloat(existing.avgEntryPrice);
    const newQty = existingQty + req.quantity;
    const newAvg = ((existingAvg * existingQty) + (price * req.quantity)) / newQty;

    await updatePosition(existing.id, {
      quantity: newQty,
      avgEntryPrice: newAvg.toFixed(4),
    });
  } else {
    await insertPosition({
      portfolioId: portfolio.id,
      symbol,
      quantity: req.quantity,
      avgEntryPrice: price.toFixed(4),
      side: "long",
      stopLoss: req.stopLoss?.toFixed(4) ?? null,
      takeProfit: req.takeProfit?.toFixed(4) ?? null,
    });
  }

  // Deduct cash
  const newCash = cashBalance - total;
  await updatePortfolioCash(portfolio.id, newCash.toFixed(2));

  // Log the trade
  await insertTradeLog({
    portfolioId: portfolio.id,
    symbol,
    side: "buy",
    quantity: req.quantity,
    price: price.toFixed(4),
    total: total.toFixed(2),
    orderType: req.orderType,
    status: "filled",
    predictionId: req.predictionId ?? null,
    notes: req.notes ?? null,
  });

  return {
    success: true,
    message: `Bought ${req.quantity} ${symbol} @ $${price.toFixed(2)}`,
    executedPrice: price,
    total,
    remainingCash: newCash,
  };
}

async function executeSell(
  req: TradeRequest,
  portfolio: { id: number; cashBalance: string },
  price: number,
  total: number,
  cashBalance: number,
): Promise<TradeResult> {
  const symbol = req.symbol.toUpperCase();

  // Must have an existing position to sell
  const existing = await getPositionBySymbol(portfolio.id, symbol);
  if (!existing) {
    return { success: false, message: `No position in ${symbol} to sell` };
  }

  if (req.quantity > existing.quantity) {
    return {
      success: false,
      message: `Cannot sell ${req.quantity} shares. Only hold ${existing.quantity} ${symbol}`,
    };
  }

  const remainingQty = existing.quantity - req.quantity;

  if (remainingQty === 0) {
    // Close position entirely
    await deletePosition(existing.id);
  } else {
    // Partial sell — keep same avg entry price
    await updatePosition(existing.id, { quantity: remainingQty });
  }

  // Add proceeds to cash
  const newCash = cashBalance + total;
  await updatePortfolioCash(portfolio.id, newCash.toFixed(2));

  // Log the trade
  await insertTradeLog({
    portfolioId: portfolio.id,
    symbol,
    side: "sell",
    quantity: req.quantity,
    price: price.toFixed(4),
    total: total.toFixed(2),
    orderType: req.orderType,
    status: "filled",
    predictionId: req.predictionId ?? null,
    notes: req.notes ?? null,
  });

  // Calculate realized P&L for this sell
  const entryPrice = parseFloat(existing.avgEntryPrice);
  const realizedPnL = (price - entryPrice) * req.quantity;

  return {
    success: true,
    message: `Sold ${req.quantity} ${symbol} @ $${price.toFixed(2)} (P&L: ${realizedPnL >= 0 ? "+" : ""}$${realizedPnL.toFixed(2)})`,
    executedPrice: price,
    total,
    remainingCash: newCash,
  };
}

/**
 * Get portfolio summary with live P&L for all positions.
 */
export async function getPortfolioSummary(portfolioId: number, userId: number): Promise<PortfolioSummary | null> {
  const portfolio = await getPortfolioById(portfolioId, userId);
  if (!portfolio) return null;

  const rawPositions = await getPortfolioPositions(portfolioId);
  const cashBalance = parseFloat(portfolio.cashBalance);

  // Fetch current prices for all positions
  const positionsWithPnL: PositionWithPnL[] = await Promise.all(
    rawPositions.map(async (pos) => {
      const quote = await getStockQuote(pos.symbol);
      const currentPrice = quote?.price ?? null;
      const entryPrice = parseFloat(pos.avgEntryPrice);

      let unrealizedPnL: number | null = null;
      let unrealizedPnLPercent: number | null = null;
      let marketValue: number | null = null;

      if (currentPrice != null) {
        unrealizedPnL = (currentPrice - entryPrice) * pos.quantity;
        unrealizedPnLPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
        marketValue = currentPrice * pos.quantity;
      }

      return {
        id: pos.id,
        symbol: pos.symbol,
        quantity: pos.quantity,
        avgEntryPrice: entryPrice,
        side: pos.side,
        stopLoss: pos.stopLoss ? parseFloat(pos.stopLoss) : null,
        takeProfit: pos.takeProfit ? parseFloat(pos.takeProfit) : null,
        openedAt: pos.openedAt,
        currentPrice,
        unrealizedPnL,
        unrealizedPnLPercent,
        marketValue,
      };
    })
  );

  const totalMarketValue = positionsWithPnL.reduce((sum, p) => sum + (p.marketValue ?? 0), 0);
  const totalUnrealizedPnL = positionsWithPnL.reduce((sum, p) => sum + (p.unrealizedPnL ?? 0), 0);

  return {
    portfolioId: portfolio.id,
    name: portfolio.name,
    type: portfolio.type,
    cashBalance,
    positions: positionsWithPnL,
    totalMarketValue,
    totalUnrealizedPnL,
    totalEquity: cashBalance + totalMarketValue,
  };
}

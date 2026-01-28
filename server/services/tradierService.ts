import { ENV } from "../_core/env";

/**
 * Tradier API Service
 * Provides real-time options data, stock quotes, and market information
 * Documentation: https://documentation.tradier.com/brokerage-api
 */

export interface TradierStockQuote {
  symbol: string;
  last: number;
  change: number;
  changePercent: number;
  volume: number;
  open: number;
  high: number;
  low: number;
  close: number;
  bid: number;
  ask: number;
}

export interface TradierOptionContract {
  symbol: string; // Option symbol (e.g., "AAPL240119C00150000")
  rootSymbol: string; // Underlying ticker
  underlying: string;
  strike: number;
  type: "call" | "put";
  expiration: string; // YYYY-MM-DD
  last: number;
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  volume: number;
  openInterest: number;
  impliedVolatility?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  rho?: number;
}

export interface TradierOptionsChain {
  underlying: string;
  currentPrice: number;
  expirations: string[];
  options: TradierOptionContract[];
}

export interface TradierExpiration {
  date: string; // YYYY-MM-DD
  daysToExpiration: number;
}

/**
 * Get a stock quote from Tradier
 */
export async function getTradierQuote(symbol: string): Promise<TradierStockQuote | null> {
  try {
    if (!ENV.tradierApiKey) {
      console.warn("[Tradier] API key not configured");
      return null;
    }

    const url = `${ENV.tradierApiUrl}/quotes?symbols=${symbol}&greeks=false`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${ENV.tradierApiKey}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      console.error(`[Tradier] Quote API error: ${response.status} ${response.statusText}`);
      return null;
    }

    const data = await response.json();
    const quote = data.quotes?.quote;

    if (!quote) {
      console.warn(`[Tradier] No quote data for ${symbol}`);
      return null;
    }

    return {
      symbol: quote.symbol,
      last: quote.last || 0,
      change: quote.change || 0,
      changePercent: quote.change_percentage || 0,
      volume: quote.volume || 0,
      open: quote.open || 0,
      high: quote.high || 0,
      low: quote.low || 0,
      close: quote.close || quote.last || 0,
      bid: quote.bid || 0,
      ask: quote.ask || 0,
    };
  } catch (error) {
    console.error(`[Tradier] Error fetching quote for ${symbol}:`, error);
    return null;
  }
}

/**
 * Get all available expiration dates for a symbol
 */
export async function getTradierExpirations(symbol: string): Promise<TradierExpiration[]> {
  try {
    if (!ENV.tradierApiKey) {
      console.warn("[Tradier] API key not configured");
      return [];
    }

    const url = `${ENV.tradierApiUrl}/options/expirations?symbol=${symbol}&includeAllRoots=true&strikes=false`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${ENV.tradierApiKey}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      console.error(`[Tradier] Expirations API error: ${response.status}`);
      return [];
    }

    const data = await response.json();
    const dates = data.expirations?.date || [];

    const today = new Date();
    return dates.map((dateStr: string) => {
      const expDate = new Date(dateStr);
      const daysToExp = Math.ceil((expDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
      return {
        date: dateStr,
        daysToExpiration: daysToExp,
      };
    });
  } catch (error) {
    console.error(`[Tradier] Error fetching expirations for ${symbol}:`, error);
    return [];
  }
}

/**
 * Get options chain for a specific expiration date
 */
export async function getTradierOptionsChain(
  symbol: string,
  expiration: string,
  includeGreeks: boolean = true
): Promise<TradierOptionsChain | null> {
  try {
    if (!ENV.tradierApiKey) {
      console.warn("[Tradier] API key not configured");
      return null;
    }

    // First, get the current stock price
    const quote = await getTradierQuote(symbol);
    if (!quote) {
      console.warn(`[Tradier] Could not get quote for ${symbol}`);
      return null;
    }

    // Get the options chain
    const url = `${ENV.tradierApiUrl}/options/chains?symbol=${symbol}&expiration=${expiration}&greeks=${includeGreeks}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${ENV.tradierApiKey}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      console.error(`[Tradier] Options chain API error: ${response.status}`);
      return null;
    }

    const data = await response.json();
    const options = data.options?.option || [];

    if (!Array.isArray(options)) {
      console.warn(`[Tradier] No options data for ${symbol} expiring ${expiration}`);
      return null;
    }

    const contracts: TradierOptionContract[] = options.map((opt: any) => ({
      symbol: opt.symbol,
      rootSymbol: opt.root_symbol,
      underlying: opt.underlying,
      strike: opt.strike,
      type: opt.option_type,
      expiration: opt.expiration_date,
      last: opt.last || 0,
      bid: opt.bid || 0,
      ask: opt.ask || 0,
      bidSize: opt.bidsize || 0,
      askSize: opt.asksize || 0,
      volume: opt.volume || 0,
      openInterest: opt.open_interest || 0,
      impliedVolatility: opt.greeks?.smv_vol,
      delta: opt.greeks?.delta,
      gamma: opt.greeks?.gamma,
      theta: opt.greeks?.theta,
      vega: opt.greeks?.vega,
      rho: opt.greeks?.rho,
    }));

    return {
      underlying: symbol,
      currentPrice: quote.last,
      expirations: [expiration],
      options: contracts,
    };
  } catch (error) {
    console.error(`[Tradier] Error fetching options chain for ${symbol}:`, error);
    return null;
  }
}

/**
 * Find the best strikes around a target price (ATM, OTM, ITM)
 */
export function findOptimalStrikes(
  options: TradierOptionContract[],
  currentPrice: number,
  optionType: "call" | "put",
  count: number = 5
): TradierOptionContract[] {
  const filtered = options.filter((opt) => opt.type === optionType);

  // Sort by how close to ATM
  const sorted = filtered.sort((a, b) => {
    const diffA = Math.abs(a.strike - currentPrice);
    const diffB = Math.abs(b.strike - currentPrice);
    return diffA - diffB;
  });

  return sorted.slice(0, count);
}

/**
 * Find strikes with good liquidity (high open interest and volume)
 */
export function findLiquidStrikes(
  options: TradierOptionContract[],
  minOpenInterest: number = 100
): TradierOptionContract[] {
  return options
    .filter((opt) => opt.openInterest >= minOpenInterest)
    .sort((a, b) => b.openInterest - a.openInterest);
}

/**
 * Calculate probability of profit for an option
 * Formula: For calls, probability that stock closes above breakeven
 * Breakeven = Strike + Premium (for calls)
 * Uses delta as approximation for probability
 */
export function calculateProbabilityOfProfit(
  contract: TradierOptionContract,
  currentPrice: number
): number {
  // Delta approximates the probability the option expires ITM
  // For calls: ~probability stock closes above strike
  // For puts: ~probability stock closes below strike
  if (contract.delta) {
    // Delta for calls is 0 to 1, for puts -1 to 0
    const probability = Math.abs(contract.delta) * 100;
    return Math.round(probability);
  }

  // Fallback: Rough estimate based on moneyness
  const moneyness = contract.strike / currentPrice;

  if (contract.type === "call") {
    if (moneyness < 0.95) return 70; // Deep ITM
    if (moneyness < 1.0) return 60; // ITM
    if (moneyness < 1.05) return 50; // ATM
    if (moneyness < 1.1) return 40; // OTM
    return 30; // Deep OTM
  } else {
    // Put
    if (moneyness > 1.05) return 70; // Deep ITM
    if (moneyness > 1.0) return 60; // ITM
    if (moneyness > 0.95) return 50; // ATM
    if (moneyness > 0.9) return 40; // OTM
    return 30; // Deep OTM
  }
}

/**
 * Calculate break-even price for an option
 */
export function calculateBreakEven(contract: TradierOptionContract): number {
  const premium = (contract.bid + contract.ask) / 2 || contract.last;

  if (contract.type === "call") {
    return contract.strike + premium;
  } else {
    return contract.strike - premium;
  }
}

/**
 * Recommend the best option contract based on confidence level
 */
export async function recommendOption(
  symbol: string,
  optionType: "call" | "put",
  confidence: number,
  timeframe: string
): Promise<{
  contract: TradierOptionContract | null;
  reasoning: string;
  alternativeContracts: TradierOptionContract[];
} | null> {
  try {
    // Get current price
    const quote = await getTradierQuote(symbol);
    if (!quote) {
      return null;
    }

    // Determine target expiration based on timeframe
    let targetDaysOut = 30;
    if (timeframe.includes("2-3 weeks")) targetDaysOut = 21;
    else if (timeframe.includes("1-2 months")) targetDaysOut = 45;
    else if (timeframe.includes("3-6 months")) targetDaysOut = 90;

    // Get expirations
    const expirations = await getTradierExpirations(symbol);
    if (expirations.length === 0) {
      return null;
    }

    // Find closest expiration to target
    const targetExpiration = expirations.reduce((closest, exp) => {
      const diff = Math.abs(exp.daysToExpiration - targetDaysOut);
      const closestDiff = Math.abs(closest.daysToExpiration - targetDaysOut);
      return diff < closestDiff ? exp : closest;
    });

    // Get options chain
    const chain = await getTradierOptionsChain(symbol, targetExpiration.date, true);
    if (!chain) {
      return null;
    }

    // Filter by option type and liquidity
    const liquidOptions = findLiquidStrikes(
      chain.options.filter((opt) => opt.type === optionType),
      50 // Minimum open interest
    );

    if (liquidOptions.length === 0) {
      return null;
    }

    // Select strike based on confidence
    let selectedContract: TradierOptionContract | null = null;
    let reasoning = "";

    if (confidence >= 75) {
      // High confidence: ATM or slightly ITM
      const atmOptions = findOptimalStrikes(liquidOptions, quote.last, optionType, 3);
      selectedContract = atmOptions[0];
      reasoning = `High confidence (${confidence}%) → ATM/ITM option for higher probability of profit`;
    } else if (confidence >= 50) {
      // Medium confidence: OTM 5-10%
      const targetStrike =
        optionType === "call" ? quote.last * 1.05 : quote.last * 0.95;
      const otmOptions = liquidOptions.sort(
        (a, b) => Math.abs(a.strike - targetStrike) - Math.abs(b.strike - targetStrike)
      );
      selectedContract = otmOptions[0];
      reasoning = `Medium confidence (${confidence}%) → OTM option for better risk/reward`;
    } else {
      // Lower confidence: Further OTM or suggest spreads
      const targetStrike =
        optionType === "call" ? quote.last * 1.1 : quote.last * 0.9;
      const otmOptions = liquidOptions.sort(
        (a, b) => Math.abs(a.strike - targetStrike) - Math.abs(b.strike - targetStrike)
      );
      selectedContract = otmOptions[0];
      reasoning = `Lower confidence (${confidence}%) → Far OTM option or consider spreads to limit risk`;
    }

    // Get alternative contracts
    const alternatives = findOptimalStrikes(liquidOptions, quote.last, optionType, 5).filter(
      (opt) => opt.symbol !== selectedContract?.symbol
    );

    return {
      contract: selectedContract,
      reasoning,
      alternativeContracts: alternatives,
    };
  } catch (error) {
    console.error(`[Tradier] Error recommending option for ${symbol}:`, error);
    return null;
  }
}

/**
 * Format option data for display
 */
export function formatOptionDisplay(contract: TradierOptionContract): string {
  const premium = (contract.bid + contract.ask) / 2 || contract.last;
  const breakEven = calculateBreakEven(contract);
  const cost = premium * 100; // Cost per contract

  return `
Strike: $${contract.strike}
Premium: $${premium.toFixed(2)} ($${cost.toFixed(0)} per contract)
Break-even: $${breakEven.toFixed(2)}
Open Interest: ${contract.openInterest}
Volume: ${contract.volume}
IV: ${contract.impliedVolatility ? (contract.impliedVolatility * 100).toFixed(1) + "%" : "N/A"}
Delta: ${contract.delta ? contract.delta.toFixed(3) : "N/A"}
Theta: ${contract.theta ? contract.theta.toFixed(3) : "N/A"}
`.trim();
}

import axios from "axios";

/**
 * SEC EDGAR Service
 * Free, no API key required. Provides insider trading (Form 4),
 * company filings (10-K, 10-Q, 8-K), and company facts.
 *
 * SEC requires a User-Agent header with your name/email.
 * Rate limit: 10 requests/second.
 */

const SEC_BASE = "https://efts.sec.gov/LATEST";
const EDGAR_DATA = "https://data.sec.gov";
const USER_AGENT = "TradingAgent/1.0 (trading-agent@example.com)";

const secClient = axios.create({
  headers: {
    "User-Agent": USER_AGENT,
    Accept: "application/json",
  },
  timeout: 15_000,
});

// Rate limiter: max 10 req/sec
let lastRequestTime = 0;
async function rateLimitedGet<T>(url: string): Promise<T | null> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < 100) { // 100ms = 10/sec
    await new Promise(r => setTimeout(r, 100 - elapsed));
  }
  lastRequestTime = Date.now();

  try {
    const res = await secClient.get<T>(url);
    return res.data;
  } catch (error: any) {
    console.error(`[SEC EDGAR] Error fetching ${url}:`, error.message);
    return null;
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface InsiderTransaction {
  ownerName: string;
  ownerTitle: string;
  transactionDate: string;
  transactionType: "purchase" | "sale" | "other";
  sharesTraded: number;
  pricePerShare: number | null;
  totalValue: number | null;
  sharesOwnedAfter: number | null;
  filingDate: string;
  ticker: string;
}

export interface RecentFiling {
  type: string; // "10-K", "10-Q", "8-K", "4", etc.
  filingDate: string;
  description: string;
  url: string;
}

export interface CompanyInfo {
  cik: string;
  name: string;
  ticker: string;
  sic: string;
  sicDescription: string;
  stateOfIncorporation: string;
}

// ── CIK Lookup ───────────────────────────────────────────────────────────────

// Cache ticker → CIK mappings
const cikCache = new Map<string, string>();

/**
 * Look up SEC CIK number for a ticker symbol.
 */
export async function getCIK(ticker: string): Promise<string | null> {
  const upper = ticker.toUpperCase();
  if (cikCache.has(upper)) return cikCache.get(upper)!;

  const data = await rateLimitedGet<Record<string, any>>(
    `${EDGAR_DATA}/submissions/CIK${upper}.json`
  );

  // Fallback: search by company ticker
  if (!data) {
    const search = await rateLimitedGet<any>(
      `${SEC_BASE}/search-index?q=%22${upper}%22&dateRange=custom&startdt=2024-01-01&forms=4,10-K,10-Q`
    );
    if (search?.hits?.hits?.[0]?._source?.entity_id) {
      const cik = search.hits.hits[0]._source.entity_id;
      cikCache.set(upper, cik);
      return cik;
    }
    return null;
  }

  const cik = data.cik?.toString().padStart(10, "0");
  if (cik) cikCache.set(upper, cik);
  return cik || null;
}

// ── Insider Trading (Form 4) ─────────────────────────────────────────────────

/**
 * Get recent insider transactions for a stock via EDGAR full-text search.
 */
export async function getInsiderTransactions(
  ticker: string,
  limit: number = 20,
): Promise<InsiderTransaction[]> {
  try {
    const data = await rateLimitedGet<any>(
      `${SEC_BASE}/search-index?q=%22${ticker.toUpperCase()}%22&forms=4&dateRange=custom&startdt=${getDateNDaysAgo(90)}&enddt=${getToday()}`
    );

    if (!data?.hits?.hits) return [];

    const transactions: InsiderTransaction[] = [];

    for (const hit of data.hits.hits.slice(0, limit)) {
      const source = hit._source;
      if (!source) continue;

      transactions.push({
        ownerName: source.display_names?.[0] || "Unknown",
        ownerTitle: source.display_description || "",
        transactionDate: source.file_date || "",
        transactionType: inferTransactionType(source.display_description || ""),
        sharesTraded: 0, // Would need to parse the actual XML filing for exact shares
        pricePerShare: null,
        totalValue: null,
        sharesOwnedAfter: null,
        filingDate: source.file_date || "",
        ticker: ticker.toUpperCase(),
      });
    }

    return transactions;
  } catch (error) {
    console.error(`[SEC EDGAR] Error fetching insider transactions for ${ticker}:`, error);
    return [];
  }
}

/**
 * Get recent company filings (10-K, 10-Q, 8-K, etc.)
 */
export async function getRecentFilings(
  ticker: string,
  forms: string = "10-K,10-Q,8-K",
  limit: number = 10,
): Promise<RecentFiling[]> {
  try {
    const data = await rateLimitedGet<any>(
      `${SEC_BASE}/search-index?q=%22${ticker.toUpperCase()}%22&forms=${forms}&dateRange=custom&startdt=${getDateNDaysAgo(365)}&enddt=${getToday()}`
    );

    if (!data?.hits?.hits) return [];

    return data.hits.hits.slice(0, limit).map((hit: any) => {
      const source = hit._source;
      return {
        type: source.form_type || "Unknown",
        filingDate: source.file_date || "",
        description: source.display_description || source.form_type || "",
        url: source.file_url
          ? `https://www.sec.gov/Archives/edgar/data/${source.entity_id}/${source.file_url}`
          : "",
      };
    });
  } catch (error) {
    console.error(`[SEC EDGAR] Error fetching filings for ${ticker}:`, error);
    return [];
  }
}

/**
 * Get insider trading summary for multiple stocks.
 * Returns a concise text suitable for LLM prompt injection.
 */
export async function getInsiderSummaryForPrompt(tickers: string[]): Promise<string> {
  const summaries: string[] = [];

  for (const ticker of tickers.slice(0, 10)) {
    const transactions = await getInsiderTransactions(ticker, 5);
    if (transactions.length === 0) continue;

    const buys = transactions.filter(t => t.transactionType === "purchase").length;
    const sells = transactions.filter(t => t.transactionType === "sale").length;

    summaries.push(
      `${ticker}: ${transactions.length} insider filings (last 90d) — ${buys} purchases, ${sells} sales`
    );

    // Include notable names
    const names = transactions.slice(0, 3).map(t =>
      `  ${t.ownerName} (${t.transactionType}) on ${t.transactionDate}`
    );
    summaries.push(names.join("\n"));
  }

  if (summaries.length === 0) return "";

  return "INSIDER TRADING ACTIVITY (SEC Form 4):\n" + summaries.join("\n");
}

/**
 * Get recent 8-K filings summary (material events) for LLM prompt.
 */
export async function getMaterialEventsSummary(tickers: string[]): Promise<string> {
  const events: string[] = [];

  for (const ticker of tickers.slice(0, 10)) {
    const filings = await getRecentFilings(ticker, "8-K", 3);
    if (filings.length === 0) continue;

    events.push(`${ticker} recent 8-K filings:`);
    for (const f of filings) {
      events.push(`  ${f.filingDate}: ${f.description}`);
    }
  }

  if (events.length === 0) return "";

  return "MATERIAL EVENTS (SEC 8-K Filings):\n" + events.join("\n");
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function inferTransactionType(description: string): "purchase" | "sale" | "other" {
  const lower = description.toLowerCase();
  if (lower.includes("purchase") || lower.includes("acquisition") || lower.includes("buy")) {
    return "purchase";
  }
  if (lower.includes("sale") || lower.includes("disposition") || lower.includes("sell")) {
    return "sale";
  }
  return "other";
}

function getToday(): string {
  return new Date().toISOString().split("T")[0]!;
}

function getDateNDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split("T")[0]!;
}

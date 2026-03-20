import axios from "axios";

/**
 * SEC EDGAR Service
 * Free, no API key required. Provides insider trading (Form 4),
 * company filings (10-K, 10-Q, 8-K), and company facts.
 *
 * SEC requires a User-Agent header with your name/email.
 * Rate limit: 10 requests/second.
 */

const EDGAR_DATA = "https://data.sec.gov";
const EDGAR_ARCHIVES = "https://www.sec.gov/Archives/edgar/data";
const USER_AGENT = "TradingAgent/1.0 (trading-agent@example.com)";

const secClient = axios.create({
  headers: {
    "User-Agent": USER_AGENT,
    Accept: "application/json",
  },
  timeout: 15_000,
});

const xmlClient = axios.create({
  headers: {
    "User-Agent": USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/xml,*/*",
  },
  timeout: 15_000,
});

// Rate limiter: max 8 req/sec (conservative)
let lastRequestTime = 0;
async function rateLimitedGet<T>(url: string, useXmlClient = false): Promise<T | null> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < 125) {
    await new Promise(r => setTimeout(r, 125 - elapsed));
  }
  lastRequestTime = Date.now();

  try {
    const client = useXmlClient ? xmlClient : secClient;
    const res = await client.get<T>(url);
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
  type: string;
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

const cikCache = new Map<string, string>();
let tickerToCikMap: Record<string, string> | null = null;

async function loadTickerMap(): Promise<Record<string, string>> {
  if (tickerToCikMap) return tickerToCikMap;
  try {
    const data = await rateLimitedGet<Record<string, { cik_str: string; ticker: string; title: string }>>(
      "https://www.sec.gov/files/company_tickers.json"
    );
    if (!data) return {};
    const map: Record<string, string> = {};
    for (const entry of Object.values(data)) {
      map[entry.ticker.toUpperCase()] = entry.cik_str.toString().padStart(10, "0");
    }
    tickerToCikMap = map;
    return map;
  } catch {
    return {};
  }
}

export async function getCIK(ticker: string): Promise<string | null> {
  const upper = ticker.toUpperCase();
  if (cikCache.has(upper)) return cikCache.get(upper)!;

  const map = await loadTickerMap();
  const cik = map[upper];
  if (cik) {
    cikCache.set(upper, cik);
    return cik;
  }
  return null;
}

// ── Form 4 XML Parser ─────────────────────────────────────────────────────────

function extractXmlValue(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>\\s*([^<]*)\\s*</${tag}>`, "i");
  const m = xml.match(re);
  return m?.[1]?.trim() || null;
}

function extractXmlBlock(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = xml.match(re);
  return m?.[1] || null;
}

function extractAllXmlBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  const results: string[] = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    results.push(m[1]);
  }
  return results;
}

function parseTransactionCode(code: string | null): "purchase" | "sale" | "other" {
  if (!code) return "other";
  const c = code.trim().toUpperCase();
  if (c === "P") return "purchase";
  if (c === "S" || c === "D") return "sale";
  if (c === "A") return "other"; // award/grant
  return "other";
}

async function parseForm4Xml(
  xmlText: string,
  ticker: string,
  filingDate: string,
): Promise<InsiderTransaction[]> {
  const transactions: InsiderTransaction[] = [];

  // Owner info
  const ownerBlock = extractXmlBlock(xmlText, "reportingOwner");
  const ownerName = extractXmlValue(ownerBlock || xmlText, "rptOwnerName") || "Unknown";
  const ownerTitle =
    extractXmlValue(ownerBlock || xmlText, "officerTitle") ||
    extractXmlValue(ownerBlock || xmlText, "relationship") ||
    "";

  // Non-derivative transactions (actual stock buys/sells)
  const ndTable = extractXmlBlock(xmlText, "nonDerivativeTable");
  if (ndTable) {
    const txBlocks = extractAllXmlBlocks(ndTable, "nonDerivativeTransaction");
    for (const txBlock of txBlocks) {
      const txDate = extractXmlValue(txBlock, "transactionDate") || filingDate;
      const txCode = extractXmlValue(txBlock, "transactionCode");
      const shares = parseFloat(extractXmlValue(txBlock, "transactionShares") || "0") || 0;
      const priceRaw = extractXmlValue(txBlock, "transactionPricePerShare");
      const price = priceRaw ? parseFloat(priceRaw) || null : null;
      const sharesAfterRaw = extractXmlValue(txBlock, "sharesOwnedFollowingTransaction");
      const sharesAfter = sharesAfterRaw ? parseFloat(sharesAfterRaw) || null : null;

      transactions.push({
        ownerName,
        ownerTitle,
        transactionDate: txDate,
        transactionType: parseTransactionCode(txCode),
        sharesTraded: shares,
        pricePerShare: price,
        totalValue: price && shares ? Math.round(price * shares) : null,
        sharesOwnedAfter: sharesAfter,
        filingDate,
        ticker: ticker.toUpperCase(),
      });
    }
  }

  // If no non-derivative transactions, create one entry from metadata
  if (transactions.length === 0) {
    transactions.push({
      ownerName,
      ownerTitle,
      transactionDate: filingDate,
      transactionType: "other",
      sharesTraded: 0,
      pricePerShare: null,
      totalValue: null,
      sharesOwnedAfter: null,
      filingDate,
      ticker: ticker.toUpperCase(),
    });
  }

  return transactions;
}

// ── Insider Trading (Form 4) ─────────────────────────────────────────────────

export async function getInsiderTransactions(
  ticker: string,
  limit: number = 20,
): Promise<InsiderTransaction[]> {
  try {
    const cik = await getCIK(ticker);
    if (!cik) {
      console.warn(`[SEC EDGAR] CIK not found for ${ticker}`);
      return [];
    }

    // Fetch the company's submission history
    const submissions = await rateLimitedGet<any>(
      `${EDGAR_DATA}/submissions/CIK${cik}.json`
    );
    if (!submissions?.filings?.recent) return [];

    const { form, filingDate, accessionNumber, primaryDocument } = submissions.filings.recent;

    // Find Form 4 indices (most recent first)
    const form4Indices: number[] = [];
    for (let i = 0; i < form.length; i++) {
      if (form[i] === "4" || form[i] === "4/A") {
        form4Indices.push(i);
        if (form4Indices.length >= limit) break;
      }
    }

    if (form4Indices.length === 0) return [];

    const cikNum = parseInt(cik, 10).toString(); // numeric CIK without leading zeros
    const allTransactions: InsiderTransaction[] = [];

    // Fetch each Form 4 XML (limit to 12 to avoid too many requests)
    for (const idx of form4Indices.slice(0, 12)) {
      const accNum = accessionNumber[idx]?.replace(/-/g, "");
      const primaryDoc = primaryDocument[idx];
      const fDate = filingDate[idx] || "";

      if (!accNum || !primaryDoc) continue;

      const xmlUrl = `${EDGAR_ARCHIVES}/${cikNum}/${accNum}/${primaryDoc}`;
      const xmlText = await rateLimitedGet<string>(xmlUrl, true);
      if (!xmlText || typeof xmlText !== "string") continue;

      const txs = await parseForm4Xml(xmlText, ticker, fDate);
      allTransactions.push(...txs);

      if (allTransactions.length >= limit) break;
    }

    return allTransactions.slice(0, limit);
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
    const cik = await getCIK(ticker);
    if (!cik) return [];

    const submissions = await rateLimitedGet<any>(
      `${EDGAR_DATA}/submissions/CIK${cik}.json`
    );
    if (!submissions?.filings?.recent) return [];

    const { form, filingDate, accessionNumber, primaryDocument } = submissions.filings.recent;
    const formSet = new Set(forms.split(",").map(f => f.trim().toUpperCase()));

    const results: RecentFiling[] = [];
    const cikNum = parseInt(cik, 10).toString();

    for (let i = 0; i < form.length && results.length < limit; i++) {
      if (!formSet.has(form[i]?.toUpperCase())) continue;
      const accNum = accessionNumber[i]?.replace(/-/g, "");
      results.push({
        type: form[i],
        filingDate: filingDate[i] || "",
        description: `${form[i]} filed ${filingDate[i] || ""}`,
        url: accNum
          ? `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accNum}/${primaryDocument[i]}`
          : "",
      });
    }

    return results;
  } catch (error) {
    console.error(`[SEC EDGAR] Error fetching filings for ${ticker}:`, error);
    return [];
  }
}

/**
 * Get insider trading summary for multiple stocks (for LLM prompt injection).
 */
export async function getInsiderSummaryForPrompt(tickers: string[]): Promise<string> {
  const summaries: string[] = [];

  for (const ticker of tickers.slice(0, 10)) {
    const transactions = await getInsiderTransactions(ticker, 5);
    if (transactions.length === 0) continue;

    const buys = transactions.filter(t => t.transactionType === "purchase");
    const sells = transactions.filter(t => t.transactionType === "sale");

    summaries.push(
      `${ticker}: ${transactions.length} insider filings (90d) — ${buys.length} purchases, ${sells.length} sales`
    );

    const notable = buys.slice(0, 3).map(t =>
      `  ${t.ownerName} (${t.ownerTitle || "Insider"}) bought ${t.sharesTraded.toLocaleString()} shares` +
      (t.pricePerShare ? ` @ $${t.pricePerShare.toFixed(2)}` : "") +
      ` on ${t.transactionDate}`
    );
    if (notable.length > 0) summaries.push(notable.join("\n"));
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

function getToday(): string {
  return new Date().toISOString().split("T")[0]!;
}

function getDateNDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split("T")[0]!;
}

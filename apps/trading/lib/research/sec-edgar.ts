import "server-only";

// SEC EDGAR (2026-11-28, user call: "go with SEC EDGAR"). Free, complete, time-stamped
// company events and fundamentals — the historical news context Benzinga-via-Alpaca
// cannot supply before 2026. Two research kinds:
//   sec-filings: every filing for each symbol (form, filing date, acceptance time, 8-K
//                item numbers such as 2.02 = results of operations, i.e. earnings).
//   sec-facts:   quarterly fundamentals from XBRL company facts (revenue, EPS, net
//                income, operating cash flow), each with the date it was FILED, so a
//                model only sees numbers that were public at the time.
// The SEC requires automated clients to identify themselves ("Name contact@domain");
// that string comes ONLY from the SEC_USER_AGENT environment variable, which the owner
// sets in Vercel. Without it the job fails loudly rather than sending a made-up identity.
// The SEC's fair-access limit is 10 requests per second; these jobs stay far below it.

const SEC_WWW = "https://www.sec.gov";
const SEC_DATA = "https://data.sec.gov";

function secHeaders(): Record<string, string> {
  const agent = (process.env.SEC_USER_AGENT ?? "").trim();
  if (!agent || !agent.includes("@")) throw new Error("SEC_USER_AGENT is not set (the SEC requires a contact like \"Name email@domain\"); add it in Vercel to enable EDGAR research");
  return { "User-Agent": agent, "Accept-Encoding": "gzip, deflate" };
}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function secJson<T>(url: string, deadline: number): Promise<T> {
  if (Date.now() > deadline) throw new Error("sec: time budget exhausted — request fewer symbols");
  await pause(150); // ~6 requests/second at most
  const response = await fetch(url, { headers: secHeaders(), cache: "no-store", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`sec: ${response.status} for ${url.replace(SEC_DATA, "").replace(SEC_WWW, "")}`);
  return response.json() as Promise<T>;
}

let tickerMap: { at: number; map: Map<string, number> } | null = null;
async function cikFor(symbol: string, deadline: number): Promise<number | null> {
  if (!tickerMap || Date.now() - tickerMap.at > 24 * 3_600_000) {
    const raw = await secJson<Record<string, { cik_str: number; ticker: string }>>(`${SEC_WWW}/files/company_tickers.json`, deadline);
    tickerMap = { at: Date.now(), map: new Map(Object.values(raw).map(row => [String(row.ticker).toUpperCase(), Number(row.cik_str)])) };
  }
  return tickerMap.map.get(symbol.toUpperCase()) ?? null;
}
const pad = (cik: number) => String(cik).padStart(10, "0");

type FilingColumns = { accessionNumber: string[]; filingDate: string[]; acceptanceDateTime: string[]; form: string[]; items: string[]; primaryDocument: string[] };
export type SecFiling = { sym: string; cik: number; form: string; filed: string; accepted: string; items: string; acc: string; doc: string };

// Every filing since `since` (YYYY-MM-DD). acceptanceDateTime is kept exactly as the SEC
// publishes it; convert it to a time zone only after checking it against a known event.
export async function fetchSecFilings(params: Record<string, unknown>, deadline: number): Promise<{ filings: SecFiling[]; missing: string[] }> {
  const symbols = Array.isArray(params.symbols) ? params.symbols.map(String).slice(0, 10) : [];
  const since = String(params.since ?? "2023-12-01");
  if (!symbols.length) throw new Error("sec-filings: params.symbols required");
  const filings: SecFiling[] = []; const missing: string[] = [];
  for (const sym of symbols) {
    const cik = await cikFor(sym, deadline);
    if (!cik) { missing.push(sym); continue; }
    const root = await secJson<{ filings: { recent: FilingColumns; files?: Array<{ name: string; filingTo: string }> } }>(`${SEC_DATA}/submissions/CIK${pad(cik)}.json`, deadline);
    const pages: FilingColumns[] = [root.filings.recent];
    for (const file of root.filings.files ?? []) if (file.filingTo >= since) pages.push(await secJson<FilingColumns>(`${SEC_DATA}/submissions/${file.name}`, deadline));
    for (const page of pages) {
      for (let i = 0; i < (page.accessionNumber ?? []).length; i++) {
        if (page.filingDate[i] < since) continue;
        filings.push({ sym, cik, form: page.form[i], filed: page.filingDate[i], accepted: page.acceptanceDateTime[i], items: page.items?.[i] ?? "", acc: page.accessionNumber[i], doc: page.primaryDocument?.[i] ?? "" });
      }
    }
  }
  return { filings, missing };
}

const FACT_TAGS = ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "NetIncomeLoss", "EarningsPerShareDiluted", "OperatingIncomeLoss", "NetCashProvidedByUsedInOperatingActivities"];
export type SecFact = { sym: string; tag: string; unit: string; start: string | null; end: string; value: number; form: string; filed: string; fp: string; fy: number | null };

// Quarterly and annual values for a handful of core tags, each carrying the date its
// filing was made public (`filed`) so models can avoid using numbers before they existed.
export async function fetchSecFacts(params: Record<string, unknown>, deadline: number): Promise<{ facts: SecFact[]; missing: string[] }> {
  const symbols = Array.isArray(params.symbols) ? params.symbols.map(String).slice(0, 6) : [];
  const since = String(params.since ?? "2022-01-01");
  if (!symbols.length) throw new Error("sec-facts: params.symbols required");
  const facts: SecFact[] = []; const missing: string[] = [];
  for (const sym of symbols) {
    const cik = await cikFor(sym, deadline);
    if (!cik) { missing.push(sym); continue; }
    let body: { facts?: Record<string, Record<string, { units?: Record<string, Array<{ start?: string; end: string; val: number; form: string; filed: string; fp?: string; fy?: number }>> }>> };
    try { body = await secJson(`${SEC_DATA}/api/xbrl/companyfacts/CIK${pad(cik)}.json`, deadline); }
    catch (error) { if (String(error).includes(" 404 ")) { missing.push(sym); continue; } throw error; }
    for (const taxonomy of Object.values(body.facts ?? {})) {
      for (const tag of FACT_TAGS) {
        for (const [unit, rows] of Object.entries(taxonomy[tag]?.units ?? {})) {
          for (const row of rows) if (row.filed >= since) facts.push({ sym, tag, unit, start: row.start ?? null, end: row.end, value: row.val, form: row.form, filed: row.filed, fp: row.fp ?? "", fy: row.fy ?? null });
        }
      }
    }
  }
  return { facts, missing };
}

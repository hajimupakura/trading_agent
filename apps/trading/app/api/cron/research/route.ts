// CRON_SECRET-guarded read-only proxy for historical research queries.
// Exists because market-data keys are sensitive-locked on Vercel and cannot be
// used from a local machine. Strictly whitelisted query kinds; no mutations.
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const TICKER = /^[A-Z0-9:._]{1,32}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO = /^[\d:.TZ+-]{10,35}$/;

async function massive(path: string) {
  const url = new URL(`https://api.massive.com${path}`);
  url.searchParams.set("apiKey", process.env.MASSIVE_API_KEY ?? "");
  const response = await fetch(url, { cache:"no-store", signal:AbortSignal.timeout(25_000) });
  return Response.json(await response.json().catch(() => ({ error:`Massive ${response.status}` })), { status:response.status });
}

async function alpaca(path: string) {
  const response = await fetch(`https://data.alpaca.markets${path}`, {
    headers:{ "APCA-API-KEY-ID":process.env.ALPACA_API_KEY_ID ?? "", "APCA-API-SECRET-KEY":process.env.ALPACA_API_SECRET_KEY ?? "" },
    cache:"no-store", signal:AbortSignal.timeout(25_000),
  });
  return Response.json(await response.json().catch(() => ({ error:`Alpaca ${response.status}` })), { status:response.status });
}

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) return new Response("Unauthorized", { status:401 });
  const params = new URL(request.url).searchParams;
  const kind = params.get("kind");
  const ticker = params.get("ticker") ?? "";
  const start = params.get("start") ?? ""; const end = params.get("end") ?? "";
  try {
    if (kind === "stock_bars") {
      const timeframe = params.get("timeframe") === "1Day" ? "1Day" : "1Min";
      if (!TICKER.test(ticker) || !DATE.test(start) || !DATE.test(end)) return Response.json({ error:"bad params" }, { status:400 });
      return alpaca(`/v2/stocks/${ticker}/bars?timeframe=${timeframe}&start=${start}&end=${end}&feed=iex&adjustment=all&sort=asc&limit=10000`);
    }
    if (kind === "option_aggs") {
      const resolution = params.get("resolution") === "day" ? "day" : "minute";
      if (!TICKER.test(ticker) || !DATE.test(start) || !DATE.test(end)) return Response.json({ error:"bad params" }, { status:400 });
      return massive(`/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/${resolution}/${start}/${end}?adjusted=true&sort=asc&limit=50000`);
    }
    if (kind === "option_quotes") {
      const gte = params.get("gte") ?? ""; const lte = params.get("lte") ?? "";
      if (!TICKER.test(ticker) || !ISO.test(gte) || !ISO.test(lte)) return Response.json({ error:"bad params" }, { status:400 });
      return massive(`/v3/quotes/${encodeURIComponent(ticker)}?timestamp.gte=${encodeURIComponent(gte)}&timestamp.lte=${encodeURIComponent(lte)}&sort=timestamp&order=asc&limit=50000`);
    }
    if (kind === "option_contracts") {
      const date = params.get("date") ?? "";
      const underlying = params.get("underlying") ?? "";
      if (!TICKER.test(underlying) || !DATE.test(date)) return Response.json({ error:"bad params" }, { status:400 });
      return massive(`/v3/reference/options/contracts?underlying_ticker=${underlying}&expiration_date=${date}&expired=true&as_of=${date}&limit=1000&sort=strike_price&order=asc`);
    }
    return Response.json({ error:"unknown kind" }, { status:400 });
  } catch (error) {
    return Response.json({ error:error instanceof Error ? error.message : "research proxy failed" }, { status:502 });
  }
}

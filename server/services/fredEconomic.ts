import axios from "axios";

/**
 * FRED (Federal Reserve Economic Data) Service
 * Free with API key from https://fred.stlouisfed.org/docs/api/api_key.html
 *
 * Tracks: GDP, CPI, Unemployment, Fed Funds Rate, 10Y Treasury.
 */

const FRED_BASE = "https://api.stlouisfed.org/fred/series/observations";

export interface EconomicIndicators {
  gdp: { value: number; date: string; label: string } | null;
  cpi: { value: number; date: string; change: number; label: string } | null;
  unemployment: { value: number; date: string; label: string } | null;
  fedFundsRate: { value: number; date: string; label: string } | null;
  treasury10y: { value: number; date: string; label: string } | null;
  fetchedAt: Date;
}

let cached: EconomicIndicators | null = null;
let cacheTime = 0;
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours (FRED data updates infrequently)

const SERIES = {
  gdp: { id: "GDP", label: "GDP (Quarterly, Billions)" },
  cpi: { id: "CPIAUCSL", label: "CPI (Monthly)" },
  unemployment: { id: "UNRATE", label: "Unemployment Rate (%)" },
  fedFundsRate: { id: "FEDFUNDS", label: "Fed Funds Rate (%)" },
  treasury10y: { id: "DGS10", label: "10-Year Treasury Yield (%)" },
};

async function fetchSeries(seriesId: string): Promise<{ value: number; date: string } | null> {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await axios.get(FRED_BASE, {
      params: {
        series_id: seriesId,
        api_key: apiKey,
        file_type: "json",
        sort_order: "desc",
        limit: 2,
      },
      timeout: 10_000,
    });

    const obs = res.data?.observations;
    if (!obs || obs.length === 0) return null;

    // Find the most recent non-"." value
    for (const o of obs) {
      if (o.value !== ".") {
        return { value: parseFloat(o.value), date: o.date };
      }
    }
    return null;
  } catch (error: any) {
    console.error(`[FRED] Failed to fetch ${seriesId}:`, error.message);
    return null;
  }
}

export async function getEconomicIndicators(): Promise<EconomicIndicators> {
  const now = Date.now();
  if (cached && now - cacheTime < CACHE_TTL) return cached;

  if (!process.env.FRED_API_KEY) {
    console.warn("[FRED] FRED_API_KEY not set — economic indicators disabled");
    return emptyIndicators();
  }

  // Fetch all in parallel
  const [gdp, cpi, unemployment, fedFunds, treasury] = await Promise.all([
    fetchSeries(SERIES.gdp.id),
    fetchSeries(SERIES.cpi.id),
    fetchSeries(SERIES.unemployment.id),
    fetchSeries(SERIES.fedFundsRate.id),
    fetchSeries(SERIES.treasury10y.id),
  ]);

  cached = {
    gdp: gdp ? { ...gdp, label: SERIES.gdp.label } : null,
    cpi: cpi ? { ...cpi, change: 0, label: SERIES.cpi.label } : null,
    unemployment: unemployment ? { ...unemployment, label: SERIES.unemployment.label } : null,
    fedFundsRate: fedFunds ? { ...fedFunds, label: SERIES.fedFundsRate.label } : null,
    treasury10y: treasury ? { ...treasury, label: SERIES.treasury10y.label } : null,
    fetchedAt: new Date(),
  };
  cacheTime = now;

  console.log("[FRED] Economic indicators updated");
  return cached;
}

function emptyIndicators(): EconomicIndicators {
  return {
    gdp: null, cpi: null, unemployment: null,
    fedFundsRate: null, treasury10y: null, fetchedAt: new Date(),
  };
}

// Alpaca data-plan switch (2026-11-23). Free tier = IEX-only stock quotes (one
// exchange, a few % of volume) and no entitlement to recent SIP data — requesting
// it 403s. Subscribing to Algo Trader Plus unlocks the consolidated SIP tape; flip
// ALPACA_DATA_PLAN=paid in the Vercel env (and Railway for the worker) and every
// stock data call upgrades at once. Deliberately env-driven rather than auto-probed:
// if the env says paid but Alpaca rejects SIP, the calls fail loud through the
// existing error lanes instead of silently degrading to IEX (silent-failure doctrine).
// The options chain feed is separate and already auto-probes OPRA in provider.ts.
export const PAID_DATA_PLAN = process.env.ALPACA_DATA_PLAN === "paid";
export const STOCK_FEED = PAID_DATA_PLAN ? "sip" : "iex";

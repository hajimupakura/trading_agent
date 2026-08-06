# SPX / SPY 0-2 DTE setup

The default dashboard is now a paper/shadow-mode command center for SPX and SPY options. It ranks 0-2 DTE contracts by executable liquidity and only produces entry *candidates* when the selected underlying confirms an opening-range breakout in the same direction.

## Data subscription

Create a Massive account and select a plan that includes real-time options snapshots and the historical options data required for replay. The server accepts either the current `MASSIVE_API_KEY` name or the legacy `POLYGON_API_KEY` name.

```env
MASSIVE_API_KEY=replace_with_your_private_key
OPTIONS_MONITOR_INTERVAL_MS=15000
ENABLE_LIVE_TRADING=false
```

Never put the key in a `VITE_` variable or client-side file. Restart the server after changing the environment.

When the key is configured, the server continuously refreshes both SPX and SPY. The browser also refreshes the selected command-center view every 15 seconds. SPY uses its own tradable volume and VWAP; SPX uses its own index bars and a time-weighted session mean because the index does not have share volume.

## Safety behavior

- The focused Next.js application always uses Alpaca's paper endpoint; live order submission is not implemented.
- An authenticated owner can approve one-contract Alpaca paper limit orders. Every order is rescanned and risk-checked on the server before submission.
- Automatic exits are not enabled yet; approval-mode positions must be closed manually in Alpaca.
- AI only reviews a deterministic entry candidate and cannot create one or override rejection rules.
- Repeated identical signals reuse the previous AI verdict to control cost.
- Contracts are rejected when they are outside 0-2 DTE, one-sided, too wide, too thin, below the premium floor, or offered above the $8.00 quote cap (roughly $800 for one standard 100-multiplier contract).

## Current entry hypothesis

The first deliberately narrow hypothesis is a 15-minute opening-range continuation:

- Call candidate: SPY is above session VWAP, in an EMA-defined uptrend, and above the opening-range high.
- Put candidate: SPY is below session VWAP, in an EMA-defined downtrend, and below the opening-range low.
- The contract must pass liquidity controls and is selected from the highest-ranked matching call or put.

This is an unproven research hypothesis. Do not enable live execution until historical replay, forward shadow testing, fill simulation, and a statistically credible out-of-sample evaluation exist.

The previous broad-market dashboard remains available at `/legacy` while the repurposing is validated.

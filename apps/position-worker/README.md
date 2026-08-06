# Velocity position worker

This long-running Railway service watches only Alpaca paper option positions that were opened through Velocity's approved-order flow. It never opens a position. When an enabled exit rule fires, it submits and manages an Alpaca paper `sell_to_close` limit order.

## Required Railway variables

- `ALPACA_API_KEY_ID`
- `ALPACA_API_SECRET_KEY`
- `MASSIVE_API_KEY`
- `NEXT_PUBLIC_SUPABASE_URL` (or `SUPABASE_URL`)
- `SUPABASE_SECRET_KEY`
- `PAPER_AUTO_EXITS_ENABLED=true`

Optional variables:

- `POSITION_POLL_INTERVAL_MS=5000`
- `MANAGER_INSTANCE_ID=railway-primary`
- `PORT` is supplied by Railway.

Use the repository root as the Railway service root so the root `railway.json` and pnpm workspace are available.

## Safety model

- Paper endpoint only; the Alpaca base URL is hard-coded to `paper-api.alpaca.markets`.
- Alpaca retail currently supports the SPY automation path, not SPX index-option execution; SPX remains analysis-only.
- Exits only; there is no buy-order path in this process.
- Ownership check; positions without a matching Velocity `buy_to_open` journal entry are ignored.
- The dashboard emergency stop prevents new automated exit actions.
- Stale or missing option quotes stop action and mark the worker unhealthy.
- All remaining positions are targeted for closure by 3:10 p.m. ET; an overnight position is targeted at the next regular-session open.

Start with `PAPER_AUTO_EXITS_ENABLED=false`, verify `/health` and the dashboard status, then enable it only while testing with paper positions.

#!/usr/bin/env bash
# Morning routine: ask the deployed app whether its Robinhood connection is healthy
# (it auto-refreshes tokens itself). If dead, run the localhost reconnect flow:
# a tiny forwarder receives Robinhood's localhost-only OAuth redirect and bounces
# it to the deployed app, which completes the token exchange with its own secrets.
# Nothing secret is needed on this machine except CRON_SECRET to call the health API.
set -euo pipefail
cd "$(dirname "$0")/.."

APP_URL="${VELOCITY_APP_URL:-https://trading-agent-mocha.vercel.app}"

# CRON_SECRET lives in .env.morning.local (git-ignored). The Vercel team policy
# marks all Production env vars sensitive, so `vercel env pull` cannot export it.
if [ ! -f .env.morning.local ]; then
  echo "Missing .env.morning.local — create it with the same CRON_SECRET set on Vercel:" >&2
  echo "  echo 'CRON_SECRET=<value>' > .env.morning.local && chmod 600 .env.morning.local" >&2
  exit 1
fi
CRON_SECRET=$(grep '^CRON_SECRET=' .env.morning.local | head -1 | cut -d= -f2- | tr -d '"')
if [ -z "$CRON_SECRET" ]; then
  echo "CRON_SECRET is empty in .env.morning.local" >&2
  exit 1
fi

check() { curl -sS -m 30 -H "Authorization: Bearer $CRON_SECRET" "$APP_URL/api/cron/robinhood-health"; }

result=$(check || echo '{"connected":false,"reason":"health_endpoint_unreachable"}')
if [ "$(printf '%s' "$result" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).connected' 2>/dev/null)" = "true" ]; then
  echo "✓ Robinhood connection healthy: $result"
  echo "Nothing else to do — the deployed Velocity app can trade all day."
  exit 0
fi

echo "✗ Robinhood needs a reconnect: $result"
echo ""
echo "Starting the localhost OAuth forwarder and opening Velocity settings..."
echo "  1. In the browser tab that opens, log in and click 'Connect Robinhood'."
echo "  2. Approve the push notification in your Robinhood mobile app."
echo "  3. This finishes automatically once Robinhood redirects back."
echo ""
( sleep 2 && open "$APP_URL/dashboard/settings" ) &
VELOCITY_APP_URL="$APP_URL" node scripts/robinhood-oauth-forwarder.mjs

sleep 3
result=$(check || true)
if [ "$(printf '%s' "$result" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).connected' 2>/dev/null)" = "true" ]; then
  echo "✓ Reconnected: $result"
else
  echo "Still not healthy: $result"
  echo "Check $APP_URL/dashboard/settings for the connection status/error."
  exit 1
fi

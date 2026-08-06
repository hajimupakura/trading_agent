#!/usr/bin/env bash
# Morning routine: verify the Robinhood MCP connection; if it's dead, launch the
# localhost reconnect flow (Robinhood only allows the OAuth redirect via localhost).
set -euo pipefail
cd "$(dirname "$0")/.."

# Keep env fresh (needed for Supabase + token decryption keys).
# The Development environment holds pullable copies of BROKER_TOKEN_ENCRYPTION_KEY and
# SUPABASE_SECRET_KEY (same values as Production, whose vars are sensitive-locked).
if [ ! -f .env.local ] || ! grep -q '^BROKER_TOKEN_ENCRYPTION_KEY=' .env.local || [ -n "$(find .env.local -mtime +7 2>/dev/null)" ]; then
  echo "Pulling environment variables from Vercel (development)..."
  vercel env pull .env.local --environment=development
fi

if node scripts/robinhood-morning-check.mjs; then
  echo "Nothing else to do — the deployed Velocity app can trade all day."
  exit 0
fi

status=$?
if [ "$status" -ne 2 ]; then
  echo "Health check hit an unexpected error (see above)." >&2
  exit "$status"
fi

echo ""
echo "Reconnect needed. Starting Velocity locally..."
echo "  1. Log in to Velocity in the browser tab that opens."
echo "  2. Go to Settings -> Connect Robinhood."
echo "  3. Approve the push notification in your Robinhood mobile app."
echo "  4. When settings shows 'connected', Ctrl+C here to stop the dev server."
echo ""
( sleep 4 && open "http://localhost:3000/dashboard/settings" ) &
pnpm dev

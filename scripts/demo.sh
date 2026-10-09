#!/usr/bin/env bash
# Starts everything in production mode so the service worker is active and
# offline can be tested by hand. Dev mode deliberately has no service worker,
# so `make dev` cannot be used to test offline.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PG_BIN="${PG_BIN:-/usr/lib/postgresql/18/bin}"
PGDATA="${PGDATA:-$HOME/.local/share/pos-pg}"
PGPORT="${PGPORT:-5433}"
API_PORT="${API_PORT:-4000}"
WEB_PORT="${WEB_PORT:-4173}"

BOLD=$'\033[1m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; OFF=$'\033[0m'
LOGDIR="$(mktemp -d)"

kill_port() {
  local pid
  pid=$(ss -lptn "sport = :$1" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1)
  [ -n "$pid" ] && kill "$pid" 2>/dev/null
  return 0
}

kill_port_hard() {
  local pid
  pid=$(ss -lptn "sport = :$1" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1)
  [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null
  return 0
}

cleanup() {
  printf '\n%sStopping…%s\n' "$DIM" "$OFF"
  # TERM first so the API can finish any in-flight sale, then KILL anything
  # still holding a port. Bounded at ~2s rather than waiting on a graceful close.
  kill_port "$WEB_PORT"
  kill_port "$API_PORT"
  for _ in 1 2 3 4; do
    ss -lptn "sport = :$API_PORT" 2>/dev/null | grep -q pid= || break
    sleep 0.5
  done
  kill_port_hard "$WEB_PORT"
  kill_port_hard "$API_PORT"
  rm -rf "$LOGDIR"
}
trap cleanup EXIT INT TERM

printf '%sStarting the point of sale%s\n\n' "$BOLD" "$OFF"

# Database
if ! "$PG_BIN/pg_isready" -h 127.0.0.1 -p "$PGPORT" -q 2>/dev/null; then
  [ -d "$PGDATA" ] || "$PG_BIN/initdb" -D "$PGDATA" -U pos --auth=trust -E UTF8 >/dev/null 2>&1
  "$PG_BIN/pg_ctl" -D "$PGDATA" \
    -o "-p $PGPORT -c unix_socket_directories=/tmp -c listen_addresses=127.0.0.1" \
    -l "$PGDATA/server.log" start >/dev/null 2>&1
  for ((i = 0; i < 30; i++)); do
    "$PG_BIN/pg_isready" -h 127.0.0.1 -p "$PGPORT" -q 2>/dev/null && break
    sleep 1
  done
  "$PG_BIN/createdb" -h 127.0.0.1 -p "$PGPORT" -U pos pos 2>/dev/null
fi
printf '  database    ready\n'

npm run build -w @pos/shared --silent >"$LOGDIR/shared.log" 2>&1
npm run db:migrate -w @pos/api >"$LOGDIR/migrate.log" 2>&1

if [ "$("$PG_BIN/psql" -h 127.0.0.1 -p "$PGPORT" -U pos -d pos -tA -c 'SELECT count(*) FROM stores' 2>/dev/null || echo 0)" = "0" ]; then
  npm run db:seed -w @pos/api >"$LOGDIR/seed.log" 2>&1
  printf '  demo data   loaded\n'
fi

# A production build is required: the service worker does not exist in dev.
printf '  building    (needed for offline to work)…\n'
npm run build -w @pos/web >"$LOGDIR/build.log" 2>&1 || { tail -12 "$LOGDIR/build.log"; exit 1; }

kill_port "$API_PORT"; kill_port "$WEB_PORT"; sleep 1

npx tsx apps/api/src/index.ts >"$LOGDIR/api.log" 2>&1 &
for ((i = 0; i < 45; i++)); do curl -sf -m 2 "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1 && break; sleep 1; done
printf '  api         http://127.0.0.1:%s\n' "$API_PORT"

(cd apps/web && npx vite preview --host 127.0.0.1 --port "$WEB_PORT" --strictPort >"$LOGDIR/web.log" 2>&1) &
for ((i = 0; i < 45; i++)); do curl -sf -m 2 "http://127.0.0.1:$WEB_PORT/" >/dev/null 2>&1 && break; sleep 1; done

cat <<BANNER

${GREEN}${BOLD}  Open http://127.0.0.1:${WEB_PORT}${OFF}

${BOLD}Sign in${OFF}
  Choose ${BOLD}Email${OFF}, then:
    admin@tigonigrown.com  /  ChangeMe!Admin2024

  Other accounts (same password):
    manager@tigonigrown.com     staff MGR001  pin 2468
    cashier@tigonigrown.com     staff CSH001  pin 1357
    auditor@tigonigrown.com     staff AUD001  pin 9753

${BOLD}Barcodes you can scan${OFF} (type into the scan box, press Enter)
  6001234500024   Kenyan AA Coffee 500g    1,200.00   standard VAT
  6001234500017   Hass Avocado (per kg)      250.00   zero rated
  6001234500031   Cotton T-Shirt Navy S      850.00
  6001234500079   Bottled Water 1L             80.00

${BOLD}To test offline${OFF}
  1. Load the page and sign in, then wait ~5 seconds
  2. DevTools (F12) → Network tab → throttling dropdown → ${BOLD}Offline${OFF}
  3. Reload the page. It should still load and let you sell.
  4. Complete a sale — the badge shows "Offline · 1 queued"
  5. Set throttling back to ${BOLD}No throttling${OFF}
  6. The queue drains on its own within ~20 seconds

  Logs: ${LOGDIR}
  ${DIM}Press Ctrl+C to stop everything.${OFF}

BANNER

# Hold until interrupted. A short interval so Ctrl+C is acted on at once rather
# than after a long sleep call.
while true; do sleep 1; done

#!/usr/bin/env bash
# Runs every automated check in one pass: typecheck, unit + integration tests
# against a real PostgreSQL, a production build, and browser tests including
# offline with the network cut.
#
# Safe to run repeatedly. Starts anything it needs and stops what it started.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PG_BIN="${PG_BIN:-/usr/lib/postgresql/18/bin}"
PGDATA="${PGDATA:-$HOME/.local/share/pos-pg}"
PGPORT="${PGPORT:-5433}"
API_PORT="${API_PORT:-4000}"
WEB_PORT="${WEB_PORT:-4173}"

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; DIM=$'\033[2m'; OFF=$'\033[0m'

STARTED_DB=0
STARTED_API=0
STARTED_WEB=0
FAILURES=()
LOGDIR="$(mktemp -d)"

step()  { printf '\n%s▸ %s%s\n' "$BOLD" "$1" "$OFF"; }
pass()  { printf '  %s✓%s %s\n' "$GREEN" "$OFF" "$1"; }
fail()  { printf '  %s✗%s %s\n' "$RED" "$OFF" "$1"; FAILURES+=("$1"); }
note()  { printf '  %s%s%s\n' "$DIM" "$1" "$OFF"; }

cleanup() {
  [ "$STARTED_WEB" = 1 ] && kill_port "$WEB_PORT"
  [ "$STARTED_API" = 1 ] && kill_port "$API_PORT"
  # The database is left running: it is slow to start and harmless to leave.
  if [ ${#FAILURES[@]} -gt 0 ]; then
    printf '\n%sLogs kept in %s%s\n' "$DIM" "$LOGDIR" "$OFF"
  else
    rm -rf "$LOGDIR"
  fi
}
trap cleanup EXIT

kill_port() {
  local pid
  pid=$(ss -lptn "sport = :$1" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1)
  [ -n "$pid" ] && kill "$pid" 2>/dev/null
  return 0
}

wait_for() {
  local url=$1 label=$2 tries=${3:-45}
  for ((i = 0; i < tries; i++)); do
    curl -sf -m 2 "$url" >/dev/null 2>&1 && return 0
    sleep 1
  done
  fail "$label did not come up"
  return 1
}

# ---------------------------------------------------------------- database ---
step "PostgreSQL"
if "$PG_BIN/pg_isready" -h 127.0.0.1 -p "$PGPORT" -q 2>/dev/null; then
  pass "already running on :$PGPORT"
else
  if [ ! -d "$PGDATA" ]; then
    note "creating a cluster at $PGDATA"
    "$PG_BIN/initdb" -D "$PGDATA" -U pos --auth=trust -E UTF8 >/dev/null 2>&1
  fi
  "$PG_BIN/pg_ctl" -D "$PGDATA" \
    -o "-p $PGPORT -c unix_socket_directories=/tmp -c listen_addresses=127.0.0.1" \
    -l "$PGDATA/server.log" start >/dev/null 2>&1
  for ((i = 0; i < 30; i++)); do
    "$PG_BIN/pg_isready" -h 127.0.0.1 -p "$PGPORT" -q 2>/dev/null && break
    sleep 1
  done
  if "$PG_BIN/pg_isready" -h 127.0.0.1 -p "$PGPORT" -q 2>/dev/null; then
    STARTED_DB=1
    "$PG_BIN/createdb" -h 127.0.0.1 -p "$PGPORT" -U pos pos 2>/dev/null
    pass "started on :$PGPORT"
  else
    fail "PostgreSQL would not start"
    exit 1
  fi
fi

# ------------------------------------------------------------------- build ---
step "Shared package"
if npm run build -w @pos/shared --silent >"$LOGDIR/shared.log" 2>&1; then
  pass "built"
else
  fail "shared package build"; tail -5 "$LOGDIR/shared.log"
fi

step "Typecheck"
if npm run typecheck >"$LOGDIR/typecheck.log" 2>&1; then
  pass "no type errors in any workspace"
else
  fail "typecheck"; grep "error TS" "$LOGDIR/typecheck.log" | head -8
fi

# ------------------------------------------------------------------- tests ---
step "Unit and integration tests"
note "integration tests create and drop their own database"
if npm run test -w @pos/api >"$LOGDIR/tests.log" 2>&1; then
  pass "$(grep -oE 'Tests +[0-9]+ passed' "$LOGDIR/tests.log" | tail -1)"
else
  fail "unit/integration tests"
  grep -E '×|AssertionError|→' "$LOGDIR/tests.log" | head -12
fi

# ------------------------------------------------------------ browser tests --
step "Production build"
if npm run build -w @pos/web >"$LOGDIR/build.log" 2>&1; then
  pass "$(grep -oE 'precache +[0-9]+ entries.*' "$LOGDIR/build.log" | tail -1)"
else
  fail "web build"; tail -8 "$LOGDIR/build.log"
fi

step "Starting API and till"
kill_port "$API_PORT"; kill_port "$WEB_PORT"; sleep 1

npm run db:migrate -w @pos/api >"$LOGDIR/migrate.log" 2>&1 \
  && pass "migrations applied" || { fail "migrations"; tail -5 "$LOGDIR/migrate.log"; }

# Seed only when the database is empty, so repeat runs keep their data.
if [ "$("$PG_BIN/psql" -h 127.0.0.1 -p "$PGPORT" -U pos -d pos -tA -c 'SELECT count(*) FROM stores' 2>/dev/null || echo 0)" = "0" ]; then
  npm run db:seed -w @pos/api >"$LOGDIR/seed.log" 2>&1 && pass "seeded demo data"
else
  note "database already has data; skipping seed"
fi

# An open shift from an earlier run would fail the shift test.
"$PG_BIN/psql" -h 127.0.0.1 -p "$PGPORT" -U pos -d pos \
  -c "UPDATE shifts SET status='CLOSED', closed_at=now() WHERE status='OPEN'" >/dev/null 2>&1

PORT="$API_PORT" npx tsx apps/api/src/index.ts >"$LOGDIR/api.log" 2>&1 &
STARTED_API=1
wait_for "http://127.0.0.1:$API_PORT/health" "API" && pass "API on :$API_PORT"

(cd apps/web && VITE_API_TARGET="http://127.0.0.1:$API_PORT" npx vite preview --host 127.0.0.1 --port "$WEB_PORT" --strictPort >"$LOGDIR/web.log" 2>&1) &
STARTED_WEB=1
wait_for "http://127.0.0.1:$WEB_PORT/" "Till" && pass "till on :$WEB_PORT"

step "Browser and offline tests"
note "runs against the production build, with the network genuinely cut"
if E2E_BASE_URL="http://127.0.0.1:$WEB_PORT" npx playwright test --config apps/web/playwright.config.ts >"$LOGDIR/e2e.log" 2>&1; then
  grep -E '✓' "$LOGDIR/e2e.log" | sed 's/^ *//' | while read -r line; do
    printf '  %s✓%s %s\n' "$GREEN" "$OFF" "$(echo "$line" | sed 's/^✓ *[0-9]* *//; s/apps\/web\/e2e\///')"
  done
else
  fail "browser tests"
  grep -E '✘|Error:' "$LOGDIR/e2e.log" | head -10
fi

# ------------------------------------------------------------------- audit ---
step "Dependency audit"
if npm audit --audit-level=high >"$LOGDIR/audit.log" 2>&1; then
  pass "no high or critical vulnerabilities"
else
  fail "dependency audit"
  grep -E "^Severity: (high|critical)" "$LOGDIR/audit.log" | head -5
fi

# ------------------------------------------------------------------ result ---
printf '\n%s' "$BOLD"
printf '─%.0s' {1..56}
printf '%s\n' "$OFF"

if [ ${#FAILURES[@]} -eq 0 ]; then
  printf '%s  Everything passed.%s\n' "$GREEN$BOLD" "$OFF"
  printf '\n  Try it by hand:  %smake demo%s\n' "$BOLD" "$OFF"
  exit 0
fi

printf '%s  %d check(s) failed:%s\n' "$RED$BOLD" "${#FAILURES[@]}" "$OFF"
for failure in "${FAILURES[@]}"; do printf '    %s✗%s %s\n' "$RED" "$OFF" "$failure"; done
exit 1

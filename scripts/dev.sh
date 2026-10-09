#!/usr/bin/env bash
# Runs the API and the till together with prefixed output.
#
# Replaces `concurrently`, which carries an unfixed critical advisory (command
# injection via shell-quote) for what amounts to three lines of shell.

set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

CYAN=$'\033[36m'; MAGENTA=$'\033[35m'; OFF=$'\033[0m'
PIDS=()

cleanup() {
  # Kill the whole process group of each child, or tsx/vite children survive.
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && kill -- "-$pid" 2>/dev/null
  done
  wait 2>/dev/null
}
trap cleanup EXIT INT TERM

# setsid gives each child its own process group so cleanup can take the tree.
setsid npm run dev:api 2>&1 | sed "s/^/${CYAN}[api]${OFF} /" &
PIDS+=($!)

setsid npm run dev:web 2>&1 | sed "s/^/${MAGENTA}[web]${OFF} /" &
PIDS+=($!)

wait -n

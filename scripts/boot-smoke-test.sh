#!/usr/bin/env bash
# Boots the actual compiled apps/api and apps/worker dist/ output and
# verifies both come up for real. This exists specifically to catch a
# class of bug that a clean `tsc --build` / `tsc --noEmit` cannot:
# imports that type-check (e.g. via a stray ambient module
# declaration, or a stale dist/ resolved through a node_modules
# symlink) but resolve to nothing once Node actually tries to
# require() the compiled output. Deliberately a plain shell script,
# not a new test framework — see CLAUDE.md's stance against
# unnecessary complexity.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DATABASE_URL="${DATABASE_URL:-postgresql://tennis:tennis@localhost:5432/tennis_manager}"
REDIS_URL="${REDIS_URL:-redis://localhost:6379}"
API_PORT="${BOOT_SMOKE_API_PORT:-3919}"

API_MATCH_LOG_DIR="$(mktemp -d)"
WORKER_MATCH_LOG_DIR="$(mktemp -d)"
LOG_DIR="$(mktemp -d)"

API_PID=""
WORKER_PID=""

cleanup() {
  local status=$?
  if [ -n "$API_PID" ]; then
    kill "$API_PID" >/dev/null 2>&1 || true
    wait "$API_PID" 2>/dev/null || true
  fi
  if [ -n "$WORKER_PID" ]; then
    kill "$WORKER_PID" >/dev/null 2>&1 || true
    wait "$WORKER_PID" 2>/dev/null || true
  fi
  if [ "$status" -ne 0 ]; then
    echo "==> boot smoke test failed (exit $status) — process output follows"
    echo "--- apps/api dist/index.js log ---"
    cat "$LOG_DIR/api.log" 2>/dev/null || true
    echo "--- apps/worker dist/index.js log ---"
    cat "$LOG_DIR/worker.log" 2>/dev/null || true
  fi
  rm -rf "$API_MATCH_LOG_DIR" "$WORKER_MATCH_LOG_DIR" "$LOG_DIR"
  exit "$status"
}
trap cleanup EXIT

echo "==> Building packages/domain, packages/application, apps/api, apps/worker"
npx tsc --build

echo "==> Applying migrations (apps/api/drizzle) against \$DATABASE_URL"
(cd apps/api && DATABASE_URL="$DATABASE_URL" npx drizzle-kit migrate)

echo "==> Booting apps/api/dist/index.js on port $API_PORT"
(
  cd apps/api
  export DATABASE_URL="$DATABASE_URL"
  export PORT="$API_PORT"
  export MATCH_LOG_DIR="$API_MATCH_LOG_DIR"
  exec node dist/index.js
) > "$LOG_DIR/api.log" 2>&1 &
API_PID=$!

echo "==> Waiting for GET /health to respond"
api_up=false
for _ in $(seq 1 30); do
  if ! kill -0 "$API_PID" 2>/dev/null; then
    echo "apps/api exited before becoming healthy" >&2
    exit 1
  fi
  if curl -sf "http://localhost:${API_PORT}/health" 2>/dev/null | grep -q '"status":"ok"'; then
    api_up=true
    break
  fi
  sleep 0.5
done
if [ "$api_up" != true ]; then
  echo "apps/api never became healthy on port $API_PORT within 15s" >&2
  exit 1
fi
echo "apps/api is up — GET /health returned {\"status\":\"ok\"}"

echo "==> Booting apps/worker/dist/index.js"
(
  cd apps/worker
  export DATABASE_URL="$DATABASE_URL"
  export REDIS_URL="$REDIS_URL"
  export MATCH_LOG_DIR="$WORKER_MATCH_LOG_DIR"
  export WORLD_ID="boot-smoke-test"
  exec node dist/index.js
) > "$LOG_DIR/worker.log" 2>&1 &
WORKER_PID=$!

echo "==> Waiting for apps/worker to register its scheduled jobs"
schedulers_up=false
for _ in $(seq 1 20); do
  if ! kill -0 "$WORKER_PID" 2>/dev/null; then
    echo "apps/worker exited unexpectedly" >&2
    exit 1
  fi
  if REDIS_URL="$REDIS_URL" node "$ROOT_DIR/scripts/check-worker-schedulers.js"; then
    schedulers_up=true
    break
  fi
  sleep 0.5
done
if [ "$schedulers_up" != true ]; then
  echo "apps/worker did not register its scheduled jobs within 10s" >&2
  exit 1
fi
echo "apps/worker is up and both scheduled jobs (advance-world-week, simulate-due-matches) are registered"

echo "==> Boot smoke test passed"

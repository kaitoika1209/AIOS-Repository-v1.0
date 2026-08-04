#!/usr/bin/env bash
#
# Start AIOS locally: database schema, seed, API, and web UI.
#
#     ./scripts/start.sh
#
# Everything this does is available as a separate command — this only puts them
# in the one order that works, and refuses to continue when a step fails rather
# than starting an API against a database that has no schema.
#
# It is a development launcher and says so. It sets no NODE_ENV, so `chooseAuth`
# and `chooseWorkerMode` see `development` and pick the header auth adapter and
# the in-process Outbox worker. In production both refuse: the API will not start
# without Clerk configured, and it will not drain the Outbox, which is what the
# `worker` image is for. See the Dockerfile.

set -euo pipefail

cd "$(dirname "$0")/.."

: "${DATABASE_URL:=postgresql://aios:aios@localhost:5432/aios}"
: "${PORT:=3001}"
: "${WEB_PORT:=3000}"
export DATABASE_URL PORT

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

# The driver lives in `apps/api`, not at the root, so the probes below run
# through the workspace that has it. Their stderr is left alone: "password
# authentication failed" and "no such host" need different fixes, and a script
# that reduces both to "cannot connect" makes the reader guess which.
probe() { pnpm --silent --filter @aios/api exec node -e "$1"; }

step "Checking the database is reachable"
# Before anything else, because every later step fails obscurely without it and
# the fix — start PostgreSQL, or point DATABASE_URL somewhere real — is the same
# in each case.
if ! probe '
  const { Client } = require("pg");
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  c.connect().then(() => c.end()).catch((e) => { console.error(e.message); process.exit(1); });
'; then
  echo "Cannot connect to ${DATABASE_URL}." >&2
  echo "Start PostgreSQL and create the database, or set DATABASE_URL." >&2
  exit 1
fi
echo "ok: ${DATABASE_URL}"

step "Applying migrations"
# Forward-only and checksummed (ADR-0020). Re-running is a no-op, which is why
# this is unconditional rather than guarded by a "first run?" flag that would be
# wrong the moment a migration is added.
pnpm --filter @aios/api migrate

step "Seeding"
# Only when there is nothing to seed. A second run would fail on the primary key
# and, more to the point, would overwrite an Organization someone was using.
if probe '
  const { Client } = require("pg");
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  c.connect()
    .then(() => c.query("select count(*)::int as n from organizations"))
    .then((r) => { process.exitCode = r.rows[0].n > 0 ? 1 : 0; })
    .finally(() => c.end());
'; then
  pnpm --filter @aios/api seed
else
  echo "skipped: the database already holds an Organization"
fi

step "Starting the API on :${PORT} and the web UI on :${WEB_PORT}"
echo "Stop both with Ctrl-C."
echo

pids=()
cleanup() {
  # Both, even if only one is still alive: an API left holding :3001 after the
  # web process died is the state that makes the next run fail confusingly.
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

pnpm --filter @aios/api dev &
pids+=($!)

PORT="$WEB_PORT" pnpm --filter @aios/web dev &
pids+=($!)

# Exits as soon as either does, so a crashed API does not leave a UI running
# against nothing.
wait -n

#!/usr/bin/env bash
#
# A staging-shaped environment, on one machine.
#
#     sudo ./scripts/staging.sh up
#     ./scripts/staging.sh status
#     sudo ./scripts/staging.sh down
#
# `infrastructure-roadmap.md` marks item 12 *Partial* for one reason: runbooks
# 1–5 were executed against a **single** local process with a **single**
# database and no ingress. Every step that depends on there being two of
# something — a load balancer with replicas behind it, a real promotion, two
# Workers dividing a queue, a mixed-version deploy — was unrehearsed.
#
# This brings up the shape those steps need:
#
#   PostgreSQL primary   :54340   streaming to
#   PostgreSQL standby   :54341   (a real replica, promotable with pg_ctl)
#   API replica A        :3101    probe :3111
#   API replica B        :3102    probe :3112
#   Worker 1                      probe :3121
#   Worker 2                      probe :3122
#   Readiness proxy      :3100    routes on /health/ready, like the target group
#
# **It is not staging.** There is no object store, no real provider, no TLS, no
# network partition, and the load balancer is a hundred lines of Node rather
# than an ALB. What it does buy is the ability to break things on purpose in
# the one dimension that matters most — plurality — and every finding recorded
# in `staging-rehearsal.md` came from doing exactly that.
#
# Both API replicas run with `WORKER_IN_PROCESS=false`. That is production
# shape and it is worth stating, because under `NODE_ENV=development` the API
# drains the Outbox itself: an earlier rehearsal measured Worker behaviour
# against an environment in which the API was quietly doing the Worker's job.

set -euo pipefail

BIN="${PG_BIN:-}"
if [ -z "$BIN" ]; then
  for candidate in /usr/lib/postgresql/*/bin /usr/pgsql-*/bin /opt/homebrew/opt/postgresql*/bin; do
    [ -x "$candidate/initdb" ] && BIN="$candidate"
  done
fi
[ -n "$BIN" ] && [ -x "$BIN/initdb" ] || { echo "Set PG_BIN." >&2; exit 1; }

ROOT="${STAGING_ROOT:-/tmp/aios-staging}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
RUNAS="${STAGING_USER:-postgres}"

PORT_PRIMARY=54340
PORT_STANDBY=54341
PRIMARY_URL="postgresql://aios:aios@127.0.0.1:$PORT_PRIMARY/aios"
STANDBY_URL="postgresql://aios:aios@127.0.0.1:$PORT_STANDBY/aios"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

pg() { su "$RUNAS" -c "$*"; }

start_primary() {
  pg "$BIN/initdb -D $ROOT/primary -A trust --username=postgres" >/dev/null
  cat >> "$ROOT/primary/postgresql.conf" <<CONF
port = $PORT_PRIMARY
listen_addresses = 'localhost'
wal_level = replica
max_wal_senders = 5
wal_keep_size = 128MB
archive_mode = on
archive_command = 'test ! -f $ROOT/wal/%f && cp %p $ROOT/wal/%f'
# Bounds the RPO when segments do not fill, which is the same reason
# 02-data.yaml sets it on the RDS parameter group.
archive_timeout = 60s
CONF
  echo "host replication all 127.0.0.1/32 trust" >> "$ROOT/primary/pg_hba.conf"
  pg "$BIN/pg_ctl -D $ROOT/primary -l $ROOT/primary.log -w start" >/dev/null
  pg "psql -p $PORT_PRIMARY -d postgres -c \"CREATE ROLE aios LOGIN SUPERUSER PASSWORD 'aios'\"" >/dev/null
  pg "createdb -p $PORT_PRIMARY -O aios aios"
  # A slot, so the primary retains WAL the standby has not consumed. Without
  # one a standby that falls behind is silently unrecoverable, which is the
  # failure mode that looks like a working replica until you need it.
  pg "psql -p $PORT_PRIMARY -d postgres -tAc \"SELECT pg_create_physical_replication_slot('standby1')\"" >/dev/null
}

start_standby() {
  pg "$BIN/pg_basebackup -h 127.0.0.1 -p $PORT_PRIMARY -U postgres -D $ROOT/standby -X stream -R -S standby1" >/dev/null
  cat >> "$ROOT/standby/postgresql.conf" <<CONF
port = $PORT_STANDBY
hot_standby = on
CONF
  pg "$BIN/pg_ctl -D $ROOT/standby -l $ROOT/standby.log -w start" >/dev/null
}

start_api() {
  local port="$1" probe="$2" version="$3" url="$4"
  DATABASE_URL="$url" NODE_ENV=development WORKER_IN_PROCESS=false \
  PORT="$port" PROBE_PORT="$probe" SERVICE_VERSION="$version" LOG_LEVEL=INFO \
    nohup pnpm --prefix "$REPO" --filter @aios/api dev \
      > "$ROOT/logs/api-$port.log" 2>&1 &
  echo $! > "$ROOT/pids/api-$port.pid"
}

start_worker() {
  local probe="$1" id="$2" url="$3" paused="${4:-}"
  DATABASE_URL="$url" NODE_ENV=development PROBE_PORT="$probe" WORKER_ID="$id" \
  SERVICE_VERSION=staging LOG_LEVEL=INFO WORKER_PAUSED_TYPES="$paused" \
    nohup pnpm --prefix "$REPO" --filter @aios/api worker \
      > "$ROOT/logs/worker-$id.log" 2>&1 &
  echo $! > "$ROOT/pids/worker-$id.pid"
}

case "${1:-}" in
up)
  step "Clearing $ROOT"
  "$0" down >/dev/null 2>&1 || true
  rm -rf "$ROOT"
  mkdir -p "$ROOT/wal" "$ROOT/logs" "$ROOT/pids"
  chown -R "$RUNAS" "$ROOT"
  chmod 700 "$ROOT"

  step "Primary on $PORT_PRIMARY"
  start_primary

  step "Migrating and seeding the primary"
  DATABASE_URL="$PRIMARY_URL" pnpm --prefix "$REPO" --filter @aios/api migrate | tail -1
  DATABASE_URL="$PRIMARY_URL" NODE_ENV=development pnpm --prefix "$REPO" --filter @aios/api seed >/dev/null
  echo "  seeded"

  step "Standby on $PORT_STANDBY, streaming from the primary"
  start_standby
  pg "psql -p $PORT_PRIMARY -d postgres -tAc \"SELECT state, sync_state FROM pg_stat_replication\"" | sed 's/^/  /'

  step "Two API replicas, two Workers, and the readiness proxy"
  start_api 3101 3111 "staging-a" "$PRIMARY_URL"
  start_api 3102 3112 "staging-b" "$PRIMARY_URL"
  start_worker 3121 worker-1 "$PRIMARY_URL"
  start_worker 3122 worker-2 "$PRIMARY_URL"
  nohup node "$REPO/scripts/staging_proxy.mjs" 3100 3101:3111 3102:3112 \
    > "$ROOT/logs/proxy.log" 2>&1 &
  echo $! > "$ROOT/pids/proxy.pid"

  step "Waiting for both replicas to enter rotation"
  for _ in $(seq 1 60); do
    # Two traps in one line, both found by running this twice.
    #
    # `grep -c` exits 1 when the count is zero, and `set -o pipefail` promotes
    # that to the pipeline's status — so on the first pass, before either
    # replica is healthy, `set -e` killed the script *after* successfully
    # bringing the environment up. Silently, and looking exactly like a
    # start-up failure. Hence the `|| true` inside the substitution.
    #
    # And `wc -l` with `|| echo 0` on the same pipeline produced "0\n0", which
    # `[` then refused to read as an integer.
    healthy=$( (curl -s --max-time 2 localhost:3100/__targets 2>/dev/null \
      | grep -c '"healthy":true') || true )
    healthy=$(printf '%s' "$healthy" | tr -dc '0-9')
    [ "${healthy:-0}" -ge 2 ] && break
    sleep 1
  done
  "$0" status
  ;;

status)
  step "Databases"
  for port in $PORT_PRIMARY $PORT_STANDBY; do
    role=$(pg "psql -p $port -d aios -tAc 'SELECT pg_is_in_recovery()'" 2>/dev/null || echo "down")
    case "$role" in
      f) role="primary (writable)" ;;
      t) role="standby (in recovery)" ;;
      *) role="down" ;;
    esac
    printf '  :%s  %s\n' "$port" "$role"
  done

  step "Ingress"
  curl -s localhost:3100/__targets 2>/dev/null || echo "  the proxy is not answering"
  echo

  step "Probes"
  for probe in 3111 3112 3121 3122; do
    printf '  :%s ready=%s live=%s\n' "$probe" \
      "$(curl -s --max-time 2 localhost:$probe/health/ready 2>/dev/null || echo unreachable)" \
      "$(curl -s --max-time 2 localhost:$probe/health/live 2>/dev/null || echo unreachable)"
  done
  ;;

down)
  # Processes are found by the port they were given, read from /proc, rather
  # than by `pkill -f <pattern>`.
  #
  # This is not fastidiousness. `pkill -f` matches the *full command line of
  # every process*, including the shell running this script — whose command line
  # contains the pattern, because the pattern is written in it. During the
  # rehearsal that killed the rehearsal three separate times, each time looking
  # like the thing being tested had crashed. It is the same trap as a `pgrep -f`
  # liveness probe that matches itself and reports a healthy process dead.
  for pid in /proc/[0-9]*; do
    pid="${pid#/proc/}"
    # The `[ -r ]` test races the process exiting between listing /proc and
    # reading it, and the failing redirect is reported by the shell rather than
    # by `tr`, so the suppression has to wrap the redirect.
    port=$({ tr '\0' '\n' < "/proc/$pid/environ"; } 2>/dev/null | grep -m1 '^PROBE_PORT=' || true)
    case "$port" in
      PROBE_PORT=3111|PROBE_PORT=3112|PROBE_PORT=3121|PROBE_PORT=3122)
        kill -TERM "$pid" 2>/dev/null || true
        ;;
    esac
  done
  # The proxy has no probe port of its own; it is the only Node process holding
  # 3100, so ask the kernel rather than the process table.
  proxy=$(ss -lptnH "sport = :3100" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2 || true)
  [ -n "${proxy:-}" ] && kill -TERM "$proxy" 2>/dev/null || true
  sleep 2
  for data in "$ROOT/standby" "$ROOT/primary"; do
    [ -d "$data" ] && pg "$BIN/pg_ctl -D $data -m fast -w stop" >/dev/null 2>&1 || true
  done
  echo "staging stopped"
  ;;

*)
  echo "usage: $0 {up|status|down}" >&2
  exit 1
  ;;
esac

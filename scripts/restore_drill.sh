#!/usr/bin/env bash
#
# Point-in-time recovery drill.
#
#     ./scripts/restore_drill.sh
#
# The observability architecture requires "continuous WAL archiving, a physical
# base backup at least every 24 hours, a 14-day PITR window, a monthly verified
# restore test, and the approved RPO and RTO" — and says the thing that makes all
# of it real:
#
#     Backup-job success is not proof of recoverability.
#
# So this does not check that a backup job exited zero. It restores a database to
# a chosen instant and then proves the instant was honoured: rows written before
# the recovery target must be present, and rows written after it must be **absent**.
# The second half is the whole test. A restore that replayed everything to the end
# would satisfy "the data came back" while being useless for the case PITR exists
# for — recovering to just before a bad deployment or a mistaken deletion.
#
# It runs against a throwaway cluster it creates itself, so it disturbs no
# existing database and can be run anywhere, repeatedly, including in CI. It is
# the executable form of runbook 6.
#
# What it does not cover, and what the runbook must therefore state plainly: the
# real object store, its retention and deletion-resistance, the encryption of
# backups at rest, and the credentials to reach them. Those are Stage D
# infrastructure. This proves the recovery *procedure*; it does not prove the
# production *storage*.

set -euo pipefail

# Discovered rather than hard-coded: `initdb` and `pg_ctl` are not on PATH in a
# Debian PostgreSQL install, and the version directory differs between a
# container, a CI runner, and a developer's machine. A hard-coded path is a job
# that passes here and fails everywhere else.
BIN="${PG_BIN:-}"
if [ -z "$BIN" ]; then
  for candidate in /usr/lib/postgresql/*/bin /usr/pgsql-*/bin /opt/homebrew/opt/postgresql*/bin; do
    [ -x "$candidate/initdb" ] && BIN="$candidate"
  done
fi
[ -n "$BIN" ] && [ -x "$BIN/initdb" ] || {
  echo "Could not find PostgreSQL server binaries. Set PG_BIN." >&2
  exit 1
}
ROOT="${TMPDIR:-/tmp}/aios-restore-drill.$$"
PRIMARY="$ROOT/primary"
ARCHIVE="$ROOT/wal-archive"
BASE="$ROOT/base-backup"
RESTORED="$ROOT/restored"
PORT_PRIMARY=54330
PORT_RESTORED=54331

# Both clusters run as this user; PostgreSQL refuses to start as root.
RUNAS="${DRILL_USER:-postgres}"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

# Record the drill's outcome where the recovery metrics can find it.
#
# `restore_test_age_seconds` and `restore_test_failure_total` are required
# metrics, and an age is computable only from a timestamp somebody stored. Until
# this existed the drill printed its result and exited, so a drill that ran last
# week and a drill that has never run were indistinguishable from outside — which
# is the same failure as trusting a backup job's exit code, one level up.
#
# Optional and non-fatal. The drill's job is to prove the procedure; it must not
# start failing because an unrelated database is unreachable.
#
#   record_result <outcome> [rpo_seconds] [rto_seconds]
record_result() {
  [ -n "${RECOVERY_EVIDENCE_DATABASE_URL:-}" ] || return 0
  _outcome="$1"
  _rpo="${2:-NULL}"
  _rto="${3:-NULL}"
  # Quoted here rather than interpolated as a bare token: an unquoted
  # substitution would be read as SQL, and an evidence reference is an object key
  # that arrives from the environment.
  _ref="NULL"
  [ -n "${EVIDENCE_REFERENCE:-}" ] && _ref="\$aios\$${EVIDENCE_REFERENCE}\$aios\$"
  psql "$RECOVERY_EVIDENCE_DATABASE_URL" -v ON_ERROR_STOP=1 -q -c "
    INSERT INTO recovery_control_events (
      recovery_control_event_id, control_type, outcome, performed_at,
      achieved_rpo_seconds, achieved_rto_seconds,
      evidence_reference, performed_by, recorded_at
    ) VALUES (
      gen_random_uuid(), 'RestoreTest', '${_outcome}', now(),
      ${_rpo}, ${_rto}, ${_ref}, '${DRILL_PERFORMED_BY:-restore-drill}', now()
    )" >/dev/null 2>&1 ||
    printf '\033[33m  (could not record the result: %s)\033[0m\n' "$RECOVERY_EVIDENCE_DATABASE_URL" >&2
}

# A failed drill is recorded before exiting. A control failure that leaves no
# trace is a control failure nobody counts, and `restore_test_failure_total`
# exists precisely to count it.
fail() {
  printf '\033[31mFAILED: %s\033[0m\n' "$1" >&2
  record_result Failed
  exit 1
}

cleanup() {
  su "$RUNAS" -c "$BIN/pg_ctl -D '$PRIMARY' -m immediate stop" >/dev/null 2>&1 || true
  su "$RUNAS" -c "$BIN/pg_ctl -D '$RESTORED' -m immediate stop" >/dev/null 2>&1 || true
  rm -rf "$ROOT"
}
trap cleanup EXIT

mkdir -p "$ROOT" "$ARCHIVE"
chown -R "$RUNAS" "$ROOT"
chmod 700 "$ROOT"

# --- 1. A cluster with continuous WAL archiving ------------------------------
step "Creating a cluster with WAL archiving on"
su "$RUNAS" -c "$BIN/initdb -D '$PRIMARY' --auth=trust" >/dev/null

# `archive_mode` cannot be changed without a restart, which is why it is set
# before first start rather than turned on later. In production the same is true:
# enabling archiving on a running system is a restart, and a system that has
# never had it on has no recovery window at all.
cat >> "$PRIMARY/postgresql.conf" <<CONF
port = $PORT_PRIMARY
wal_level = replica
archive_mode = on
archive_command = 'test ! -f $ARCHIVE/%f && cp %p $ARCHIVE/%f'
# Small so the drill produces several segments quickly. Production sizing is a
# throughput question, not a correctness one.
max_wal_size = 64MB
CONF

su "$RUNAS" -c "$BIN/pg_ctl -D '$PRIMARY' -l '$ROOT/primary.log' -w start" >/dev/null
run() { su "$RUNAS" -c "psql -p $PORT_PRIMARY -d postgres -tAc \"$1\""; }

# --- 2. A base backup, taken while the cluster is serving --------------------
step "Taking a physical base backup"
BACKUP_STARTED=$(date +%s)
su "$RUNAS" -c "$BIN/pg_basebackup -p $PORT_PRIMARY -D '$BASE' -X stream -c fast" >/dev/null
echo "  base backup: $(du -sh "$BASE" | cut -f1)"

# --- 3. Work that must survive, then the recovery target ---------------------
step "Writing data that must survive the restore"
run "CREATE TABLE drill (id int primary key, note text, written_at timestamptz default now())" >/dev/null
run "INSERT INTO drill (id, note) SELECT g, 'before the target' FROM generate_series(1, 500) g" >/dev/null
run "CHECKPOINT" >/dev/null

# A full second, because `recovery_target_time` has sub-second resolution but the
# rows either side of it must be unambiguously either side of it. A drill whose
# boundary is uncertain proves nothing about the boundary.
sleep 1
TARGET=$(run "SELECT now()")
sleep 1

# --- 4. The damage the recovery is meant to undo ------------------------------
step "Writing data that must NOT survive"
run "INSERT INTO drill (id, note) SELECT g, 'after the target' FROM generate_series(501, 1000) g" >/dev/null
run "DELETE FROM drill WHERE id <= 250" >/dev/null
echo "  simulated: 500 rows added and 250 deleted after the recovery target"

# Force the segment holding those changes into the archive. In production this is
# what `archive_timeout` bounds, and it is the difference between the RPO on
# paper and the RPO achieved.
run "SELECT pg_switch_wal()" >/dev/null
run "CHECKPOINT" >/dev/null
sleep 2

LAST_ARCHIVED=$(run "SELECT last_archived_wal FROM pg_stat_archiver")
FAILED_COUNT=$(run "SELECT failed_count FROM pg_stat_archiver")
echo "  last archived segment: $LAST_ARCHIVED (archiver failures: $FAILED_COUNT)"
[ "$FAILED_COUNT" = "0" ] || fail "the archiver reported $FAILED_COUNT failures"

su "$RUNAS" -c "$BIN/pg_ctl -D '$PRIMARY' -m fast stop" >/dev/null

# --- 5. Restore to the chosen instant ----------------------------------------
step "Restoring to $TARGET"
RESTORE_STARTED=$(date +%s)

cp -a "$BASE" "$RESTORED"
chown -R "$RUNAS" "$RESTORED"
chmod 700 "$RESTORED"

cat >> "$RESTORED/postgresql.conf" <<CONF
port = $PORT_RESTORED
archive_mode = off
restore_command = 'cp $ARCHIVE/%f %p'
recovery_target_time = '$TARGET'
# Stop at the target rather than replaying past it. The default would continue
# to the end of the WAL, which restores the damage along with the data.
recovery_target_action = 'promote'
recovery_target_inclusive = off
CONF

# Its presence is what puts the cluster into archive recovery on start.
su "$RUNAS" -c "touch '$RESTORED/recovery.signal'"
su "$RUNAS" -c "$BIN/pg_ctl -D '$RESTORED' -l '$ROOT/restored.log' -w start" >/dev/null

for _ in $(seq 1 60); do
  IN_RECOVERY=$(su "$RUNAS" -c "psql -p $PORT_RESTORED -d postgres -tAc 'SELECT pg_is_in_recovery()'" 2>/dev/null || echo "t")
  [ "$IN_RECOVERY" = "f" ] && break
  sleep 1
done
[ "$IN_RECOVERY" = "f" ] || fail "the restored cluster never finished recovery"
RESTORE_FINISHED=$(date +%s)

# --- 6. Prove the instant was honoured ---------------------------------------
step "Checking what came back"
q() { su "$RUNAS" -c "psql -p $PORT_RESTORED -d postgres -tAc \"$1\""; }

BEFORE=$(q "SELECT count(*) FROM drill WHERE note = 'before the target'")
AFTER=$(q "SELECT count(*) FROM drill WHERE note = 'after the target'")
SURVIVING_LOW=$(q "SELECT count(*) FROM drill WHERE id <= 250")

printf '  rows written before the target : %s (expected 500)\n' "$BEFORE"
printf '  rows written after the target  : %s (expected 0)\n' "$AFTER"
printf '  rows deleted after the target  : %s recovered (expected 250)\n' "$SURVIVING_LOW"

[ "$BEFORE" = "500" ] || fail "committed data was lost: $BEFORE of 500 rows"
# The half that matters. Without it, "the data came back" is satisfied by a
# restore that replayed everything — which is exactly the restore that does not
# help when the thing being recovered from is a deletion.
[ "$AFTER" = "0" ] || fail "recovery ran past the target: $AFTER rows that should not exist"
[ "$SURVIVING_LOW" = "250" ] || fail "the deletion was not undone: $SURVIVING_LOW of 250 rows"

# --- 7. What the objectives were, measured -----------------------------------
step "Result"
RTO=$((RESTORE_FINISHED - RESTORE_STARTED))
WINDOW=$((RESTORE_STARTED - BACKUP_STARTED))

# The instant was honoured exactly — the assertions above are what proves it —
# so no committed data inside the window was lost and the achieved RPO for this
# drill is zero. That is a claim about the *procedure*, not about production:
# the production figure is bounded by `archive_timeout` and by how much WAL the
# real archive destination is holding, neither of which exists here.
RPO=0
record_result Passed "$RPO" "$RTO"

cat <<SUMMARY
  restore_test_result        : pass
  restore_test_rpo_seconds   : ${RPO}
  restore_test_rto_seconds   : ${RTO}
  recovery_target            : ${TARGET}
  base_backup_age_seconds    : ${WINDOW}
  wal_segments_archived      : $(find "$ARCHIVE" -type f | wc -l)

  Measured against a local throwaway cluster, so the RTO is a floor: it excludes
  fetching a backup from an object store, provisioning, and the validation the
  architecture requires before traffic resumes. Treat it as evidence the
  procedure is correct, not as the production number.
SUMMARY

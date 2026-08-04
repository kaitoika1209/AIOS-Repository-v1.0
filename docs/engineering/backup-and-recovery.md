# Backup and Recovery

## Purpose

How AIOS meets baseline item 10 — "continuous WAL archiving, a physical base backup at
least every 24 hours, a 14-day PITR window, a monthly verified restore test, and the
approved RPO and RTO" — and, separately, what part of that is currently **proven** rather
than described.

The distinction matters more here than anywhere else in the baseline, because the
architecture states the failure mode directly:

> Backup-job success is not proof of recoverability.

A backup pipeline that runs nightly, reports success, and cannot be restored is the normal
outcome, not the unlucky one. Nobody finds out until the day it matters.

---

## What is proven

`scripts/restore_drill.sh` performs a real point-in-time recovery and asserts the point was
honoured. It builds a throwaway cluster with WAL archiving on, takes a physical base backup
while the cluster serves, writes rows, records a target instant, then writes more rows and
deletes some of the first set. It restores to the target and checks three things:

| Assertion | Why it is there |
|---|---|
| Rows written before the target are present | The backup and WAL chain are intact |
| Rows written **after** the target are absent | Recovery stopped where it was told to |
| Rows deleted after the target are back | The damage was actually undone |

**The middle assertion is the test.** Without it, "the data came back" is satisfied by a
restore that replayed the whole WAL — which is precisely the restore that does not help
when the thing being recovered from is a bad deployment or a mistaken deletion.

Confirmed by breaking it: with `recovery_target_time` removed, the drill reports 500 rows
that should not exist, 250 rows still missing, and fails. A drill that cannot fail is not
evidence.

Latest run:

```
restore_test_result        : pass
restore_test_rto_seconds   : 2
rows before the target     : 500 (expected 500)
rows after the target      : 0   (expected 0)
rows deleted after target  : 250 recovered (expected 250)
wal segments archived      : 5   (archiver failures: 0)
```

The drill is repeatable, creates its own cluster, and disturbs no existing database, so it
belongs in CI on a schedule as the monthly verified restore test the baseline requires.

---

## What is not proven

Everything about production *storage*, as opposed to the recovery *procedure*:

| Control | State |
|---|---|
| Continuous WAL archiving to durable storage | Not configured — the drill archives to a local directory |
| Physical base backup ≥ every 24 hours | No schedule exists |
| PITR window ≥ 14 days | No retention configured |
| Deletion-resistant copy or tier ≥ 30 days | Not configured |
| Backup encryption at rest, and its key custody | Not configured |
| Monthly restore test | The drill exists; nothing schedules it |
| Quarterly disaster-recovery exercise | Not performed |
| The nine recovery metrics | Not emitted |

The `restore_test_rto_seconds` above is **a floor, not the production number**. It measures
a local restore of a 39 MB cluster and excludes fetching a backup from an object store,
provisioning a database, and the validation the architecture requires before traffic
resumes. Quoting it as an achieved RTO would be the same category of error as quoting a
backup job's exit code as proof of recoverability.

All of it is Stage D infrastructure. Until it exists, **item 10 is Absent** — a correct
procedure with nothing to restore *from* recovers nothing.

---

## Objectives

From `observability-and-operations.md`, unchanged here:

```text
Recovery Point Objective (RPO)              <= 15 minutes
Authoritative Service Recovery Time (RTO)   <= 4 hours
Asynchronous Workflow Recovery Target       <= 8 hours
```

The RPO is what sets `archive_timeout`. WAL is archived when a segment fills *or* when that
timeout elapses, so an idle-but-committing system's exposure is bounded by the timeout
rather than by write volume. A 15-minute RPO with no `archive_timeout` is a 15-minute RPO
only while traffic is heavy enough to fill segments — which is to say, not during the quiet
night when a failure is least likely to be noticed.

---

## Configuration

What the drill sets, and what production needs beyond it:

```conf
wal_level = replica
archive_mode = on
archive_command = '<copy %p to durable storage as %f, atomically, and fail loudly>'
archive_timeout = 60s          # bounds RPO when segments do not fill
```

Three properties the `archive_command` must have, each of which is a way this goes wrong:

- **It must fail when the copy failed.** PostgreSQL treats a zero exit as "archived" and
  moves on; a command that swallows an error silently discards WAL. The drill's command
  refuses to overwrite an existing file for the same reason.
- **It must not overwrite.** A segment written twice with different content makes the chain
  unrecoverable at that point, and nothing detects it until a restore is attempted.
- **The destination must outlive the database host.** Archiving to a volume attached to the
  same instance survives a process crash and nothing else.

`archive_mode` cannot be enabled without a restart. A cluster that has never had it on has
no recovery window at all, which is why the drill sets it before first start rather than
turning it on afterwards.

---

## Runbook 6: PostgreSQL backup or WAL failure, and point-in-time recovery

One of the six the baseline requires. Each must identify "detection signals, safe
containment, prohibited actions, recovery steps, validation, required authorization, and
audit evidence".

### Detection signals

- `wal_archive_lag_seconds` rising, or `latest_restorable_point_age_seconds` above 900
- `pg_stat_archiver.failed_count` increasing
- `backup_integrity_failure_total` non-zero
- `restore_test_age_seconds` above 31 days — a control failure in its own right

An unconfirmed restorable point older than 15 minutes is **Critical even when the most
recent backup job reports success**, because the two are different claims.

### Safe containment

Preserve the last known-good recovery artifacts before changing anything. Restore WAL
continuity first; a gap that widens while the chain is being repaired is the failure
compounding.

### Prohibited actions

- Deleting or overwriting existing WAL segments or base backups while diagnosing
- Cutting over to a recovery point that violates the approved RPO without explicit
  incident authority
- Resuming the Outbox publisher or consumers before the restored consistency boundary
  passes validation
- Blind replay of a non-idempotent external effect whose pre-restore outcome is unknown —
  the affected ordering key stays blocked until the outcome can be proven

### Recovery steps

The full sequence is `observability-and-operations.md` → *Runbook: Production PostgreSQL
Restore*, and it is authoritative. `scripts/restore_drill.sh` is its rehearsal: the same
restore-to-a-target mechanics, against a throwaway cluster, with the outcome asserted.

Points where a rehearsed procedure diverges from the real one, and which therefore need
attention on the day:

1. The base backup comes from an object store, not a local directory. Fetch time dominates
   RTO and is the number the drill cannot measure.
2. Mutation traffic, publishers, consumers, and schedulers stay paused across the whole
   restore. The drill has none of them.
3. Validation before cutover covers schema, migrations, Aggregates, authorization, audit,
   Organization isolation, Outbox, idempotency, and ordering. The drill checks row counts.
4. Only *expired* claims are released. Valid leases and retry history are preserved.

### Validation

`pnpm --filter @aios/api migrate -- --status` must report the chain fully applied — a
restore to a point before a migration leaves code and schema disagreeing, and readiness
already refuses to serve in that state (baseline item 8), which is the intended interaction.

Then the acceptance suite against the restored database, which starts from a schema and
drives the whole loop over HTTP.

### Required authorization

The Incident Commander declares restoration and records the approved target time and
reason. Cutting over to a point that violates the RPO needs explicit incident authority.

### Audit evidence

Achieved RPO and RTO, the selected recovery point, validation results, external-effect
decisions, backlog state, and the approver — in the incident record. A restore with no
recorded achieved RPO cannot be told apart from one that lost a day.

---

## Running the drill

```bash
./scripts/restore_drill.sh
```

Needs PostgreSQL 16 binaries and a non-root user to run the clusters as (`DRILL_USER`,
default `postgres`). It creates and removes everything it uses.

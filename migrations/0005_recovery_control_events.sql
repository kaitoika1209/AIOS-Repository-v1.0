-- Store the evidence the recovery metrics are computed from.
--
-- `observability-and-operations.md` requires the restore-test result, the
-- achieved RPO and RTO, and the age of the latest disaster-recovery exercise to
-- be "observable independently" of whether the backup job succeeded. An age is
-- computable only from a timestamp somebody stored, and until now nothing did:
-- `scripts/restore_drill.sh` printed its result and exited, so a drill that ran
-- last week and a drill that has never run were indistinguishable from outside.
--
-- Additive and platform-scoped. No `organization_id`, because a restore returns
-- every Organization or none — an exercise attributed to one tenant would imply
-- the others were not covered.
--
-- Insert-only by intent: a control event is evidence, and a wrong result is
-- corrected by recording the later test that supersedes it, which is also what
-- actually happened. There is no UPDATE or DELETE path in the repository.
--
-- The documented DDL is in `docs/architecture/persistence-and-data-model.md`
-- under "Recovery Control Evidence".

CREATE TABLE recovery_control_events (
    recovery_control_event_id uuid PRIMARY KEY,

    control_type            text NOT NULL,
    outcome                 text NOT NULL,
    performed_at            timestamptz NOT NULL,

    achieved_rpo_seconds    integer NULL,
    achieved_rto_seconds    integer NULL,

    evidence_reference      text NULL,
    performed_by            text NOT NULL,
    recorded_at             timestamptz NOT NULL,

    CONSTRAINT ck_recovery_control_type CHECK (
        control_type IN ('RestoreTest', 'DisasterRecoveryExercise', 'BackupIntegrityCheck')
    ),

    CONSTRAINT ck_recovery_control_outcome CHECK (
        outcome IN ('Passed', 'Failed')
    ),

    -- Exactly a passing restore test carries achieved figures. A failed restore
    -- measured no RPO — it produced no restored database to measure against —
    -- and a row claiming both a failure and a four-minute achieved RPO is the
    -- false reassurance these metrics exist to prevent. A passing test with
    -- neither figure would satisfy "a test ran" while answering none of the
    -- questions the test was for.
    CONSTRAINT ck_recovery_control_achieved CHECK (
        (control_type = 'RestoreTest' AND outcome = 'Passed')
        = (achieved_rpo_seconds IS NOT NULL AND achieved_rto_seconds IS NOT NULL)
    ),

    CONSTRAINT ck_recovery_control_achieved_sign CHECK (
        (achieved_rpo_seconds IS NULL OR achieved_rpo_seconds >= 0)
        AND (achieved_rto_seconds IS NULL OR achieved_rto_seconds >= 0)
    )
);

CREATE INDEX ix_recovery_control_latest
    ON recovery_control_events (control_type, performed_at DESC);

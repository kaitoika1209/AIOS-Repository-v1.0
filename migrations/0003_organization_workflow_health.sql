-- The rebuildable Organization workflow-health projection (ADR-0023).
--
-- Additive and empty on arrival. No backfill is written here on purpose: the
-- projection's own reconcile builds it from the source tables, and that path has
-- to work anyway — it is the scheduled reconciliation and the rebuild. A
-- backfill in this file would be a second, untested copy of the derivation.
--
-- Until the first reconcile runs, every Organization reports NoData, which is a
-- correct answer rather than a missing one.
--
-- The documented DDL is in `docs/architecture/persistence-and-data-model.md`
-- under "Organization Workflow Health Projection".

CREATE TABLE organization_workflow_health (
    organization_id          uuid NOT NULL,
    workflow_type            text NOT NULL,

    status                   text NOT NULL,
    reason_code              text NOT NULL,

    pending_count            integer NOT NULL DEFAULT 0,
    oldest_pending_at        timestamptz NULL,
    last_attempt_at          timestamptz NULL,
    last_success_at          timestamptz NULL,
    consecutive_failures     integer NOT NULL DEFAULT 0,
    terminal_failure_count   integer NOT NULL DEFAULT 0,
    last_error_code          text NULL,

    source_high_water_mark   timestamptz NOT NULL,
    projection_version       integer NOT NULL,
    updated_at               timestamptz NOT NULL,

    PRIMARY KEY (organization_id, workflow_type),

    CONSTRAINT ck_workflow_health_status CHECK (
        status IN ('Healthy', 'Degraded', 'Blocked', 'Stale', 'NoData', 'Unknown')
    ),

    CONSTRAINT ck_workflow_health_type CHECK (
        workflow_type IN (
            'OutboxPublication', 'ConsumerDelivery', 'DeadLetter', 'MemoryGeneration'
        )
    ),

    FOREIGN KEY (organization_id)
        REFERENCES organizations (organization_id)
);

CREATE INDEX ix_workflow_health_stale
ON organization_workflow_health (
    updated_at
);

-- Administrative Worker pause, scoped to one Organization (ADR-0022).
--
-- Additive and safe on a live database: a new table with no backfill, referenced
-- by one predicate on the Outbox claim. A deployment that has not yet applied
-- this migration runs the previous claim query and pauses nothing, which is the
-- behaviour it has today.
--
-- The documented DDL is in `docs/architecture/persistence-and-data-model.md`
-- under "Worker Pause Persistence"; `migrations.test.ts` compares this against
-- it and fails on any difference in either direction.

CREATE TABLE worker_pauses (
    organization_id         uuid NOT NULL,
    worker_type             text NOT NULL,

    paused_at               timestamptz NOT NULL,
    paused_by_identity_id   uuid NOT NULL,
    paused_by_membership_id uuid NOT NULL,
    reason_code             text NOT NULL,
    reason                  text NOT NULL,

    PRIMARY KEY (organization_id, worker_type),

    CONSTRAINT ck_worker_pause_type CHECK (
        worker_type IN ('OutboxPublication', 'MemoryGeneration')
    ),

    FOREIGN KEY (organization_id)
        REFERENCES organizations (organization_id),

    FOREIGN KEY (organization_id, paused_by_membership_id)
        REFERENCES memberships (organization_id, membership_id)
);

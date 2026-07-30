BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL application_name = 'aios-migration-0001';

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE schema_migrations (
  migration_id text PRIMARY KEY,
  checksum text NOT NULL,
  deployment_id text NOT NULL,
  applied_by text NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  duration_ms bigint NOT NULL CHECK (duration_ms >= 0)
);
COMMIT;

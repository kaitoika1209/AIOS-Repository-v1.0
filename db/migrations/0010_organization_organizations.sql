BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL application_name = 'aios-migration-0010';

CREATE TABLE organizations (
  organization_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  status text NOT NULL CHECK (status IN ('Active','Suspended','Archived')),
  created_by_identity_id uuid NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  suspended_at timestamptz,
  suspension_reason text,
  archived_at timestamptz,
  archive_reason text,
  CONSTRAINT uq_organizations_scope UNIQUE (organization_id),
  CONSTRAINT ck_organizations_lifecycle CHECK (
    (status='Active' AND suspended_at IS NULL AND archived_at IS NULL)
    OR (status='Suspended' AND suspended_at IS NOT NULL AND archived_at IS NULL)
    OR (status='Archived' AND archived_at IS NOT NULL)
  )
);
COMMIT;

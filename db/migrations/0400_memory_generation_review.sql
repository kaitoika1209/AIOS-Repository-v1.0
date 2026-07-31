BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SET LOCAL application_name='aios-migration-0400';

CREATE TABLE memory_source_snapshots(
  memory_source_snapshot_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(organization_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  source_work_id uuid NOT NULL,
  work_completed_event_id uuid NOT NULL,
  terminal_work_version bigint NOT NULL CHECK(terminal_work_version>0),
  work_revision_id uuid NOT NULL,
  source_schema_version integer NOT NULL CHECK(source_schema_version=1),
  snapshot_content jsonb NOT NULL CHECK(jsonb_typeof(snapshot_content)='object' AND pg_column_size(snapshot_content)<=1048576),
  source_snapshot_hash text NOT NULL CHECK(length(source_snapshot_hash) BETWEEN 16 AND 256),
  captured_at timestamptz NOT NULL,
  CONSTRAINT uq_memory_snapshot_work UNIQUE(organization_id,source_work_id),
  CONSTRAINT uq_memory_snapshot_event UNIQUE(organization_id,work_completed_event_id),
  CONSTRAINT uq_memory_snapshot_ownership UNIQUE(organization_id,source_work_id,memory_source_snapshot_id,source_snapshot_hash),
  CONSTRAINT fk_memory_snapshot_work FOREIGN KEY(organization_id,source_work_id) REFERENCES work_items(organization_id,work_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE memory_generation_operations(
  memory_generation_operation_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(organization_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  source_work_id uuid NOT NULL,
  source_event_id uuid NOT NULL,
  source_snapshot_id uuid NOT NULL,
  source_snapshot_hash text NOT NULL,
  provider_input_hash text NOT NULL CHECK(length(provider_input_hash) BETWEEN 16 AND 256),
  generation_policy_version text NOT NULL CHECK(length(btrim(generation_policy_version)) BETWEEN 1 AND 100),
  prompt_policy_version text NOT NULL CHECK(length(btrim(prompt_policy_version)) BETWEEN 1 AND 100),
  status text NOT NULL CHECK(status IN ('Pending','Generating','RetryPending','Generated','Failed','Abandoned')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
  claim_version bigint NOT NULL DEFAULT 0 CHECK(claim_version>=0),
  locked_by text,
  locked_until timestamptz,
  next_attempt_at timestamptz,
  memory_id uuid,
  last_failure_code text CHECK(last_failure_code IS NULL OR length(last_failure_code)<=200),
  abandoned_by_membership_id uuid,
  abandonment_reason text CHECK(abandonment_reason IS NULL OR length(btrim(abandonment_reason)) BETWEEN 1 AND 2000),
  abandonment_idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT uq_memory_generation_work UNIQUE(organization_id,source_work_id),
  CONSTRAINT uq_memory_generation_source_event UNIQUE(organization_id,source_event_id),
  CONSTRAINT uq_memory_generation_ownership UNIQUE(organization_id,source_work_id,memory_generation_operation_id),
  CONSTRAINT fk_memory_operation_snapshot FOREIGN KEY(organization_id,source_work_id,source_snapshot_id,source_snapshot_hash) REFERENCES memory_source_snapshots(organization_id,source_work_id,memory_source_snapshot_id,source_snapshot_hash) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_memory_operation_abandoner FOREIGN KEY(organization_id,abandoned_by_membership_id) REFERENCES memberships(organization_id,membership_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_memory_operation_claim CHECK((status='Generating' AND locked_by IS NOT NULL AND locked_until IS NOT NULL) OR (status<>'Generating' AND locked_by IS NULL AND locked_until IS NULL)),
  CONSTRAINT ck_memory_operation_result CHECK((status='Generated' AND memory_id IS NOT NULL) OR (status<>'Generated' AND memory_id IS NULL)),
  CONSTRAINT ck_memory_operation_abandonment CHECK((status='Abandoned' AND abandoned_by_membership_id IS NOT NULL AND abandonment_reason IS NOT NULL AND abandonment_idempotency_key IS NOT NULL) OR (status<>'Abandoned' AND abandoned_by_membership_id IS NULL AND abandonment_reason IS NULL AND abandonment_idempotency_key IS NULL))
);

CREATE TABLE memories(
  memory_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  source_work_id uuid NOT NULL,
  source_snapshot_id uuid NOT NULL,
  source_snapshot_hash text NOT NULL,
  generation_operation_id uuid NOT NULL,
  provider_input_hash text NOT NULL,
  provider_name text NOT NULL CHECK(length(btrim(provider_name)) BETWEEN 1 AND 100),
  model_name text NOT NULL CHECK(length(btrim(model_name)) BETWEEN 1 AND 200),
  prompt_policy_version text NOT NULL,
  generation_policy_version text NOT NULL,
  status text NOT NULL CHECK(status IN ('Generated','InReview','Rejected','Approved')),
  current_revision_id uuid NOT NULL,
  current_revision_number integer NOT NULL CHECK(current_revision_number>0),
  submitted_revision_id uuid,
  reviewed_revision_id uuid,
  approved_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT uq_memories_work UNIQUE(organization_id,source_work_id),
  CONSTRAINT uq_memories_ownership UNIQUE(organization_id,memory_id),
  CONSTRAINT uq_memories_snapshot UNIQUE(organization_id,memory_id,source_snapshot_id),
  CONSTRAINT fk_memory_work FOREIGN KEY(organization_id,source_work_id) REFERENCES work_items(organization_id,work_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_memory_source_snapshot FOREIGN KEY(organization_id,source_work_id,source_snapshot_id,source_snapshot_hash) REFERENCES memory_source_snapshots(organization_id,source_work_id,memory_source_snapshot_id,source_snapshot_hash) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_memory_operation FOREIGN KEY(organization_id,source_work_id,generation_operation_id) REFERENCES memory_generation_operations(organization_id,source_work_id,memory_generation_operation_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_memory_review_state CHECK(
    (status='Generated' AND submitted_revision_id IS NULL AND reviewed_revision_id IS NULL AND approved_at IS NULL)
    OR (status='InReview' AND submitted_revision_id IS NOT NULL AND reviewed_revision_id IS NULL AND approved_at IS NULL)
    OR (status='Rejected' AND submitted_revision_id IS NOT NULL AND reviewed_revision_id=submitted_revision_id AND approved_at IS NULL)
    OR (status='Approved' AND submitted_revision_id IS NOT NULL AND reviewed_revision_id=submitted_revision_id AND approved_at IS NOT NULL)
  )
);

CREATE TABLE memory_revisions(
  memory_revision_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  memory_id uuid NOT NULL,
  source_snapshot_id uuid NOT NULL,
  revision_number integer NOT NULL CHECK(revision_number>0),
  revision_status text NOT NULL CHECK(revision_status IN ('Draft','Submitted','Rejected','Approved')),
  title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 200),
  summary text NOT NULL CHECK(length(btrim(summary)) BETWEEN 1 AND 10000),
  outcome text NOT NULL CHECK(length(btrim(outcome)) BETWEEN 1 AND 10000),
  lessons_observed jsonb NOT NULL CHECK(jsonb_typeof(lessons_observed)='array' AND jsonb_array_length(lessons_observed)<=100),
  unresolved_items jsonb NOT NULL CHECK(jsonb_typeof(unresolved_items)='array' AND jsonb_array_length(unresolved_items)<=100),
  additional_context text NOT NULL DEFAULT '' CHECK(length(additional_context)<=20000),
  content_hash text,
  created_by_actor_type text NOT NULL CHECK(created_by_actor_type IN ('HumanMember','System')),
  created_by_identity_id uuid REFERENCES human_identities(identity_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_by_membership_id uuid,
  created_by_system_id text,
  submitted_by_identity_id uuid REFERENCES human_identities(identity_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  submitted_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  submitted_at timestamptz,
  locked_at timestamptz,
  CONSTRAINT uq_memory_revision_number UNIQUE(organization_id,memory_id,revision_number),
  CONSTRAINT uq_memory_revision_ownership UNIQUE(organization_id,memory_id,memory_revision_id),
  CONSTRAINT uq_memory_revision_exact UNIQUE(organization_id,memory_id,revision_number,memory_revision_id),
  CONSTRAINT fk_memory_revision_root FOREIGN KEY(organization_id,memory_id,source_snapshot_id) REFERENCES memories(organization_id,memory_id,source_snapshot_id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_memory_revision_creator FOREIGN KEY(organization_id,created_by_membership_id) REFERENCES memberships(organization_id,membership_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_memory_revision_submitter FOREIGN KEY(organization_id,submitted_by_membership_id) REFERENCES memberships(organization_id,membership_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_memory_revision_creator CHECK((created_by_actor_type='HumanMember' AND created_by_identity_id IS NOT NULL AND created_by_membership_id IS NOT NULL AND created_by_system_id IS NULL) OR (created_by_actor_type='System' AND created_by_identity_id IS NULL AND created_by_membership_id IS NULL AND created_by_system_id IS NOT NULL)),
  CONSTRAINT ck_memory_revision_lock CHECK((revision_status='Draft' AND content_hash IS NULL AND submitted_at IS NULL AND locked_at IS NULL AND submitted_by_identity_id IS NULL AND submitted_by_membership_id IS NULL) OR (revision_status<>'Draft' AND content_hash IS NOT NULL AND submitted_at IS NOT NULL AND locked_at IS NOT NULL AND submitted_by_identity_id IS NOT NULL AND submitted_by_membership_id IS NOT NULL))
);

ALTER TABLE memories ADD CONSTRAINT fk_memory_current_revision FOREIGN KEY(organization_id,memory_id,current_revision_number,current_revision_id) REFERENCES memory_revisions(organization_id,memory_id,revision_number,memory_revision_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE memories ADD CONSTRAINT fk_memory_submitted_revision FOREIGN KEY(organization_id,memory_id,submitted_revision_id) REFERENCES memory_revisions(organization_id,memory_id,memory_revision_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE memories ADD CONSTRAINT fk_memory_reviewed_revision FOREIGN KEY(organization_id,memory_id,reviewed_revision_id) REFERENCES memory_revisions(organization_id,memory_id,memory_revision_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE memory_generation_operations ADD CONSTRAINT fk_memory_operation_result FOREIGN KEY(organization_id,memory_id) REFERENCES memories(organization_id,memory_id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE memory_review_records(
  memory_review_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  memory_id uuid NOT NULL,
  memory_revision_id uuid NOT NULL,
  source_snapshot_id uuid NOT NULL,
  source_snapshot_hash text NOT NULL,
  outcome text NOT NULL CHECK(outcome IN ('Rejected','Approved')),
  reviewed_by_identity_id uuid NOT NULL REFERENCES human_identities(identity_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  reviewed_by_membership_id uuid NOT NULL,
  reason text CHECK(reason IS NULL OR length(reason)<=10000),
  reviewed_at timestamptz NOT NULL,
  CONSTRAINT uq_memory_review_revision UNIQUE(organization_id,memory_id,memory_revision_id),
  CONSTRAINT fk_memory_review_revision FOREIGN KEY(organization_id,memory_id,memory_revision_id) REFERENCES memory_revisions(organization_id,memory_id,memory_revision_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_memory_review_snapshot FOREIGN KEY(organization_id,memory_id,source_snapshot_id) REFERENCES memories(organization_id,memory_id,source_snapshot_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_memory_reviewer FOREIGN KEY(organization_id,reviewed_by_membership_id) REFERENCES memberships(organization_id,membership_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_memory_rejection_reason CHECK(outcome<>'Rejected' OR length(btrim(reason))>0)
);

CREATE UNIQUE INDEX uq_memory_one_draft_revision ON memory_revisions(organization_id,memory_id) WHERE revision_status='Draft';
CREATE INDEX ix_memory_review_queue ON memories(organization_id,updated_at) WHERE status='InReview';
CREATE INDEX ix_memory_generation_due ON memory_generation_operations(status,next_attempt_at,created_at) WHERE status IN ('Pending','RetryPending');
CREATE INDEX ix_memory_generation_expired ON memory_generation_operations(locked_until) WHERE status='Generating';

CREATE FUNCTION protect_locked_memory_revision()RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF OLD.revision_status<>'Draft' AND (NEW.title IS DISTINCT FROM OLD.title OR NEW.summary IS DISTINCT FROM OLD.summary OR NEW.outcome IS DISTINCT FROM OLD.outcome OR NEW.lessons_observed IS DISTINCT FROM OLD.lessons_observed OR NEW.unresolved_items IS DISTINCT FROM OLD.unresolved_items OR NEW.additional_context IS DISTINCT FROM OLD.additional_context OR NEW.content_hash IS DISTINCT FROM OLD.content_hash OR NEW.source_snapshot_id IS DISTINCT FROM OLD.source_snapshot_id OR NEW.revision_number IS DISTINCT FROM OLD.revision_number)THEN RAISE EXCEPTION 'submitted Memory revision content is immutable' USING ERRCODE='23514';END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER protect_memory_revision_content BEFORE UPDATE ON memory_revisions FOR EACH ROW EXECUTE FUNCTION protect_locked_memory_revision();

CREATE FUNCTION protect_approved_memory()RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF OLD.status='Approved' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Approved Memory is immutable' USING ERRCODE='23514';END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER protect_approved_memory_root BEFORE UPDATE ON memories FOR EACH ROW EXECUTE FUNCTION protect_approved_memory();

GRANT SELECT,INSERT,UPDATE ON memory_source_snapshots,memory_generation_operations,memories,memory_revisions TO aios_runtime,aios_worker;
GRANT SELECT,INSERT ON memory_review_records TO aios_runtime;
GRANT SELECT ON memory_source_snapshots,memory_generation_operations,memories,memory_revisions,memory_review_records TO aios_readonly,aios_backup;
REVOKE DELETE,TRUNCATE ON memory_source_snapshots,memory_generation_operations,memories,memory_revisions,memory_review_records FROM aios_runtime,aios_worker;
REVOKE UPDATE,DELETE,TRUNCATE ON memory_review_records FROM aios_runtime,aios_worker;
COMMIT;

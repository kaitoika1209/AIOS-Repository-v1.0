BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SET LOCAL application_name='aios-migration-0300';

CREATE TABLE decisions (
  decision_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  related_work_id uuid NOT NULL,
  is_blocking boolean NOT NULL,
  status text NOT NULL CHECK(status IN ('Draft','InReview','Approved','Rejected','Withdrawn')),
  current_revision_id uuid NOT NULL,
  current_revision_number integer NOT NULL CHECK(current_revision_number>0),
  created_by_identity_id uuid NOT NULL REFERENCES human_identities(identity_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_by_membership_id uuid NOT NULL,
  submitted_revision_id uuid,
  submitted_by_identity_id uuid REFERENCES human_identities(identity_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  submitted_by_membership_id uuid,
  submitted_at timestamptz,
  decided_revision_id uuid,
  outcome text CHECK(outcome IN ('Approved','Rejected','Withdrawn')),
  decided_by_identity_id uuid REFERENCES human_identities(identity_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  decided_by_membership_id uuid,
  review_rationale text CHECK(review_rationale IS NULL OR length(review_rationale)<=10000),
  decided_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT uq_decisions_organization_decision UNIQUE(organization_id,decision_id),
  CONSTRAINT fk_decision_work FOREIGN KEY(organization_id,related_work_id) REFERENCES work_items(organization_id,work_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_decision_creator FOREIGN KEY(organization_id,created_by_membership_id) REFERENCES memberships(organization_id,membership_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_decision_submitter FOREIGN KEY(organization_id,submitted_by_membership_id) REFERENCES memberships(organization_id,membership_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_decision_reviewer FOREIGN KEY(organization_id,decided_by_membership_id) REFERENCES memberships(organization_id,membership_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_decision_submission CHECK(
    (status='Draft' AND submitted_revision_id IS NULL AND submitted_at IS NULL AND submitted_by_identity_id IS NULL AND submitted_by_membership_id IS NULL)
    OR (status<>'Draft' AND submitted_revision_id IS NOT NULL AND submitted_at IS NOT NULL AND submitted_by_identity_id IS NOT NULL AND submitted_by_membership_id IS NOT NULL)
  ),
  CONSTRAINT ck_decision_outcome CHECK(
    (status IN ('Draft','InReview') AND outcome IS NULL AND decided_revision_id IS NULL AND decided_at IS NULL AND decided_by_identity_id IS NULL AND decided_by_membership_id IS NULL)
    OR (status IN ('Approved','Rejected','Withdrawn') AND outcome=status AND decided_revision_id=submitted_revision_id AND decided_at IS NOT NULL AND decided_by_identity_id IS NOT NULL AND decided_by_membership_id IS NOT NULL)
  )
);

CREATE TABLE decision_revisions (
  decision_revision_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  decision_id uuid NOT NULL,
  revision_number integer NOT NULL CHECK(revision_number>0),
  revision_status text NOT NULL CHECK(revision_status IN ('Draft','Submitted','Approved','Rejected','Withdrawn')),
  title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 200),
  summary text NOT NULL CHECK(length(btrim(summary)) BETWEEN 1 AND 10000),
  rationale text NOT NULL CHECK(length(btrim(rationale)) BETWEEN 1 AND 10000),
  proposal text NOT NULL CHECK(length(btrim(proposal)) BETWEEN 1 AND 20000),
  supporting_references jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(supporting_references)='array'),
  content_hash text,
  created_by_identity_id uuid NOT NULL REFERENCES human_identities(identity_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  submitted_at timestamptz,
  locked_at timestamptz,
  source_revision_id uuid,
  CONSTRAINT uq_decision_revisions_number UNIQUE(organization_id,decision_id,revision_number),
  CONSTRAINT uq_decision_revisions_ownership UNIQUE(organization_id,decision_id,decision_revision_id),
  CONSTRAINT uq_decision_revisions_exact UNIQUE(organization_id,decision_id,revision_number,decision_revision_id),
  CONSTRAINT fk_revision_decision FOREIGN KEY(organization_id,decision_id) REFERENCES decisions(organization_id,decision_id) ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_revision_creator FOREIGN KEY(organization_id,created_by_membership_id) REFERENCES memberships(organization_id,membership_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_revision_lock CHECK((revision_status='Draft' AND submitted_at IS NULL AND locked_at IS NULL AND content_hash IS NULL) OR (revision_status<>'Draft' AND submitted_at IS NOT NULL AND locked_at IS NOT NULL AND content_hash IS NOT NULL))
);

ALTER TABLE decisions ADD CONSTRAINT fk_decision_current_revision FOREIGN KEY(organization_id,decision_id,current_revision_number,current_revision_id) REFERENCES decision_revisions(organization_id,decision_id,revision_number,decision_revision_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE decisions ADD CONSTRAINT fk_decision_submitted_revision FOREIGN KEY(organization_id,decision_id,submitted_revision_id) REFERENCES decision_revisions(organization_id,decision_id,decision_revision_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE decisions ADD CONSTRAINT fk_decision_decided_revision FOREIGN KEY(organization_id,decision_id,decided_revision_id) REFERENCES decision_revisions(organization_id,decision_id,decision_revision_id) DEFERRABLE INITIALLY DEFERRED;

CREATE UNIQUE INDEX uq_decision_revisions_one_draft ON decision_revisions(organization_id,decision_id) WHERE revision_status='Draft';
CREATE UNIQUE INDEX uq_decisions_one_in_review_blocking_per_work ON decisions(organization_id,related_work_id) WHERE status='InReview' AND is_blocking;

CREATE TABLE decision_review_records (
  decision_review_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  decision_id uuid NOT NULL,
  decision_revision_id uuid NOT NULL,
  outcome text NOT NULL CHECK(outcome IN ('Approved','Rejected','Withdrawn')),
  reviewed_by_identity_id uuid NOT NULL REFERENCES human_identities(identity_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  reviewed_by_membership_id uuid NOT NULL,
  rationale text,
  reviewed_at timestamptz NOT NULL,
  CONSTRAINT uq_decision_review_revision UNIQUE(organization_id,decision_id,decision_revision_id),
  CONSTRAINT fk_review_revision FOREIGN KEY(organization_id,decision_id,decision_revision_id) REFERENCES decision_revisions(organization_id,decision_id,decision_revision_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_review_membership FOREIGN KEY(organization_id,reviewed_by_membership_id) REFERENCES memberships(organization_id,membership_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE FUNCTION protect_locked_decision_revision() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF OLD.revision_status<>'Draft' AND (
    NEW.title IS DISTINCT FROM OLD.title OR NEW.summary IS DISTINCT FROM OLD.summary OR NEW.rationale IS DISTINCT FROM OLD.rationale OR
    NEW.proposal IS DISTINCT FROM OLD.proposal OR NEW.supporting_references IS DISTINCT FROM OLD.supporting_references OR
    NEW.content_hash IS DISTINCT FROM OLD.content_hash OR NEW.revision_number IS DISTINCT FROM OLD.revision_number
  ) THEN RAISE EXCEPTION 'submitted Decision revision content is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_decision_revision_content BEFORE UPDATE ON decision_revisions FOR EACH ROW EXECUTE FUNCTION protect_locked_decision_revision();

ALTER TABLE work_items ADD COLUMN blocking_decision_id uuid, ADD COLUMN blocking_decision_revision_number integer, ADD COLUMN blocking_decision_submitted_snapshot_id uuid;
ALTER TABLE work_items ADD CONSTRAINT ck_work_blocking_reference CHECK(
  (blocking_decision_id IS NULL AND blocking_decision_revision_number IS NULL AND blocking_decision_submitted_snapshot_id IS NULL)
  OR (blocking_decision_id IS NOT NULL AND blocking_decision_revision_number>0 AND blocking_decision_submitted_snapshot_id IS NOT NULL)
);
ALTER TABLE work_items ADD CONSTRAINT ck_work_active_blocking_gate CHECK(
  (status='WaitingForDecision' AND completion_gate_type='Pending' AND blocking_decision_id=completion_gate_decision_id AND blocking_decision_revision_number=completion_gate_revision_number AND blocking_decision_submitted_snapshot_id=completion_gate_submitted_snapshot_id)
  OR (status<>'WaitingForDecision' AND blocking_decision_id IS NULL AND blocking_decision_revision_number IS NULL AND blocking_decision_submitted_snapshot_id IS NULL)
);
ALTER TABLE work_items ADD CONSTRAINT fk_work_blocking_revision FOREIGN KEY(organization_id,blocking_decision_id,blocking_decision_revision_number,blocking_decision_submitted_snapshot_id) REFERENCES decision_revisions(organization_id,decision_id,revision_number,decision_revision_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE work_items ADD CONSTRAINT fk_work_gate_revision FOREIGN KEY(organization_id,completion_gate_decision_id,completion_gate_revision_number,completion_gate_submitted_snapshot_id) REFERENCES decision_revisions(organization_id,decision_id,revision_number,decision_revision_id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE processed_events (
  event_id uuid NOT NULL,
  consumer_name text NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations(organization_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  outcome text NOT NULL CHECK(outcome IN ('Applied','TerminalNoOp','RejectedPoison')),
  aggregate_id uuid,
  processed_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY(event_id,consumer_name)
);

CREATE INDEX ix_decisions_organization_status ON decisions(organization_id,status);
CREATE INDEX ix_decisions_related_work ON decisions(organization_id,related_work_id);
CREATE INDEX ix_decision_revisions_number ON decision_revisions(decision_id,revision_number DESC);
CREATE INDEX ix_decisions_in_review ON decisions(organization_id,submitted_at) WHERE status='InReview';

GRANT SELECT,INSERT,UPDATE ON decisions,decision_revisions TO aios_runtime;
GRANT SELECT,INSERT ON decision_review_records TO aios_runtime;
GRANT SELECT,INSERT ON processed_events TO aios_worker;
GRANT SELECT ON decisions,decision_revisions,decision_review_records,processed_events TO aios_worker,aios_readonly,aios_backup;
REVOKE DELETE,TRUNCATE ON decisions,decision_revisions,decision_review_records,processed_events FROM aios_runtime,aios_worker;
REVOKE UPDATE,DELETE,TRUNCATE ON decision_review_records,processed_events FROM aios_runtime,aios_worker;
COMMIT;

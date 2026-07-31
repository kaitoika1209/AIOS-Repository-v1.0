BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL application_name = 'aios-migration-0200';

CREATE TABLE work_items (
  work_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(organization_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '' CHECK(length(description) <= 20000),
  intended_outcome text NOT NULL CHECK(length(btrim(intended_outcome)) BETWEEN 1 AND 4000),
  status text NOT NULL CHECK(status IN ('Draft','InProgress','WaitingForDecision','Completed','Cancelled')),
  completion_gate_type text NOT NULL DEFAULT 'NotRequired' CHECK(completion_gate_type IN ('NotRequired','Pending','Satisfied','Unsatisfied')),
  completion_gate_decision_id uuid,
  completion_gate_revision_number integer,
  completion_gate_submitted_snapshot_id uuid,
  decision_outcome text CHECK(decision_outcome IN ('Approved','Rejected','Withdrawn')),
  created_by_identity_id uuid NOT NULL REFERENCES human_identities(identity_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_by_membership_id uuid NOT NULL,
  started_by_identity_id uuid REFERENCES human_identities(identity_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  started_by_membership_id uuid,
  started_at timestamptz,
  completed_by_identity_id uuid REFERENCES human_identities(identity_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  completed_by_membership_id uuid,
  completion_summary text CHECK(completion_summary IS NULL OR length(completion_summary)<=10000),
  completed_at timestamptz,
  cancelled_by_identity_id uuid REFERENCES human_identities(identity_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  cancelled_by_membership_id uuid,
  cancellation_reason text CHECK(cancellation_reason IS NULL OR length(btrim(cancellation_reason)) BETWEEN 1 AND 2000),
  cancelled_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT uq_work_items_organization_work UNIQUE(organization_id,work_id),
  CONSTRAINT fk_work_creator_membership FOREIGN KEY(organization_id,created_by_membership_id) REFERENCES memberships(organization_id,membership_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_work_starter_membership FOREIGN KEY(organization_id,started_by_membership_id) REFERENCES memberships(organization_id,membership_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_work_completer_membership FOREIGN KEY(organization_id,completed_by_membership_id) REFERENCES memberships(organization_id,membership_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_work_canceller_membership FOREIGN KEY(organization_id,cancelled_by_membership_id) REFERENCES memberships(organization_id,membership_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_work_started_fields CHECK((status='Draft' AND started_at IS NULL AND started_by_identity_id IS NULL AND started_by_membership_id IS NULL) OR (status<>'Draft' AND started_at IS NOT NULL AND started_by_identity_id IS NOT NULL AND started_by_membership_id IS NOT NULL) OR status='Cancelled'),
  CONSTRAINT ck_work_completed_fields CHECK((status='Completed' AND completed_at IS NOT NULL AND completed_by_identity_id IS NOT NULL AND completed_by_membership_id IS NOT NULL AND cancelled_at IS NULL) OR (status<>'Completed' AND completed_at IS NULL AND completed_by_identity_id IS NULL AND completed_by_membership_id IS NULL)),
  CONSTRAINT ck_work_cancelled_fields CHECK((status='Cancelled' AND cancelled_at IS NOT NULL AND cancelled_by_identity_id IS NOT NULL AND cancelled_by_membership_id IS NOT NULL AND cancellation_reason IS NOT NULL AND completed_at IS NULL) OR (status<>'Cancelled' AND cancelled_at IS NULL AND cancelled_by_identity_id IS NULL AND cancelled_by_membership_id IS NULL AND cancellation_reason IS NULL)),
  CONSTRAINT ck_work_completion_gate CHECK(
    (completion_gate_type='NotRequired' AND completion_gate_decision_id IS NULL AND completion_gate_revision_number IS NULL AND completion_gate_submitted_snapshot_id IS NULL AND decision_outcome IS NULL)
    OR (completion_gate_type='Pending' AND status IN ('WaitingForDecision','Cancelled') AND completion_gate_decision_id IS NOT NULL AND completion_gate_revision_number>0 AND completion_gate_submitted_snapshot_id IS NOT NULL AND decision_outcome IS NULL)
    OR (completion_gate_type='Satisfied' AND completion_gate_decision_id IS NOT NULL AND completion_gate_revision_number>0 AND completion_gate_submitted_snapshot_id IS NOT NULL AND decision_outcome='Approved')
    OR (completion_gate_type='Unsatisfied' AND completion_gate_decision_id IS NOT NULL AND completion_gate_revision_number>0 AND completion_gate_submitted_snapshot_id IS NOT NULL AND decision_outcome IN ('Rejected','Withdrawn'))
  ),
  CONSTRAINT ck_work_waiting_gate CHECK(status<>'WaitingForDecision' OR completion_gate_type='Pending')
);

CREATE TABLE work_assignments (
  work_assignment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  work_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  assignment_type text NOT NULL CHECK(assignment_type IN ('Owner','Assignee')),
  assigned_by_identity_id uuid NOT NULL REFERENCES human_identities(identity_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  assigned_by_membership_id uuid NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  removed_by_identity_id uuid REFERENCES human_identities(identity_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  removed_by_membership_id uuid,
  removed_at timestamptz,
  CONSTRAINT fk_work_assignment_work FOREIGN KEY(organization_id,work_id) REFERENCES work_items(organization_id,work_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_work_assignment_member FOREIGN KEY(organization_id,membership_id) REFERENCES memberships(organization_id,membership_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_work_assignment_actor FOREIGN KEY(organization_id,assigned_by_membership_id) REFERENCES memberships(organization_id,membership_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_work_assignment_remover FOREIGN KEY(organization_id,removed_by_membership_id) REFERENCES memberships(organization_id,membership_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_work_assignment_removal CHECK((removed_at IS NULL AND removed_by_identity_id IS NULL AND removed_by_membership_id IS NULL) OR (removed_at IS NOT NULL AND removed_by_identity_id IS NOT NULL AND removed_by_membership_id IS NOT NULL))
);
CREATE UNIQUE INDEX uq_work_assignments_active ON work_assignments(organization_id,work_id,membership_id,assignment_type) WHERE removed_at IS NULL;

CREATE TABLE work_activity_records (
  work_activity_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  work_id uuid NOT NULL,
  work_version bigint NOT NULL CHECK(work_version>0),
  action text NOT NULL,
  actor_type text NOT NULL CHECK(actor_type IN ('HumanMember','Secretary','System')),
  actor_id uuid NOT NULL,
  actor_membership_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  CONSTRAINT fk_work_activity_work FOREIGN KEY(organization_id,work_id) REFERENCES work_items(organization_id,work_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_work_activity_member FOREIGN KEY(organization_id,actor_membership_id) REFERENCES memberships(organization_id,membership_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_work_activity_actor CHECK((actor_type='HumanMember' AND actor_membership_id IS NOT NULL) OR (actor_type<>'HumanMember' AND actor_membership_id IS NULL)),
  CONSTRAINT uq_work_activity_version UNIQUE(organization_id,work_id,work_version,action)
);

CREATE INDEX ix_work_items_organization_status ON work_items(organization_id,status);
CREATE INDEX ix_work_items_completed_at ON work_items(organization_id,completed_at) WHERE status='Completed';
CREATE INDEX ix_work_assignments_member ON work_assignments(organization_id,membership_id) WHERE removed_at IS NULL;

GRANT SELECT,INSERT,UPDATE ON work_items,work_assignments TO aios_runtime;
GRANT SELECT,INSERT ON work_activity_records TO aios_runtime;
GRANT SELECT ON work_items,work_assignments,work_activity_records TO aios_worker,aios_readonly,aios_backup;
REVOKE DELETE,TRUNCATE ON work_items,work_assignments,work_activity_records FROM aios_runtime,aios_worker;
REVOKE UPDATE,DELETE,TRUNCATE ON work_activity_records FROM aios_runtime,aios_worker;
COMMIT;

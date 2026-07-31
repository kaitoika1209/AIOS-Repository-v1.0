BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SET LOCAL application_name='aios-migration-0500';

ALTER TABLE outbox_messages ADD CONSTRAINT ck_outbox_claim_state CHECK(
 (status='Claimed'AND locked_by IS NOT NULL AND locked_until IS NOT NULL AND published_at IS NULL AND failed_at IS NULL)
 OR(status='Pending'AND locked_by IS NULL AND locked_until IS NULL AND published_at IS NULL AND failed_at IS NULL)
 OR(status='Published'AND locked_by IS NULL AND locked_until IS NULL AND published_at IS NOT NULL AND failed_at IS NULL)
 OR(status='Failed'AND locked_by IS NULL AND locked_until IS NULL AND published_at IS NULL AND failed_at IS NOT NULL)
);
ALTER TABLE outbox_messages ADD CONSTRAINT ck_outbox_bounded_error CHECK(last_error_code IS NULL OR length(last_error_code)<=100);

CREATE TABLE worker_deliveries(
 event_id uuid NOT NULL,
 consumer_name text NOT NULL CHECK(length(btrim(consumer_name))BETWEEN 1 AND 150),
 organization_id uuid NOT NULL REFERENCES organizations(organization_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
 registration_version integer NOT NULL CHECK(registration_version>0),
 handler_version text NOT NULL,
 retry_policy_version text NOT NULL,
 ordering_key_hash text,
 status text NOT NULL CHECK(status IN('Pending','Processing','RetryPending','Blocked','Processed','Failed','Skipped')),
 attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
 claim_version bigint NOT NULL DEFAULT 0 CHECK(claim_version>=0),
 locked_by text,
 locked_until timestamptz,
 next_attempt_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 first_eligible_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 terminal_at timestamptz,
 failure_category text CHECK(failure_category IN('TransientInfrastructure','TransientConcurrency','TransientExternalDependency','PermanentContract','PermanentSecurity','PermanentDomain','Configuration','Unknown')),
 last_error_code text CHECK(last_error_code IS NULL OR length(last_error_code)<=100),
 aggregate_id uuid,
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 PRIMARY KEY(event_id,consumer_name),
 CONSTRAINT ck_worker_delivery_claim CHECK((status='Processing'AND locked_by IS NOT NULL AND locked_until IS NOT NULL)OR(status<>'Processing'AND locked_by IS NULL AND locked_until IS NULL)),
 CONSTRAINT ck_worker_delivery_terminal CHECK((status IN('Processed','Failed','Skipped')AND terminal_at IS NOT NULL)OR(status NOT IN('Processed','Failed','Skipped')AND terminal_at IS NULL)),
 CONSTRAINT ck_worker_delivery_failure CHECK((status='Failed'AND failure_category IS NOT NULL AND last_error_code IS NOT NULL)OR status<>'Failed')
);

CREATE TABLE worker_dead_letters(
 event_id uuid NOT NULL,
 consumer_name text NOT NULL,
 organization_id uuid NOT NULL,
 failure_category text NOT NULL,
 bounded_error_code text NOT NULL CHECK(length(bounded_error_code)<=100),
 ordering_key_hash text,
 opened_at timestamptz NOT NULL,
 resolved_at timestamptz,
 resolution_type text CHECK(resolution_type IN('ReplaySucceeded','SkippedByHuman','Superseded')),
 PRIMARY KEY(event_id,consumer_name),
 CONSTRAINT fk_dead_letter_delivery FOREIGN KEY(event_id,consumer_name)REFERENCES worker_deliveries(event_id,consumer_name)ON UPDATE RESTRICT ON DELETE RESTRICT,
 CONSTRAINT ck_dead_letter_resolution CHECK((resolved_at IS NULL AND resolution_type IS NULL)OR(resolved_at IS NOT NULL AND resolution_type IS NOT NULL))
);

CREATE TABLE worker_replay_requests(
 replay_request_id uuid PRIMARY KEY,
 organization_id uuid NOT NULL,
 event_id uuid NOT NULL,
 consumer_name text NOT NULL,
 replay_mode text NOT NULL CHECK(replay_mode IN('ValidateOnly','RetryOriginal','ReprocessWithCurrentHandler')),
 status text NOT NULL CHECK(status IN('Requested','Claimed','Succeeded','Rejected','Failed')),
 requested_by_identity_id uuid NOT NULL REFERENCES human_identities(identity_id)ON UPDATE RESTRICT ON DELETE RESTRICT,
 requested_by_membership_id uuid NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason))BETWEEN 1 AND 2000),
 idempotency_key text NOT NULL,
 claim_version bigint NOT NULL DEFAULT 0,
 locked_by text,
 locked_until timestamptz,
 requested_at timestamptz NOT NULL,
 completed_at timestamptz,
 outcome_code text CHECK(outcome_code IS NULL OR length(outcome_code)<=100),
 CONSTRAINT uq_worker_replay_idempotency UNIQUE(organization_id,idempotency_key),
 CONSTRAINT uq_worker_replay_active UNIQUE(organization_id,event_id,consumer_name,status),
 CONSTRAINT fk_replay_delivery FOREIGN KEY(event_id,consumer_name)REFERENCES worker_deliveries(event_id,consumer_name)ON UPDATE RESTRICT ON DELETE RESTRICT,
 CONSTRAINT fk_replay_member FOREIGN KEY(organization_id,requested_by_membership_id)REFERENCES memberships(organization_id,membership_id)ON UPDATE RESTRICT ON DELETE RESTRICT,
 CONSTRAINT ck_replay_claim CHECK((status='Claimed'AND locked_by IS NOT NULL AND locked_until IS NOT NULL)OR(status<>'Claimed'AND locked_by IS NULL AND locked_until IS NULL)),
 CONSTRAINT ck_replay_terminal CHECK((status IN('Succeeded','Rejected','Failed')AND completed_at IS NOT NULL AND outcome_code IS NOT NULL)OR(status IN('Requested','Claimed')AND completed_at IS NULL))
);

CREATE TABLE reconciliation_findings(
 finding_id uuid PRIMARY KEY,
 organization_id uuid REFERENCES organizations(organization_id)ON UPDATE RESTRICT ON DELETE RESTRICT,
 finding_type text NOT NULL,
 severity text NOT NULL CHECK(severity IN('Warning','Major','Critical')),
 resource_type text NOT NULL,
 resource_id uuid,
 bounded_code text NOT NULL CHECK(length(bounded_code)<=100),
 status text NOT NULL CHECK(status IN('Open','Acknowledged','Resolved')),
 detected_at timestamptz NOT NULL,
 acknowledged_by_membership_id uuid,
 resolved_at timestamptz,
 CONSTRAINT fk_finding_acknowledger FOREIGN KEY(organization_id,acknowledged_by_membership_id)REFERENCES memberships(organization_id,membership_id)ON UPDATE RESTRICT ON DELETE RESTRICT,
 CONSTRAINT ck_finding_resolution CHECK((status='Resolved'AND resolved_at IS NOT NULL)OR(status<>'Resolved'AND resolved_at IS NULL))
);

CREATE TABLE recovery_evidence(
 recovery_evidence_id uuid PRIMARY KEY,
 evidence_type text NOT NULL CHECK(evidence_type IN('Backup','PITR','RestoreTest','PostRestoreReconciliation','DeletionReplay')),
 environment text NOT NULL,
 artifact_fingerprint text NOT NULL,
 schema_fingerprint text NOT NULL,
 started_at timestamptz NOT NULL,
 completed_at timestamptz,
 outcome text CHECK(outcome IN('Succeeded','Failed')),
 measured_rpo_seconds integer CHECK(measured_rpo_seconds IS NULL OR measured_rpo_seconds>=0),
 measured_rto_seconds integer CHECK(measured_rto_seconds IS NULL OR measured_rto_seconds>=0),
 verified_by_identity_id uuid REFERENCES human_identities(identity_id)ON UPDATE RESTRICT ON DELETE RESTRICT,
 notes_code text CHECK(notes_code IS NULL OR length(notes_code)<=100),
 CONSTRAINT ck_recovery_terminal CHECK((completed_at IS NULL AND outcome IS NULL)OR(completed_at IS NOT NULL AND outcome IS NOT NULL))
);

CREATE INDEX ix_worker_deliveries_claim ON worker_deliveries(status,next_attempt_at,first_eligible_at,event_id)WHERE status IN('Pending','RetryPending','Blocked');
CREATE INDEX ix_worker_deliveries_expired ON worker_deliveries(locked_until)WHERE status='Processing';
CREATE INDEX ix_worker_deliveries_fairness ON worker_deliveries(organization_id,status,next_attempt_at);
CREATE INDEX ix_worker_dead_letters_open ON worker_dead_letters(opened_at)WHERE resolved_at IS NULL;
CREATE INDEX ix_worker_replays_requested ON worker_replay_requests(requested_at)WHERE status='Requested';
CREATE INDEX ix_reconciliation_open ON reconciliation_findings(severity,detected_at)WHERE status<>'Resolved';

GRANT SELECT,INSERT,UPDATE ON worker_deliveries,worker_dead_letters,worker_replay_requests,reconciliation_findings,recovery_evidence TO aios_worker;
GRANT SELECT,INSERT ON worker_replay_requests TO aios_runtime;
GRANT SELECT ON worker_deliveries,worker_dead_letters,worker_replay_requests,reconciliation_findings,recovery_evidence TO aios_runtime,aios_readonly,aios_backup;
REVOKE DELETE,TRUNCATE ON worker_deliveries,worker_dead_letters,worker_replay_requests,reconciliation_findings,recovery_evidence FROM aios_runtime,aios_worker;
COMMIT;

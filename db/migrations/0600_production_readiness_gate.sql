BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SET LOCAL application_name='aios-migration-0600';

CREATE TABLE release_candidates(
 release_candidate_id uuid PRIMARY KEY,
 environment_id text NOT NULL CHECK(length(btrim(environment_id))BETWEEN 1 AND 200),
 release_artifact_digest text NOT NULL CHECK(release_artifact_digest~'^sha256:[a-f0-9]{64}$'),
 schema_fingerprint text NOT NULL CHECK(schema_fingerprint~'^[a-f0-9]{32,128}$'),
 control_version text NOT NULL CHECK(control_version='mvp-production-gate-v1'),
 critical_vulnerability_count integer NOT NULL DEFAULT 0 CHECK(critical_vulnerability_count>=0),
 status text NOT NULL CHECK(status IN('CollectingEvidence','ReadyForDecision','Approved','Rejected','Expired')),
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 decided_at timestamptz,
 CONSTRAINT uq_release_candidate_identity UNIQUE(environment_id,release_artifact_digest,schema_fingerprint),
 CONSTRAINT ck_release_candidate_decision CHECK((status IN('Approved','Rejected')AND decided_at IS NOT NULL)OR(status NOT IN('Approved','Rejected')AND decided_at IS NULL)),
 CONSTRAINT ck_release_candidate_approval_vulnerabilities CHECK(status<>'Approved'OR critical_vulnerability_count=0)
);

CREATE TABLE production_gate_evidence(
 gate_evidence_id uuid PRIMARY KEY,
 release_candidate_id uuid NOT NULL REFERENCES release_candidates(release_candidate_id)ON UPDATE RESTRICT ON DELETE RESTRICT,
 gate_name text NOT NULL CHECK(gate_name IN('DomainAuthority','TenantIsolation','IdentityAuthorization','DataProtection','DatabaseMigration','AsyncCorrectness','Recovery','ObservabilityIncidentResponse','ReleaseSafety','CapacityDependencies')),
 result text NOT NULL CHECK(result IN('Passed','Failed','NotExecuted')),
 human_owner_identity_id uuid NOT NULL REFERENCES human_identities(identity_id)ON UPDATE RESTRICT ON DELETE RESTRICT,
 executed_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL CHECK(expires_at>executed_at),
 evidence_references jsonb NOT NULL CHECK(jsonb_typeof(evidence_references)='array'AND jsonb_array_length(evidence_references)>0),
 evidence_digest text NOT NULL CHECK(evidence_digest~'^sha256:[a-f0-9]{64}$'),
 exception_reference text,
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 CONSTRAINT uq_production_gate_evidence UNIQUE(release_candidate_id,gate_name),
 CONSTRAINT ck_gate_pass_exception CHECK(result<>'Passed'OR exception_reference IS NULL)
);

CREATE TABLE production_gate_exceptions(
 exception_id uuid PRIMARY KEY,
 release_candidate_id uuid NOT NULL REFERENCES release_candidates(release_candidate_id)ON UPDATE RESTRICT ON DELETE RESTRICT,
 gate_name text NOT NULL,
 exception_reference text NOT NULL,
 blast_radius text NOT NULL CHECK(length(btrim(blast_radius))BETWEEN 1 AND 2000),
 compensating_control text NOT NULL CHECK(length(btrim(compensating_control))BETWEEN 1 AND 4000),
 remediation text NOT NULL CHECK(length(btrim(remediation))BETWEEN 1 AND 4000),
 approved_by_identity_id uuid NOT NULL REFERENCES human_identities(identity_id)ON UPDATE RESTRICT ON DELETE RESTRICT,
 approved_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL CHECK(expires_at>approved_at),
 non_waivable_invariant_affected boolean NOT NULL,
 CONSTRAINT uq_gate_exception_reference UNIQUE(release_candidate_id,exception_reference),
 CONSTRAINT ck_gate_exception_nonwaivable CHECK(non_waivable_invariant_affected=false)
);

CREATE TABLE release_approvals(
 release_approval_id uuid PRIMARY KEY,
 release_candidate_id uuid NOT NULL REFERENCES release_candidates(release_candidate_id)ON UPDATE RESTRICT ON DELETE RESTRICT,
 approval_role text NOT NULL CHECK(approval_role IN('ProductDomain','Security','DatabaseData','Operations','Release')),
 approver_identity_id uuid NOT NULL REFERENCES human_identities(identity_id)ON UPDATE RESTRICT ON DELETE RESTRICT,
 decision text NOT NULL CHECK(decision IN('Approved','Rejected')),
 evidence_set_digest text NOT NULL CHECK(evidence_set_digest~'^sha256:[a-f0-9]{64}$'),
 reason_code text NOT NULL CHECK(length(reason_code)<=100),
 decided_at timestamptz NOT NULL,
 CONSTRAINT uq_release_approval_role UNIQUE(release_candidate_id,approval_role)
);

CREATE FUNCTION enforce_release_candidate_approval()RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE gate_count integer;approval_count integer;expired_count integer;failed_count integer;digest_count integer;
BEGIN
 IF NEW.status='Approved'AND OLD.status<>'Approved'THEN
  SELECT count(*),count(*)FILTER(WHERE result<>'Passed'),count(*)FILTER(WHERE expires_at<=transaction_timestamp())INTO gate_count,failed_count,expired_count FROM public.production_gate_evidence WHERE release_candidate_id=NEW.release_candidate_id;
  SELECT count(*),count(DISTINCT evidence_set_digest)INTO approval_count,digest_count FROM public.release_approvals WHERE release_candidate_id=NEW.release_candidate_id AND decision='Approved';
  IF gate_count<>10 OR failed_count<>0 OR expired_count<>0 THEN RAISE EXCEPTION 'production gates are incomplete, failed, or expired' USING ERRCODE='23514';END IF;
  IF approval_count<>5 OR digest_count<>1 THEN RAISE EXCEPTION 'all five Human approval roles must approve one evidence set' USING ERRCODE='23514';END IF;
  IF NEW.critical_vulnerability_count<>0 THEN RAISE EXCEPTION 'critical vulnerabilities block production' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER enforce_release_approval BEFORE UPDATE OF status ON release_candidates FOR EACH ROW EXECUTE FUNCTION enforce_release_candidate_approval();

CREATE FUNCTION record_release_candidate_decision(candidate_id uuid,new_status text)RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF new_status NOT IN('Approved','Rejected')THEN RAISE EXCEPTION 'final release decision must be Approved or Rejected' USING ERRCODE='22023';END IF;
 UPDATE public.release_candidates SET status=new_status,decided_at=transaction_timestamp()WHERE release_candidate_id=candidate_id AND status IN('CollectingEvidence','ReadyForDecision');
 IF NOT FOUND THEN RAISE EXCEPTION 'release candidate is not ready for a final decision' USING ERRCODE='23514';END IF;
END$$;

CREATE FUNCTION protect_release_evidence()RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN RAISE EXCEPTION 'production evidence and approvals are append-only' USING ERRCODE='23514';END$$;
CREATE TRIGGER protect_gate_evidence BEFORE UPDATE OR DELETE ON production_gate_evidence FOR EACH ROW EXECUTE FUNCTION protect_release_evidence();
CREATE TRIGGER protect_gate_exception BEFORE UPDATE OR DELETE ON production_gate_exceptions FOR EACH ROW EXECUTE FUNCTION protect_release_evidence();
CREATE TRIGGER protect_release_approval BEFORE UPDATE OR DELETE ON release_approvals FOR EACH ROW EXECUTE FUNCTION protect_release_evidence();

CREATE INDEX ix_release_candidates_status ON release_candidates(status,created_at);
CREATE INDEX ix_gate_evidence_expiry ON production_gate_evidence(expires_at);
GRANT SELECT,INSERT ON release_candidates,production_gate_evidence,production_gate_exceptions,release_approvals TO aios_runtime;
GRANT EXECUTE ON FUNCTION record_release_candidate_decision(uuid,text)TO aios_runtime;
GRANT SELECT ON release_candidates,production_gate_evidence,production_gate_exceptions,release_approvals TO aios_worker,aios_readonly,aios_backup;
REVOKE UPDATE,DELETE,TRUNCATE ON production_gate_evidence,production_gate_exceptions,release_approvals FROM aios_runtime,aios_worker;
REVOKE DELETE,TRUNCATE ON release_candidates FROM aios_runtime,aios_worker;
COMMIT;

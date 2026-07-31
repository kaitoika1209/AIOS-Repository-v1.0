\set ON_ERROR_STOP on
BEGIN;
INSERT INTO human_identities(identity_id,status,display_name)VALUES
('06000000-0000-0000-0000-000000000001','Active','Product Owner'),
('06000000-0000-0000-0000-000000000002','Active','Security Owner'),
('06000000-0000-0000-0000-000000000003','Active','Database Owner'),
('06000000-0000-0000-0000-000000000004','Active','Operations Owner'),
('06000000-0000-0000-0000-000000000005','Active','Release Owner');
INSERT INTO release_candidates(release_candidate_id,environment_id,release_artifact_digest,schema_fingerprint,status,control_version)VALUES('86000000-0000-0000-0000-000000000001','production-test','sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','CollectingEvidence','mvp-production-gate-v1');
DO $$BEGIN BEGIN UPDATE release_candidates SET status='Approved',decided_at=now()WHERE release_candidate_id='86000000-0000-0000-0000-000000000001';RAISE EXCEPTION 'candidate approved without evidence';EXCEPTION WHEN check_violation THEN NULL;END;END$$;
INSERT INTO production_gate_evidence(gate_evidence_id,release_candidate_id,gate_name,result,human_owner_identity_id,executed_at,expires_at,evidence_references,evidence_digest)
SELECT gen_random_uuid(),'86000000-0000-0000-0000-000000000001',gate,'Passed','06000000-0000-0000-0000-000000000001',now(),now()+interval'30 days',jsonb_build_array('ci://verified'),'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'FROM unnest(ARRAY['DomainAuthority','TenantIsolation','IdentityAuthorization','DataProtection','DatabaseMigration','AsyncCorrectness','Recovery','ObservabilityIncidentResponse','ReleaseSafety','CapacityDependencies'])gate;
INSERT INTO release_approvals(release_approval_id,release_candidate_id,approval_role,approver_identity_id,decision,evidence_set_digest,reason_code,decided_at)VALUES
(gen_random_uuid(),'86000000-0000-0000-0000-000000000001','ProductDomain','06000000-0000-0000-0000-000000000001','Approved','sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd','VERIFIED',now()),
(gen_random_uuid(),'86000000-0000-0000-0000-000000000001','Security','06000000-0000-0000-0000-000000000002','Approved','sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd','VERIFIED',now()),
(gen_random_uuid(),'86000000-0000-0000-0000-000000000001','DatabaseData','06000000-0000-0000-0000-000000000003','Approved','sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd','VERIFIED',now()),
(gen_random_uuid(),'86000000-0000-0000-0000-000000000001','Operations','06000000-0000-0000-0000-000000000004','Approved','sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd','VERIFIED',now()),
(gen_random_uuid(),'86000000-0000-0000-0000-000000000001','Release','06000000-0000-0000-0000-000000000005','Approved','sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd','VERIFIED',now());
UPDATE release_candidates SET status='Approved',decided_at=now()WHERE release_candidate_id='86000000-0000-0000-0000-000000000001';
DO $$BEGIN IF(SELECT status FROM release_candidates WHERE release_candidate_id='86000000-0000-0000-0000-000000000001')<>'Approved'THEN RAISE EXCEPTION 'complete Human-approved evidence set was rejected';END IF;BEGIN UPDATE release_approvals SET decision='Rejected'WHERE approval_role='Release';RAISE EXCEPTION 'approval evidence was mutable';EXCEPTION WHEN check_violation THEN NULL;END;END$$;
ROLLBACK;

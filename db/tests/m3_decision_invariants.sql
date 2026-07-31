\set ON_ERROR_STOP on
BEGIN;
SET CONSTRAINTS ALL DEFERRED;
INSERT INTO human_identities(identity_id,status,display_name)VALUES('02000000-0000-0000-0000-000000000001','Active','M3 Owner');
INSERT INTO organizations(organization_id,name,status,created_by_identity_id)VALUES('12000000-0000-0000-0000-000000000001','M3 Org','Active','02000000-0000-0000-0000-000000000001');
INSERT INTO memberships(membership_id,organization_id,identity_id,status,activated_at)VALUES('22000000-0000-0000-0000-000000000001','12000000-0000-0000-0000-000000000001','02000000-0000-0000-0000-000000000001','Active',now());
INSERT INTO membership_role_assignments(organization_id,membership_id,role,assigned_by_identity_id,assigned_by_membership_id)VALUES('12000000-0000-0000-0000-000000000001','22000000-0000-0000-0000-000000000001','OrganizationOwner','02000000-0000-0000-0000-000000000001','22000000-0000-0000-0000-000000000001');
INSERT INTO work_items(work_id,organization_id,title,intended_outcome,status,created_by_identity_id,created_by_membership_id,started_by_identity_id,started_by_membership_id,started_at,version)VALUES('42000000-0000-0000-0000-000000000001','12000000-0000-0000-0000-000000000001','M3 Work','Reviewed result','InProgress','02000000-0000-0000-0000-000000000001','22000000-0000-0000-0000-000000000001','02000000-0000-0000-0000-000000000001','22000000-0000-0000-0000-000000000001',now(),2);

INSERT INTO decisions(decision_id,organization_id,related_work_id,is_blocking,status,current_revision_id,current_revision_number,created_by_identity_id,created_by_membership_id)VALUES('32000000-0000-0000-0000-000000000001','12000000-0000-0000-0000-000000000001','42000000-0000-0000-0000-000000000001',true,'Draft','33000000-0000-0000-0000-000000000001',1,'02000000-0000-0000-0000-000000000001','22000000-0000-0000-0000-000000000001');
INSERT INTO decision_revisions(decision_revision_id,organization_id,decision_id,revision_number,revision_status,title,summary,rationale,proposal,created_by_identity_id,created_by_membership_id)VALUES('33000000-0000-0000-0000-000000000001','12000000-0000-0000-0000-000000000001','32000000-0000-0000-0000-000000000001',1,'Draft','Proceed?','Review','Risk','Proceed','02000000-0000-0000-0000-000000000001','22000000-0000-0000-0000-000000000001');
UPDATE decision_revisions SET revision_status='Submitted',content_hash='hash-1',submitted_at=now(),locked_at=now()WHERE decision_revision_id='33000000-0000-0000-0000-000000000001';
UPDATE decisions SET status='InReview',submitted_revision_id='33000000-0000-0000-0000-000000000001',submitted_by_identity_id='02000000-0000-0000-0000-000000000001',submitted_by_membership_id='22000000-0000-0000-0000-000000000001',submitted_at=now(),version=2 WHERE decision_id='32000000-0000-0000-0000-000000000001';
UPDATE work_items SET status='WaitingForDecision',completion_gate_type='Pending',completion_gate_decision_id='32000000-0000-0000-0000-000000000001',completion_gate_revision_number=1,completion_gate_submitted_snapshot_id='33000000-0000-0000-0000-000000000001',blocking_decision_id='32000000-0000-0000-0000-000000000001',blocking_decision_revision_number=1,blocking_decision_submitted_snapshot_id='33000000-0000-0000-0000-000000000001',version=3 WHERE work_id='42000000-0000-0000-0000-000000000001';

DO $$BEGIN
 BEGIN UPDATE decision_revisions SET proposal='tampered'WHERE decision_revision_id='33000000-0000-0000-0000-000000000001';RAISE EXCEPTION 'submitted revision was mutable';EXCEPTION WHEN check_violation THEN NULL;END;
END$$;

UPDATE decision_revisions SET revision_status='Approved'WHERE decision_revision_id='33000000-0000-0000-0000-000000000001';
UPDATE decisions SET status='Approved',outcome='Approved',decided_revision_id='33000000-0000-0000-0000-000000000001',decided_by_identity_id='02000000-0000-0000-0000-000000000001',decided_by_membership_id='22000000-0000-0000-0000-000000000001',decided_at=now(),version=3 WHERE decision_id='32000000-0000-0000-0000-000000000001';
INSERT INTO decision_review_records(decision_review_id,organization_id,decision_id,decision_revision_id,outcome,reviewed_by_identity_id,reviewed_by_membership_id,reviewed_at)VALUES('34000000-0000-0000-0000-000000000001','12000000-0000-0000-0000-000000000001','32000000-0000-0000-0000-000000000001','33000000-0000-0000-0000-000000000001','Approved','02000000-0000-0000-0000-000000000001','22000000-0000-0000-0000-000000000001',now());

DO $$BEGIN IF(SELECT status FROM work_items WHERE work_id='42000000-0000-0000-0000-000000000001')<>'WaitingForDecision'THEN RAISE EXCEPTION 'Decision approval completed or otherwise mutated Work';END IF;END$$;

UPDATE work_items SET status='InProgress',completion_gate_type='Satisfied',decision_outcome='Approved',blocking_decision_id=NULL,blocking_decision_revision_number=NULL,blocking_decision_submitted_snapshot_id=NULL,version=4 WHERE work_id='42000000-0000-0000-0000-000000000001'AND version=3;
INSERT INTO processed_events(event_id,consumer_name,organization_id,outcome,aggregate_id)VALUES('52000000-0000-0000-0000-000000000001','work-completion-gate-v1','12000000-0000-0000-0000-000000000001','Applied','42000000-0000-0000-0000-000000000001');
DO $$BEGIN
 BEGIN INSERT INTO processed_events(event_id,consumer_name,organization_id,outcome,aggregate_id)VALUES('52000000-0000-0000-0000-000000000001','work-completion-gate-v1','12000000-0000-0000-0000-000000000001','Applied','42000000-0000-0000-0000-000000000001');RAISE EXCEPTION 'duplicate outcome event was accepted';EXCEPTION WHEN unique_violation THEN NULL;END;
 IF(SELECT status FROM work_items WHERE work_id='42000000-0000-0000-0000-000000000001')<>'InProgress'THEN RAISE EXCEPTION 'outcome did not deterministically return Work to InProgress';END IF;
END$$;
ROLLBACK;

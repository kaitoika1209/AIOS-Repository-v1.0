\set ON_ERROR_STOP on
BEGIN;
INSERT INTO human_identities(identity_id,status,display_name) VALUES
 ('01000000-0000-0000-0000-000000000001','Active','M2 Owner'),
 ('01000000-0000-0000-0000-000000000002','Active','M2 Member');
INSERT INTO organizations(organization_id,name,status,created_by_identity_id) VALUES
 ('11000000-0000-0000-0000-000000000001','M2 Alpha','Active','01000000-0000-0000-0000-000000000001'),
 ('11000000-0000-0000-0000-000000000002','M2 Beta','Active','01000000-0000-0000-0000-000000000002');
INSERT INTO memberships(membership_id,organization_id,identity_id,status,activated_at) VALUES
 ('21000000-0000-0000-0000-000000000001','11000000-0000-0000-0000-000000000001','01000000-0000-0000-0000-000000000001','Active',now()),
 ('21000000-0000-0000-0000-000000000002','11000000-0000-0000-0000-000000000002','01000000-0000-0000-0000-000000000002','Active',now());
INSERT INTO membership_role_assignments(organization_id,membership_id,role,assigned_by_identity_id,assigned_by_membership_id) VALUES
 ('11000000-0000-0000-0000-000000000001','21000000-0000-0000-0000-000000000001','OrganizationOwner','01000000-0000-0000-0000-000000000001','21000000-0000-0000-0000-000000000001'),
 ('11000000-0000-0000-0000-000000000002','21000000-0000-0000-0000-000000000002','OrganizationOwner','01000000-0000-0000-0000-000000000002','21000000-0000-0000-0000-000000000002');

INSERT INTO work_items(work_id,organization_id,title,intended_outcome,status,created_by_identity_id,created_by_membership_id)
VALUES('41000000-0000-0000-0000-000000000001','11000000-0000-0000-0000-000000000001','M2 Work','Complete safely','Draft','01000000-0000-0000-0000-000000000001','21000000-0000-0000-0000-000000000001');

DO $$ BEGIN
  BEGIN
    INSERT INTO work_assignments(organization_id,work_id,membership_id,assignment_type,assigned_by_identity_id,assigned_by_membership_id)
    VALUES('11000000-0000-0000-0000-000000000001','41000000-0000-0000-0000-000000000001','21000000-0000-0000-0000-000000000002','Assignee','01000000-0000-0000-0000-000000000001','21000000-0000-0000-0000-000000000001');
    RAISE EXCEPTION 'foreign-Organization assignment was accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
END $$;

UPDATE work_items SET status='InProgress',started_by_identity_id='01000000-0000-0000-0000-000000000001',started_by_membership_id='21000000-0000-0000-0000-000000000001',started_at=now(),version=2 WHERE work_id='41000000-0000-0000-0000-000000000001' AND version=1;

DO $$ BEGIN
  BEGIN
    UPDATE work_items SET status='Completed',completed_at=now() WHERE work_id='41000000-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'completion without Human attribution was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
END $$;

WITH completed AS (
  UPDATE work_items SET status='Completed',completed_by_identity_id='01000000-0000-0000-0000-000000000001',completed_by_membership_id='21000000-0000-0000-0000-000000000001',completed_at=now(),version=3
   WHERE organization_id='11000000-0000-0000-0000-000000000001' AND work_id='41000000-0000-0000-0000-000000000001' AND version=2 RETURNING *
)
INSERT INTO outbox_messages(event_id,event_type,event_category,schema_version,aggregate_type,aggregate_id,aggregate_version,event_sequence,organization_id,payload,destination,occurred_at,correlation_id,actor_type,actor_id,actor_membership_id)
SELECT '51000000-0000-0000-0000-000000000001','WorkCompleted','Integration',1,'Work',work_id,version,1,organization_id,jsonb_build_object('workId',work_id,'terminalVersion',version),'local.memory-generation',completed_at,'61000000-0000-0000-0000-000000000001','HumanMember',completed_by_identity_id,completed_by_membership_id FROM completed;

DO $$ BEGIN
  IF (SELECT count(*) FROM outbox_messages WHERE event_type='WorkCompleted' AND aggregate_id='41000000-0000-0000-0000-000000000001')<>1 THEN RAISE EXCEPTION 'WorkCompleted was not stored exactly once'; END IF;
  IF has_table_privilege('aios_runtime','work_activity_records','UPDATE') OR has_table_privilege('aios_runtime','work_activity_records','DELETE') THEN RAISE EXCEPTION 'runtime can rewrite Work audit history'; END IF;
END $$;
ROLLBACK;

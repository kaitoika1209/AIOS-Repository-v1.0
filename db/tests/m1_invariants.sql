\set ON_ERROR_STOP on
BEGIN;
SET CONSTRAINTS ALL DEFERRED;
INSERT INTO human_identities(identity_id,status,display_name) VALUES
 ('00000000-0000-0000-0000-000000000001','Active','Owner'),
 ('00000000-0000-0000-0000-000000000002','Active','Member');
INSERT INTO organizations(organization_id,name,status,created_by_identity_id) VALUES
 ('10000000-0000-0000-0000-000000000001','Alpha','Active','00000000-0000-0000-0000-000000000001'),
 ('10000000-0000-0000-0000-000000000002','Beta','Active','00000000-0000-0000-0000-000000000002');
INSERT INTO memberships(membership_id,organization_id,identity_id,status,activated_at) VALUES
 ('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','Active',now()),
 ('20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000002','Active',now());
INSERT INTO membership_role_assignments(organization_id,membership_id,role,assigned_by_identity_id,assigned_by_membership_id) VALUES
 ('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','OrganizationOwner','00000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001'),
 ('10000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000002','OrganizationOwner','00000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000002');

DO $$ BEGIN
  BEGIN
    INSERT INTO membership_role_assignments(organization_id,membership_id,role,assigned_by_identity_id,assigned_by_membership_id)
    VALUES('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000002','Member','00000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001');
    RAISE EXCEPTION 'cross-organization role assignment was accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
END $$;

DO $$ BEGIN
  BEGIN
    UPDATE membership_role_assignments SET revoked_at=now() WHERE organization_id='10000000-0000-0000-0000-000000000001' AND role='OrganizationOwner';
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'last owner removal was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
END $$;

INSERT INTO authorization_audit_records(
  request_id, correlation_id, principal_id, principal_type,
  identity_id, membership_id, organization_id,
  command_type, permission, policy_id, policy_version,
  outcome, reason_code, evaluated_at
) VALUES (
  '30000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000001', 'HumanMember',
  '00000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001', 'ReadMembership', 'membership.read',
  'm1-test-policy', 1, 'Allow', 'test', now()
);

DO $$ BEGIN
  BEGIN
    SET LOCAL ROLE aios_runtime;
    UPDATE authorization_audit_records SET reason_code='tampered';
    RAISE EXCEPTION 'runtime role changed append-only authorization audit data';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
ROLLBACK;

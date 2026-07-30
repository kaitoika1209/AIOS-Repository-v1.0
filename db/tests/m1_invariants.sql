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

DO $$
DECLARE missing_constraints text[];
BEGIN
  SELECT array_agg(expected.name ORDER BY expected.name) INTO missing_constraints
    FROM (VALUES
      ('fk_membership_inviter'), ('fk_role_revoker_membership'),
      ('ck_organization_has_owner'), ('ck_identity_change_preserves_owner'),
      ('ck_organization_has_owner_membership'), ('ck_organization_has_owner_role'),
      ('fk_audit_membership'), ('fk_outbox_human_membership'), ('uq_outbox_stream_position')
    ) AS expected(name)
   WHERE NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname=expected.name);
  IF missing_constraints IS NOT NULL THEN
    RAISE EXCEPTION 'reviewed M1 constraint inventory is incomplete: %', missing_constraints;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles
     WHERE rolname IN ('aios_runtime','aios_worker','aios_readonly','aios_backup')
       AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'an application or operations role has privileged role attributes';
  END IF;
END $$;

DO $$ BEGIN
  BEGIN
    UPDATE human_identities SET status='Disabled', disabled_at=now()
      WHERE identity_id='00000000-0000-0000-0000-000000000001';
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'last Human owner identity disablement was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
END $$;

DO $$ BEGIN
  IF has_table_privilege('aios_runtime','authorization_audit_records','UPDATE')
     OR has_table_privilege('aios_runtime','authorization_audit_records','DELETE')
     OR has_table_privilege('aios_runtime','authorization_audit_records','TRUNCATE') THEN
    RAISE EXCEPTION 'runtime role can mutate append-only authorization audit data';
  END IF;
  IF has_schema_privilege('aios_runtime','public','CREATE') THEN
    RAISE EXCEPTION 'runtime role can mutate schema';
  END IF;
  IF has_table_privilege('aios_backup','memberships','INSERT')
     OR NOT has_table_privilege('aios_backup','memberships','SELECT') THEN
    RAISE EXCEPTION 'backup role grants are not read-only';
  END IF;
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

ROLLBACK;

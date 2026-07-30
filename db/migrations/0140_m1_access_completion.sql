BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL application_name = 'aios-migration-0140';

ALTER TABLE membership_role_assignments
  ADD COLUMN revoked_by_identity_id uuid REFERENCES human_identities(identity_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD COLUMN revoked_by_membership_id uuid,
  ADD CONSTRAINT fk_role_revoker_membership
    FOREIGN KEY (organization_id, revoked_by_membership_id)
    REFERENCES memberships(organization_id, membership_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT ck_role_revocation_attribution CHECK (
    (revoked_at IS NULL AND revoked_by_identity_id IS NULL AND revoked_by_membership_id IS NULL AND revocation_reason IS NULL)
    OR
    (revoked_at IS NOT NULL AND revoked_by_identity_id IS NOT NULL AND revoked_by_membership_id IS NOT NULL AND length(btrim(revocation_reason)) > 0)
  );

CREATE OR REPLACE FUNCTION enforce_organization_has_active_human_owner(scoped_org uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM 1 FROM public.organizations WHERE organization_id=scoped_org AND status='Active' FOR UPDATE;
  IF FOUND AND NOT EXISTS (
    SELECT 1
      FROM public.membership_role_assignments r
      JOIN public.memberships m USING (organization_id,membership_id)
      JOIN public.human_identities h ON h.identity_id=m.identity_id
     WHERE r.organization_id=scoped_org
       AND r.role='OrganizationOwner'
       AND r.revoked_at IS NULL
       AND m.status='Active'
       AND h.status='Active'
  ) THEN
    RAISE EXCEPTION 'active organization requires an active Human owner' USING ERRCODE='23514';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION enforce_active_organization_owner()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM public.enforce_organization_has_active_human_owner(COALESCE(NEW.organization_id,OLD.organization_id));
  RETURN NULL;
END $$;

CREATE FUNCTION enforce_owner_after_organization_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM public.enforce_organization_has_active_human_owner(COALESCE(NEW.organization_id,OLD.organization_id));
  RETURN NULL;
END $$;

CREATE FUNCTION enforce_owner_after_identity_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE scoped_org uuid;
BEGIN
  FOR scoped_org IN
    SELECT DISTINCT organization_id FROM public.memberships WHERE identity_id=COALESCE(NEW.identity_id,OLD.identity_id)
  LOOP
    PERFORM public.enforce_organization_has_active_human_owner(scoped_org);
  END LOOP;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER ck_organization_has_owner
AFTER INSERT OR UPDATE OR DELETE ON organizations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_owner_after_organization_change();

CREATE CONSTRAINT TRIGGER ck_identity_change_preserves_owner
AFTER UPDATE OR DELETE ON human_identities
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_owner_after_identity_change();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='aios_migration') THEN
    CREATE ROLE aios_migration NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='aios_backup') THEN
    CREATE ROLE aios_backup NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO aios_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO aios_backup;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO aios_backup;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM aios_backup;
REVOKE CREATE ON SCHEMA public FROM aios_backup;

COMMENT ON ROLE aios_migration IS 'Granted to the deployment identity only while applying reviewed migrations.';
COMMENT ON ROLE aios_backup IS 'Read-only logical backup role; restore uses a separately controlled recovery identity.';
COMMIT;

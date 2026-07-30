BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL application_name = 'aios-migration-0020';

CREATE TABLE human_identities (
  identity_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL CHECK (status IN ('Active','Disabled')),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
  primary_email text,
  primary_email_normalized text,
  locale text,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  disabled_at timestamptz,
  CONSTRAINT ck_human_identity_disabled CHECK ((status='Active' AND disabled_at IS NULL) OR (status='Disabled' AND disabled_at IS NOT NULL))
);

ALTER TABLE organizations ADD CONSTRAINT fk_organizations_creator FOREIGN KEY (created_by_identity_id) REFERENCES human_identities(identity_id) ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE authentication_subjects (
  authentication_subject_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id uuid NOT NULL REFERENCES human_identities(identity_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  provider text NOT NULL,
  issuer text NOT NULL,
  subject text NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  unlinked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE UNIQUE INDEX uq_authentication_subjects_active ON authentication_subjects(provider,issuer,subject) WHERE unlinked_at IS NULL;

CREATE TABLE memberships (
  membership_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(organization_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  identity_id uuid REFERENCES human_identities(identity_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  pending_invitee_email text,
  pending_invitee_email_normalized text,
  status text NOT NULL CHECK (status IN ('Invited','Active','Suspended','Revoked')),
  invited_by_identity_id uuid REFERENCES human_identities(identity_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  invited_by_membership_id uuid,
  invited_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  activated_at timestamptz,
  suspended_at timestamptz,
  suspension_reason text,
  revoked_at timestamptz,
  revocation_reason text,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT uq_memberships_organization_membership UNIQUE (organization_id,membership_id),
  CONSTRAINT ck_memberships_identity_state CHECK ((status='Invited' AND (identity_id IS NOT NULL OR pending_invitee_email_normalized IS NOT NULL)) OR (status IN ('Active','Suspended','Revoked') AND identity_id IS NOT NULL)),
  CONSTRAINT ck_memberships_lifecycle CHECK ((status='Active' AND activated_at IS NOT NULL AND suspended_at IS NULL AND revoked_at IS NULL) OR status='Invited' OR (status='Suspended' AND suspended_at IS NOT NULL AND revoked_at IS NULL) OR (status='Revoked' AND revoked_at IS NOT NULL))
);

ALTER TABLE memberships ADD CONSTRAINT fk_membership_inviter FOREIGN KEY (organization_id,invited_by_membership_id) REFERENCES memberships(organization_id,membership_id) ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE UNIQUE INDEX uq_memberships_pending_invitation ON memberships(organization_id,pending_invitee_email_normalized) WHERE status='Invited' AND identity_id IS NULL;
CREATE UNIQUE INDEX uq_memberships_organization_identity ON memberships(organization_id,identity_id) WHERE identity_id IS NOT NULL;

CREATE TABLE membership_role_assignments (
  role_assignment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('OrganizationOwner','OrganizationAdmin','Member','Reviewer')),
  assigned_by_identity_id uuid NOT NULL REFERENCES human_identities(identity_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  assigned_by_membership_id uuid NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  revoked_at timestamptz,
  revocation_reason text,
  FOREIGN KEY (organization_id,membership_id) REFERENCES memberships(organization_id,membership_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,assigned_by_membership_id) REFERENCES memberships(organization_id,membership_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT uq_active_membership_role UNIQUE NULLS NOT DISTINCT (organization_id,membership_id,role,revoked_at)
);

CREATE FUNCTION enforce_active_organization_owner() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE scoped_org uuid := COALESCE(NEW.organization_id,OLD.organization_id);
BEGIN
  PERFORM 1 FROM public.organizations WHERE organization_id=scoped_org AND status='Active' FOR UPDATE;
  IF FOUND AND NOT EXISTS (
    SELECT 1 FROM public.membership_role_assignments r JOIN public.memberships m USING (organization_id,membership_id)
    JOIN public.human_identities h ON h.identity_id=m.identity_id
    WHERE r.organization_id=scoped_org AND r.role='OrganizationOwner' AND r.revoked_at IS NULL AND m.status='Active' AND h.status='Active'
  ) THEN RAISE EXCEPTION 'active organization requires an active Human owner' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER ck_organization_has_owner_role AFTER INSERT OR UPDATE OR DELETE ON membership_role_assignments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_active_organization_owner();
CREATE CONSTRAINT TRIGGER ck_organization_has_owner_membership AFTER UPDATE OR DELETE ON memberships DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_active_organization_owner();
COMMIT;

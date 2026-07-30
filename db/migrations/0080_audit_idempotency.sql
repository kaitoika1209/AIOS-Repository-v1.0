BEGIN;
CREATE TABLE authorization_audit_records (
  authorization_audit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid NOT NULL, command_id uuid, correlation_id uuid NOT NULL,
  principal_id uuid NOT NULL, principal_type text NOT NULL CHECK(principal_type IN ('HumanMember','Secretary','System')),
  identity_id uuid, membership_id uuid, organization_id uuid REFERENCES organizations(organization_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  command_type text NOT NULL, permission text NOT NULL, resource_type text, resource_id uuid,
  policy_id text NOT NULL, policy_version integer NOT NULL CHECK(policy_version>0), outcome text NOT NULL CHECK(outcome IN ('Allow','Deny')), reason_code text NOT NULL,
  evaluated_at timestamptz NOT NULL, resulting_event_id uuid, created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT fk_audit_membership FOREIGN KEY(organization_id,membership_id) REFERENCES memberships(organization_id,membership_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE TABLE processed_commands (
  command_id uuid PRIMARY KEY, command_type text NOT NULL, organization_id uuid NOT NULL REFERENCES organizations(organization_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  principal_id uuid NOT NULL, aggregate_type text, aggregate_id uuid, request_hash text NOT NULL,
  status text NOT NULL CHECK(status IN ('Processing','Completed','Failed')), result_payload jsonb, correlation_id uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT transaction_timestamp(), expires_at timestamptz NOT NULL,
  CONSTRAINT ck_processed_command_expiry CHECK(expires_at>processed_at)
);
COMMIT;

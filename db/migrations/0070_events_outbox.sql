BEGIN;
CREATE TABLE outbox_messages (
  outbox_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid NOT NULL UNIQUE,
  event_type text NOT NULL, event_category text NOT NULL, schema_version integer NOT NULL CHECK(schema_version>0),
  aggregate_type text NOT NULL, aggregate_id uuid NOT NULL, aggregate_version bigint NOT NULL CHECK(aggregate_version>0), event_sequence integer NOT NULL CHECK(event_sequence>0),
  organization_id uuid NOT NULL REFERENCES organizations(organization_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  payload jsonb NOT NULL, headers jsonb NOT NULL DEFAULT '{}'::jsonb, destination text NOT NULL,
  occurred_at timestamptz NOT NULL, recorded_at timestamptz NOT NULL DEFAULT transaction_timestamp(), correlation_id uuid NOT NULL, causation_id uuid,
  actor_type text NOT NULL CHECK(actor_type IN ('HumanMember','Secretary','System')), actor_id uuid NOT NULL, actor_membership_id uuid,
  status text NOT NULL DEFAULT 'Pending' CHECK(status IN ('Pending','Claimed','Published','Failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count>=0), claim_version bigint NOT NULL DEFAULT 0 CHECK(claim_version>=0), next_attempt_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  locked_by text, locked_until timestamptz, published_at timestamptz, failed_at timestamptz, last_error_code text, last_error_message text, updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT uq_outbox_stream_position UNIQUE(organization_id,aggregate_type,aggregate_id,aggregate_version,event_sequence),
  CONSTRAINT ck_outbox_human_membership CHECK ((actor_type='HumanMember' AND actor_membership_id IS NOT NULL) OR (actor_type<>'HumanMember' AND actor_membership_id IS NULL)),
  CONSTRAINT fk_outbox_human_membership FOREIGN KEY(organization_id,actor_membership_id) REFERENCES memberships(organization_id,membership_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
COMMIT;

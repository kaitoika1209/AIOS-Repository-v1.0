BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL application_name = 'aios-migration-0120';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aios_runtime') THEN
    CREATE ROLE aios_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aios_worker') THEN
    CREATE ROLE aios_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aios_readonly') THEN
    CREATE ROLE aios_readonly NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO aios_runtime, aios_worker, aios_readonly;

GRANT SELECT, INSERT, UPDATE ON
  organizations,
  human_identities,
  authentication_subjects,
  memberships,
  membership_role_assignments,
  processed_commands
TO aios_runtime;
GRANT SELECT, INSERT ON authorization_audit_records, outbox_messages TO aios_runtime;

GRANT SELECT, INSERT, UPDATE ON outbox_messages, processed_commands TO aios_worker;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO aios_readonly;

REVOKE UPDATE, DELETE, TRUNCATE ON authorization_audit_records FROM aios_runtime, aios_worker;
REVOKE DELETE, TRUNCATE ON outbox_messages FROM aios_runtime, aios_worker;
REVOKE CREATE ON SCHEMA public FROM aios_runtime, aios_worker, aios_readonly;
COMMIT;

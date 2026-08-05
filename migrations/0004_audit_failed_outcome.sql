-- Separate a system failure from a refusal in the authorization audit.
--
-- `outcome` was `Allow` or `Deny`, and the interceptor recorded every thrown
-- error as `Deny` — including a `500`. That is a real defect rather than a
-- cosmetic one: runbook 4 reads `outcome = 'Deny'` to find Organization
-- isolation and Human authority violations and to spot probing, so an internal
-- error counted as a refusal is a false finding in the one place false findings
-- are most expensive.
--
-- Widening a CHECK constraint, so it is safe on a live database with rows: every
-- existing row satisfies the new predicate. Historical rows written before this
-- may still record a failure as `Deny`, which no migration can distinguish after
-- the fact — the reason code is the only clue, and a SQLSTATE like `42703` where
-- a `PERMISSION_DENIED` belongs is what it looks like.
--
-- The documented DDL is in `docs/architecture/persistence-and-data-model.md`
-- under "Authorization Audit Outcome".

ALTER TABLE authorization_audit_records
DROP CONSTRAINT ck_authorization_audit_outcome;

ALTER TABLE authorization_audit_records
ADD CONSTRAINT ck_authorization_audit_outcome
CHECK (
    outcome IN (
        'Allow',
        'Deny',
        'Failed'
    )
);

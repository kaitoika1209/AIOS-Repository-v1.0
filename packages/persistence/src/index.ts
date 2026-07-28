/**
 * `@aios/persistence` — PostgreSQL adapters.
 *
 * Implements the ports declared in `@aios/application` with hand-written SQL
 * against the schema documented in
 * `docs/architecture/persistence-and-data-model.md` (ADR-0015).
 *
 * Nothing here is imported by `@aios/domain`. Dependencies point inward.
 */

export * from "./mapping.js";
export * from "./work-repository.js";
export * from "./outbox.js";
export * from "./unit-of-work.js";

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
export * from "./decision-mapping.js";
export * from "./decision-repository.js";
export * from "./event-recovery-repository.js";
export * from "./generation-operation-repository.js";
export * from "./membership-repository.js";
export * from "./memory-mapping.js";
export * from "./memory-repository.js";
export * from "./work-repository.js";
export * from "./outbox.js";
export * from "./unit-of-work.js";

export * from "./consumer-delivery-repository.js";
export * from "./replay-repository.js";
export * from "./organization-repository.js";
export * from "./notification-repository.js";
export * from "./assistance-repository.js";

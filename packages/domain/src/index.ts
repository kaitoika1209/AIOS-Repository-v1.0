/**
 * `@aios/domain` — business rules.
 *
 * The domain layer must not depend on frameworks (ADR-0001,
 * coding-standards.md). This package imports only `@aios/types`.
 *
 * Aggregates expose behaviour, never public state mutation: `completeWork(...)`
 * rather than `work.status = "Completed"`.
 */

export * from "./errors.js";
export * from "./events.js";
export * from "./completion-gate.js";
export * from "./work.js";
export * from "./decision.js";
export * from "./memory.js";
export * from "./membership.js";
export * from "./organization.js";

/**
 * `@aios/application` — use cases and ports.
 *
 * Coordinates domain objects, owns transactions, and evaluates permissions. It
 * contains no business rules: those live in `@aios/domain`
 * (`docs/engineering/coding-standards.md`).
 */

export * from "./authorization.js";
export * from "./ports.js";
export * from "./work-use-cases.js";
export * from "./decision-use-cases.js";
export * from "./memory-use-cases.js";

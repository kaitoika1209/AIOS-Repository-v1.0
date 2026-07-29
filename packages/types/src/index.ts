/**
 * `@aios/types` — shared domain vocabulary.
 *
 * This package contains types and catalogues only: no behaviour, no
 * dependencies, no framework imports. Business rules belong in `@aios/domain`
 * (`docs/engineering/coding-standards.md`).
 *
 * Every catalogue here is a projection of an authoritative document. When they
 * disagree, the document wins — see `docs/document-governance.md`.
 */

export * from "./ids.js";
export * from "./statuses.js";
export * from "./consumers.js";
export * from "./authorization.js";
export * from "./principal.js";

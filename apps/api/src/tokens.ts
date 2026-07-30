/**
 * Injection tokens.
 *
 * Controllers receive `UseCaseDependencies` through this token, so they depend
 * on the application layer rather than on any concrete adapter.
 */

export const USE_CASE_DEPENDENCIES = Symbol.for("aios.useCaseDependencies");

/** The Secretary Runtime adapter for Decision assistance (ADR-0011). */
export const DECISION_ASSISTANCE = Symbol("DECISION_ASSISTANCE");

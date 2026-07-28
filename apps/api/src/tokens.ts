/**
 * Injection tokens.
 *
 * Controllers receive `UseCaseDependencies` through this token, so they depend
 * on the application layer rather than on any concrete adapter.
 */

export const USE_CASE_DEPENDENCIES = Symbol.for("aios.useCaseDependencies");

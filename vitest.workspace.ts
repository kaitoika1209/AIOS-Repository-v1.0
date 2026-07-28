/**
 * Vitest workspace.
 *
 * Each package owns its own `vitest.config.ts` so that `turbo run test` (which
 * executes inside the package directory) and a root-level `vitest run` both
 * resolve the same test files.
 */
export default ["packages/*", "apps/*"];

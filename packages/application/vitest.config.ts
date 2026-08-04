import { defineConfig } from "vitest/config";

export default defineConfig({
  // Workspace packages expose both: `development` is the TypeScript source and
  // `default` is the built output that plain `node` loads in a container.
  // Tests read the source, so a stale `dist` can never make a suite pass.
  resolve: { conditions: ["development"] },
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});

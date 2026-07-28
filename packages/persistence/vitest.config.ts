import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 20000,
    // Each file rebuilds the schema from the documents, so two files running
    // concurrently race on DROP SCHEMA. These are integration tests sharing one
    // database; running the files sequentially is the correct trade.
    fileParallelism: false,
  },
});

/**
 * API entry point.
 *
 * Clerk authenticates when it is configured; the development adapter runs only
 * in development and test, and `chooseAuth` refuses to start otherwise. Clerk
 * replaces `DevAuthAdapter` and nothing else (ADR-0013).
 */

import "reflect-metadata";

import { buildDevApp } from "./app.js";

const main = async (): Promise<void> => {
  const connectionString = process.env["DATABASE_URL"];
  if (connectionString === undefined) {
    throw new Error("DATABASE_URL is required.");
  }

  // The adapter choice, and its refusal to run unverified outside development,
  // live in `chooseAuth` so the same rule applies to every entry point rather
  // than only to this one.
  const app = await buildDevApp(connectionString);
  const port = Number.parseInt(process.env["PORT"] ?? "3001", 10);

  await app.listen(port);
  console.log(`AIOS API listening on :${port}`);
};

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

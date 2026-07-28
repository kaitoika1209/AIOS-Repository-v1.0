/**
 * API entry point.
 *
 * Refuses to start outside development with the development auth adapter, which
 * performs no verification. Clerk replaces `DevAuthAdapter` and nothing else
 * (ADR-0013).
 */

import "reflect-metadata";

import { buildDevApp } from "./app.js";

const main = async (): Promise<void> => {
  const connectionString = process.env["DATABASE_URL"];
  if (connectionString === undefined) {
    throw new Error("DATABASE_URL is required.");
  }

  const environment = process.env["NODE_ENV"] ?? "development";
  if (environment !== "development" && environment !== "test") {
    throw new Error(
      "The development auth adapter performs no verification and must not run " +
        `outside development (NODE_ENV=${environment}). Wire Clerk first.`,
    );
  }

  const app = await buildDevApp(connectionString);
  const port = Number.parseInt(process.env["PORT"] ?? "3001", 10);

  await app.listen(port);
  console.log(`AIOS API listening on :${port} (auth: development stub)`);
};

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

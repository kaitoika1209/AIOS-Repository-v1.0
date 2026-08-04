/**
 * Unhandled failure capture (baseline item 4).
 *
 * "Error capture for unhandled application and Worker failures." Without it, a
 * process that dies to an uncaught exception leaves nothing but whatever Node
 * prints to stderr — unstructured, uncorrelated, and in a container often the
 * last thing before the log stream ends. The first question after a restart is
 * "why", and the answer has to be a record someone can query.
 *
 * Both handlers log and then exit. That is deliberate: after an uncaught
 * exception the process is in an undefined state, and continuing is how one
 * corrupt request becomes several. Exiting hands the decision to the supervisor,
 * which is the thing equipped to make it — and liveness has already reported the
 * process as unhealthy by then.
 */

import { describeError, getLogger, type LogInput } from "@aios/application";

/** Give the log a moment to reach stdout before the process disappears. */
const FLUSH_MS = 100;

const fatal = (name: string, message: string) => (error: unknown): void => {
  const input: LogInput = {
    severity: "ERROR",
    operationalLogName: name,
    operationalLogClass: "Operations",
    operationalLogCategory: "Operations",
    message,
    outcome: "Failure",
    attributes: describeError(error),
  };

  try {
    getLogger().log(input);
  } catch {
    // The logger itself failed. Anything is better than silence here, and this
    // is the one place a bare write to stderr is the right answer.
    process.stderr.write(`${name}: ${String(error)}\n`);
  }

  setTimeout(() => process.exit(1), FLUSH_MS).unref();
};

export const captureUnhandledFailures = (): void => {
  process.on("uncaughtException", fatal("process.uncaught_exception", "Uncaught exception."));
  process.on(
    "unhandledRejection",
    fatal("process.unhandled_rejection", "A promise rejected with no handler."),
  );
};

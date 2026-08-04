/**
 * The JSON log sink.
 *
 * One line of JSON per record on stdout, which is what ADR-0003 selected:
 * "Structured JSON written to stdout and ingested into Amazon CloudWatch Logs by
 * the selected AWS compute runtime." Nothing here knows about CloudWatch, and it
 * should not — that is the Infrastructure Layer detail the same document keeps
 * out of application code.
 *
 * The envelope and its redaction live in `@aios/application`. This file is only
 * the sink: where the bytes go, and which severities are worth the bytes.
 */

import {
  buildEnvelope,
  nullLogger,
  type EnvelopeContext,
  type LogInput,
  type Logger,
  type Severity,
} from "@aios/application";

const ORDER: Record<Severity, number> = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

const thresholdFrom = (value: string | undefined): Severity => {
  const upper = (value ?? "INFO").toUpperCase();
  return upper in ORDER ? (upper as Severity) : "INFO";
};

export class JsonLogger implements Logger {
  private readonly threshold: number;

  constructor(
    private readonly context: EnvelopeContext,
    minimumSeverity: Severity = "INFO",
  ) {
    this.threshold = ORDER[minimumSeverity];
  }

  log(input: LogInput): void {
    if (ORDER[input.severity] < this.threshold) return;

    const record = buildEnvelope(this.context, input);

    // `process.stdout.write` rather than `console.log`: one call, one line, no
    // interpolation. A record that arrived split across two writes would be two
    // unparseable half-records in the sink.
    //
    // Wrapped because a log that throws must not become the failure it was
    // reporting on. If even the fallback fails there is nowhere left to say so.
    try {
      process.stdout.write(`${JSON.stringify(record)}\n`);
    } catch {
      try {
        process.stderr.write(
          `{"logSchemaVersion":${record.logSchemaVersion},"severity":"ERROR",` +
            `"operationalLogName":"logging.emit_failed","message":"A log record could not be serialized."}\n`,
        );
      } catch {
        // Nothing further is available, and throwing here would take the
        // request down over a log line.
      }
    }
  }
}

/**
 * The logger for an environment.
 *
 * Shaped like `chooseAuth` and `chooseWorkerMode`: the decision is a function of
 * the environment, made once, with the reason available rather than inferred.
 */
export const chooseLogger = (
  env: NodeJS.ProcessEnv,
  serviceName: string,
): { logger: Logger; reason: string } => {
  const environment = env["NODE_ENV"] ?? "development";

  // A test run that emitted a log line per request would bury its own output.
  if (environment === "test" && env["LOG_LEVEL"] === undefined) {
    return { logger: nullLogger, reason: "disabled (test)" };
  }

  const severity = thresholdFrom(env["LOG_LEVEL"]);
  return {
    logger: new JsonLogger(
      {
        serviceName,
        // From the package version at build time in a real deployment; the
        // envelope requires the field, and a wrong value is worse than a frank
        // one, so it says what it knows.
        serviceVersion: env["SERVICE_VERSION"] ?? "0.1.0",
        environment,
        now: () => new Date(),
      },
      severity,
    ),
    reason: `JSON to stdout at ${severity}`,
  };
};

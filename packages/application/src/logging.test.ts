/**
 * The log envelope, its redaction, and where correlation comes from.
 *
 * Redaction is the part worth testing hardest. A missed secret in a log is not
 * a bug that shows up in a failing test later — it is in every replica and
 * backup of that log, permanently, and nobody finds out until someone reads one.
 */

import { describe, expect, it } from "vitest";

import {
  LOG_SCHEMA_VERSION,
  REDACTED,
  buildEnvelope,
  describeError,
  newCorrelation,
  redact,
  runWithCorrelation,
} from "./index.js";

const context = {
  serviceName: "aios-api",
  serviceVersion: "0.1.0",
  environment: "test",
  now: () => new Date("2026-08-04T12:00:00.000Z"),
};

const base = {
  severity: "INFO",
  operationalLogName: "work.created",
  operationalLogClass: "DomainTransition",
  operationalLogCategory: "Application",
  message: "Work created.",
} as const;

describe("the operational log envelope", () => {
  it("populates every required base field", () => {
    // The document lists these as MUST-populate. A record missing one is a
    // record a query cannot filter and a retention policy cannot classify.
    const record = buildEnvelope(context, base);

    for (const key of [
      "logSchemaVersion",
      "timestamp",
      "severity",
      "operationalLogName",
      "operationalLogClass",
      "operationalLogCategory",
      "serviceName",
      "serviceVersion",
      "environment",
      "attributes",
    ] as const) {
      expect(record[key], key).toBeDefined();
    }
    expect(record.logSchemaVersion).toBe(LOG_SCHEMA_VERSION);
  });

  it("reports outcome and duration as null rather than omitting them", () => {
    // "may be null only when the registered operational-log class does not have
    // a terminal outcome or measurable duration" — null is the representation,
    // and a missing key would be a different shape for a consumer to handle.
    const record = buildEnvelope(context, base);
    expect(record.outcome).toBeNull();
    expect(record.durationMs).toBeNull();
  });
});

describe("redaction", () => {
  it("removes every category the architecture names", () => {
    const safe = redact({
      "http.authorization": "Bearer abc.def.ghi",
      "http.cookie": "session=xyz",
      "identity.password": "hunter2",
      "database.credential": "postgres://user:pw@host/db",
      "invitation.token": "inv_secret",
      "ai.api_key": "sk-ant-123",
      "ai.prompt": "You write the organization's record...",
      "ai.completion": "The cutover completed...",
      "domain.work_id": "6705a9ed-2306-42b3-af63-35cabd03a431",
    });

    for (const key of Object.keys(safe)) {
      if (key === "domain.work_id") continue;
      expect(safe[key], key).toBe(REDACTED);
    }
    // And it does not redact everything, which would be a different failure:
    // logs that carry no information are as useless as logs nobody may read.
    expect(safe["domain.work_id"]).toBe("6705a9ed-2306-42b3-af63-35cabd03a431");
  });

  it("catches a secret whatever the key is spelled like", () => {
    // Matched as a substring on the key, so nobody has to maintain a list of
    // spellings — the list is what goes stale, and a stale list fails open.
    const safe = redact({
      apiKey: "sk-1",
      "provider_api_key": "sk-2",
      "x-api-key": "sk-3",
      CLERK_SECRET_KEY: "sk-4",
      accessToken: "sk-5",
    });
    expect(Object.values(safe).every((v) => v === REDACTED)).toBe(true);
  });

  it("strips control characters, so a value cannot forge a log line", () => {
    // Log injection: in a line-delimited sink, a newline in any attacker-
    // influenced field — an Organization name, an email, an error message —
    // is a second, fabricated record.
    const record = buildEnvelope(context, {
      ...base,
      message: "Work created.\n{\"severity\":\"ERROR\",\"message\":\"forged\"}",
      attributes: { "domain.title": "line one\r\nline two" },
    });

    expect(record.message).not.toContain("\n");
    expect(String(record.attributes["domain.title"])).not.toContain("\n");
  });
});

describe("correlation on a record", () => {
  it("attaches the ambient request correlation", () => {
    const correlation = newCorrelation();
    const record = runWithCorrelation(correlation, () => buildEnvelope(context, base));

    expect(record.attributes["identity.correlation_id"]).toBe(correlation.correlationId);
    expect(record.attributes["identity.request_id"]).toBe(correlation.requestId);
  });

  it("omits it outside a request rather than inventing one", () => {
    // A Worker drain or a script has no inbound request. Minting one here would
    // look like correlation while correlating nothing.
    const record = buildEnvelope(context, base);
    expect(record.attributes["identity.correlation_id"]).toBeUndefined();
  });

  it("keeps a caller's value under a name that cannot be mistaken for the real one", () => {
    const correlation = newCorrelation("client-abc-123");
    const record = runWithCorrelation(correlation, () => buildEnvelope(context, base));

    expect(record.attributes["identity.external_correlation_id"]).toBe("client-abc-123");
    // And the server's own identifier is not the caller's: "A value supplied by
    // an external caller MUST NOT be accepted, promoted, or copied into the
    // internal `correlationId` field."
    expect(record.attributes["identity.correlation_id"]).not.toBe("client-abc-123");
  });

  it("cannot be overwritten by an attribute of the same name", () => {
    // Correlation is the server's. A caller-influenced attribute that landed on
    // the same key would make one workflow look like another.
    const correlation = newCorrelation();
    const record = runWithCorrelation(correlation, () =>
      buildEnvelope(context, {
        ...base,
        attributes: { "identity.correlation_id": "attacker-chosen" },
      }),
    );

    expect(record.attributes["identity.correlation_id"]).toBe(correlation.correlationId);
  });
});

describe("describing a thrown error", () => {
  it("keeps what says the failure, and drops what says the data", () => {
    // The concrete leak this exists to close. PostgreSQL puts the conflicting
    // value in `detail`:
    //
    //   Key (email)=(alice.private@example.test) already exists.
    //
    // Duplicate invitations and duplicate Memberships are ordinary traffic, so
    // `console.error("…", error)` wrote real addresses into the logs as routine
    // behaviour. Reproduced against a live database before this was written.
    const pgError = Object.assign(
      new Error('duplicate key value violates unique constraint "uq_memberships_email"'),
      {
        code: "23505",
        detail: "Key (primary_email_normalized)=(alice.private@example.test) already exists.",
        table: "memberships",
        column: "primary_email_normalized",
        where: "SQL statement \"INSERT INTO memberships ...\"",
        internalQuery: "INSERT INTO memberships VALUES ('alice.private@example.test')",
      },
    );

    const described = describeError(pgError);
    const serialized = JSON.stringify(described);

    // Nothing carrying the value survives.
    expect(serialized).not.toContain("alice.private@example.test");
    expect(described["error.detail"]).toBeUndefined();
    expect(described["error.internalQuery"]).toBeUndefined();
    expect(described["error.where"]).toBeUndefined();
    expect(described["error.table"]).toBeUndefined();

    // And enough is left to diagnose it.
    expect(described["error.code"]).toBe("23505");
    expect(described["error.type"]).toBe("Error");
    expect(String(described["error.message"])).toContain("duplicate key value");
  });

  it("excludes an unknown field by default rather than including it", () => {
    // The direction that matters: a field the driver adds tomorrow is dropped
    // without anyone updating a denylist. An allowlist fails closed.
    const described = describeError(
      Object.assign(new Error("boom"), { somethingAddedLater: "a user's data" }),
    );
    expect(JSON.stringify(described)).not.toContain("a user's data");
  });

  it("bounds the message, so one error cannot flood a sink", () => {
    const described = describeError(new Error("x".repeat(5000)));
    expect(String(described["error.message"]).length).toBeLessThanOrEqual(500);
  });

  it("handles a thrown non-Error without losing the record", () => {
    // `throw "string"` is legal and happens. A serializer that assumed `Error`
    // would throw inside the failure path and lose the report entirely.
    expect(describeError("just a string")["error.type"]).toBe("NonError");
    expect(describeError(undefined)["error.type"]).toBe("NonError");
  });
});

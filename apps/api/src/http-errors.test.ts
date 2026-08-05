/**
 * The HTTP mapping for a dependency outage.
 *
 * Written after executing runbook 1, which is what found it wrong: stopping
 * PostgreSQL under a running API turned every authoritative command into
 * `500 INTERNAL_ERROR`. The runbook asks an operator to "reject authoritative
 * commands safely", and a `500` is not safe rejection — a client will not retry
 * it, an SLI counts it against the service's own correctness rather than its
 * dependency's availability, and an operator sees `http.unhandled_error` where
 * a database outage should have been named in one glance.
 */

import { describe, expect, it } from "vitest";

import { AuthorizationError } from "@aios/application";
import { ValidationError } from "@aios/domain";

import { bodyFor, statusFor } from "./http-errors.js";

/** A driver error, as `pg` produces it. */
const driverError = (code: string, message = "connect failed"): Error => {
  const error = new Error(message);
  (error as Error & { code: string }).code = code;
  return error;
};

describe("a dependency that is unavailable", () => {
  it("is 503 for a refused socket, not 500", () => {
    expect(statusFor(driverError("ECONNREFUSED"))).toBe(503);
  });

  it("is 503 for the PostgreSQL connection-exception class", () => {
    // Class 08 in full: 08000, 08003, 08006, 08001, 08004, 08007, 08P01.
    // Matched by prefix, so a member added by a future release needs no change.
    for (const code of ["08000", "08003", "08006", "08P01"]) {
      expect(statusFor(driverError(code))).toBe(503);
    }
  });

  it("is 503 while the server is shutting down or refusing connections", () => {
    for (const code of ["57P01", "57P02", "57P03"]) {
      expect(statusFor(driverError(code))).toBe(503);
    }
  });

  it("is 503 when the pool is exhausted", () => {
    expect(statusFor(driverError("53300", "too many connections"))).toBe(503);
  });

  it("is 503 for a write against a read-only transaction, which is what a replica answers", () => {
    expect(statusFor(driverError("25006", "cannot execute INSERT"))).toBe(503);
  });

  it("names nothing internal in the body", () => {
    const body = bodyFor(
      driverError("ECONNREFUSED", "connect ECONNREFUSED 10.0.0.4:5432 for user aios"),
    );

    expect(body.code).toBe("SERVICE_UNAVAILABLE");
    // The code is the whole contract. A driver's message routinely quotes the
    // connection string, and this is the one path every unmapped failure takes.
    expect(JSON.stringify(body)).not.toContain("10.0.0.4");
    expect(JSON.stringify(body)).not.toContain("aios");
  });
});

describe("what is still 500", () => {
  it("an ordinary programming error", () => {
    // The distinction has to hold in both directions, or `503` would become the
    // new way to hide defects.
    expect(statusFor(new TypeError("x is not a function"))).toBe(500);
    expect(bodyFor(new TypeError("boom")).code).toBe("INTERNAL_ERROR");
  });

  it("a PostgreSQL error that is the query's fault, not the connection's", () => {
    // 42703 is undefined_column — a defect in the SQL, which no retry fixes.
    expect(statusFor(driverError("42703", 'column "x" does not exist'))).toBe(500);
  });
});

describe("the refusals are unchanged", () => {
  it("keeps authorization at 403 and says nothing about why", () => {
    expect(statusFor(new AuthorizationError("work.start"))).toBe(403);
    const body = bodyFor(new AuthorizationError("work.start"));
    expect(body.code).toBe("PERMISSION_DENIED");
    expect(JSON.stringify(body)).not.toContain("work.start");
  });

  it("keeps a validation failure at 422", () => {
    expect(statusFor(new ValidationError("bad"))).toBe(422);
  });
});

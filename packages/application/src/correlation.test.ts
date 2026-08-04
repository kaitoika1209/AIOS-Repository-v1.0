/**
 * The correlation trust boundary.
 *
 * The rules here are all "MUST NOT" rules, which makes them the kind that hold
 * until someone reasonable does the obvious convenient thing. The obvious
 * convenient thing is to trust a caller's correlation header, and it is exactly
 * what the architecture forbids.
 */

import { describe, expect, it } from "vitest";

import {
  acceptExternalCorrelation,
  correlationIdForRecord,
  currentCorrelation,
  newCorrelation,
  runWithCorrelation,
} from "./correlation.js";

describe("what a caller may supply", () => {
  it("keeps a well-formed value as untrusted metadata", () => {
    expect(acceptExternalCorrelation("client-abc_123:456.7")).toBe("client-abc_123:456.7");
  });

  it("discards a value long enough to flood a log sink", () => {
    expect(acceptExternalCorrelation("x".repeat(129))).toBeNull();
  });

  it("discards a value that could forge a log line", () => {
    // Rejected whole rather than sanitized: this reaches a line-delimited sink,
    // and a value that has to be cleaned before it is safe is one that will
    // reach somewhere it is not cleaned.
    expect(acceptExternalCorrelation("abc\ndef")).toBeNull();
    expect(acceptExternalCorrelation("abc def")).toBeNull();
    expect(acceptExternalCorrelation('"; DROP')).toBeNull();
  });

  it("never becomes the server's own identifier", () => {
    // The rule the whole separation exists for.
    const context = newCorrelation("client-supplied");
    expect(context.correlationId).not.toBe("client-supplied");
    expect(context.requestId).not.toBe("client-supplied");
    expect(context.externalCorrelationId).toBe("client-supplied");
  });
});

describe("what a durable row records", () => {
  it("shares one identifier across everything in a request", () => {
    // The defect this work exists to fix: the edge audit, the use-case audit,
    // and the Outbox each minted their own, so one request produced three
    // unrelated identifiers and no workflow could be followed across them.
    const context = newCorrelation();
    const seen = runWithCorrelation(context, () => [
      correlationIdForRecord(),
      correlationIdForRecord(),
      correlationIdForRecord(),
    ]);

    expect(new Set(seen).size).toBe(1);
    expect(seen[0]).toBe(context.correlationId);
  });

  it("survives an await, which is the only reason this mechanism was chosen", async () => {
    const context = newCorrelation();
    const observed = await runWithCorrelation(context, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return correlationIdForRecord();
    });
    expect(observed).toBe(context.correlationId);
  });

  it("gives unrelated work unrelated identifiers", () => {
    // A Worker drain or a script legitimately starts outside a request. It gets
    // its own identifier rather than null or a shared constant — either would
    // make two unrelated workflows look like one.
    expect(correlationIdForRecord()).not.toBe(correlationIdForRecord());
    expect(currentCorrelation()).toBeNull();
  });

  it("does not leak out of the request that established it", () => {
    const context = newCorrelation();
    runWithCorrelation(context, () => correlationIdForRecord());
    expect(currentCorrelation()).toBeNull();
  });
});

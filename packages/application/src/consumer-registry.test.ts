/**
 * The registry is configuration, so what is worth testing is the validation
 * that stops an invalid registration from shipping — not the two entries
 * themselves, which review covers.
 */

import { describe, expect, it } from "vitest";

import type { ConsumerRegistration } from "@aios/types";

import {
  CONSUMER_REGISTRY,
  RegistryError,
  assertRegistry,
  consumersFor,
  findRegistration,
} from "./consumer-registry.js";

const base: ConsumerRegistration = {
  consumerName: "example",
  eventTypes: ["WorkCompleted"],
  consumerType: "Projection",
  sideEffectClass: "PostgreSQLLocal",
  orderingRequirement: "PerAggregateStream",
  failureContinuationPolicy: "BlockOrderingKey",
  skipPolicy: "Prohibited",
  enabled: true,
  overrideRationale: null,
};

describe("the shipped registry", () => {
  it("is valid", () => {
    expect(() => assertRegistry()).not.toThrow();
  });

  it("registers every consumer the workers run", () => {
    expect(CONSUMER_REGISTRY.map((r) => r.consumerName).sort()).toEqual([
      "decision-outcome",
      "memory-generation",
      "notifications",
    ]);
  });

  it("finds the consumers for an event type", () => {
    // Two consumers handle `DecisionApproved`: one applies the outcome to the
    // Work, the other projects a notification. That is the normal case.
    expect(consumersFor("DecisionApproved").map((r) => r.consumerName).sort()).toEqual([
      "decision-outcome",
      "notifications",
    ]);
    expect(consumersFor("WorkCreated")).toEqual([]);
  });

  it("reports an unregistered consumer as absent rather than guessing", () => {
    expect(findRegistration("no-such-consumer")).toBeNull();
  });

  it("registers exactly one Projection Consumer, which is the only skippable one", () => {
    // `AllowedWhenRebuildable` is a claim only a projection can make, and
    // `assertRegistry` enforces that. Asserting the count keeps the claim from
    // spreading by copy.
    const projections = CONSUMER_REGISTRY.filter(
      (r) => r.consumerType === "Projection",
    );
    expect(projections.map((r) => r.consumerName)).toEqual(["notifications"]);
    expect(
      CONSUMER_REGISTRY.filter((r) => r.skipPolicy === "AllowedWhenRebuildable"),
    ).toEqual(projections);
  });

  it("does not let a Domain Coordination consumer be skipped without evidence", () => {
    // The dangerous half of recovery, gated by the registration rather than by
    // the operator's judgment at the moment they need it.
    const decisionOutcome = findRegistration("decision-outcome")!;
    expect(decisionOutcome.skipPolicy).toBe("RequiresSafetyEvidence");
  });
});

describe("registry validation", () => {
  it("rejects a duplicate consumer name", () => {
    expect(() => assertRegistry([base, base])).toThrowError(RegistryError);
  });

  it("rejects ConsumerWide ordering", () => {
    // "prohibited for the MVP unless an ADR demonstrates why per-key ordering
    // cannot preserve correctness", and no such ADR exists.
    expect(() =>
      assertRegistry([{ ...base, orderingRequirement: "ConsumerWide" }]),
    ).toThrowError(/ConsumerWide/);
  });

  it("rejects an undocumented override of the default continuation policy", () => {
    expect(() =>
      assertRegistry([
        { ...base, failureContinuationPolicy: "ContinueIndependent" },
      ]),
    ).toThrowError(/states no rationale/);
  });

  it("accepts the same override once it is documented", () => {
    expect(() =>
      assertRegistry([
        {
          ...base,
          failureContinuationPolicy: "ContinueIndependent",
          overrideRationale: "The projection entry is marked incomplete until rebuilt.",
        },
      ]),
    ).not.toThrow();
  });

  it("refuses to enable an ExternalBusinessEffect consumer", () => {
    // Requires the External Effect Contract, which is out of the baseline MVP.
    expect(() =>
      assertRegistry([{ ...base, sideEffectClass: "ExternalBusinessEffect" }]),
    ).toThrowError(/External Effect Contract/);
  });

  it("allows an ExternalBusinessEffect registration that stays disabled", () => {
    expect(() =>
      assertRegistry([
        { ...base, sideEffectClass: "ExternalBusinessEffect", enabled: false },
      ]),
    ).not.toThrow();
  });

  it("only lets a Projection claim its result is rebuildable", () => {
    expect(() =>
      assertRegistry([
        {
          ...base,
          consumerType: "DomainCoordination",
          skipPolicy: "AllowedWhenRebuildable",
        },
      ]),
    ).toThrowError(/not a Projection Consumer/);
  });

  it("rejects a registration with no event type", () => {
    expect(() => assertRegistry([{ ...base, eventTypes: [] }])).toThrowError(
      /registers no event type/,
    );
  });
});

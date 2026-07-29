/**
 * Fixture evaluation for Memory generation.
 *
 * Recorded provider responses paired with the snapshots that produced them, per
 * `docs/architecture/memory-generation-policy.md` § Evaluation. Each case
 * asserts a property of the *pipeline* that must hold regardless of what a model
 * returns on any given day, which is what lets generation be covered on a
 * machine with no provider credential — every CI machine, and most development
 * ones.
 */

import { describe, expect, it } from "vitest";

import {
  IdentityId,
  MembershipId,
  OrganizationId,
  WorkId,
  type HumanMemberPrincipal,
} from "@aios/types";
import {
  completeWork,
  createWork,
  startWork,
  type GeneratedContent,
  type WorkState,
} from "@aios/domain";

import {
  buildProviderInput,
  canonicalize,
  providerInputHash,
} from "./generation-policy.js";
import { GenerationRejectedError } from "./groundedness.js";
import { generateMemoryUseCase, type MemoryGenerator } from "./memory-use-cases.js";
import { buildTestHarness } from "./testing/in-memory.js";

const ORG = OrganizationId("org-1");
const NOW = new Date("2026-07-28T10:00:00.000Z");
const SECRETARY = IdentityId("secretary-1");

const member: HumanMemberPrincipal = {
  type: "HumanMember",
  identityId: IdentityId("identity-1"),
  membershipId: MembershipId("membership-1"),
  organizationId: ORG,
  roles: ["Member"],
};

const system = {
  type: "System" as const,
  component: "memory-generator",
  organizationId: ORG,
};

const completedWork = (): WorkState => {
  const ctx = { principal: member, now: NOW };
  const draft = createWork(
    {
      workId: WorkId("work-1"),
      organizationId: ORG,
      title: "Migrate the billing service",
      description: "The legacy gateway is being retired.",
    },
    ctx,
  ).state;
  return completeWork(startWork(draft, ctx).state, "Cut over 3 services.", ctx)
    .state;
};

/** A generator that returns a recorded response instead of calling a provider. */
class RecordedGenerator implements MemoryGenerator {
  readonly policyVersion = 2;
  readonly promptTemplateVersion = 1;
  readonly outputSchemaVersion = 1;
  readonly modelReference = "recorded";

  /** What the generator was shown, so a test can assert on it. */
  seen: { providerInput: unknown; providerInputHash: string } | null = null;
  calls = 0;

  constructor(
    private readonly response: GeneratedContent | (() => never),
  ) {}

  async generate(input: {
    providerInput: unknown;
    providerInputHash: string;
  }): Promise<GeneratedContent> {
    this.calls += 1;
    this.seen = input;
    if (typeof this.response === "function") {
      // Returns `never`, so control does not reach past this call.
      return this.response();
    }
    return this.response;
  }
}

const grounded: GeneratedContent = {
  title: "Migrate the billing service",
  summary: "Three services were cut over.",
  contentHash: "hash",
  content: "The legacy gateway was retired. Three services were cut over.",
  sourceReferences: ["work:work-1"],
};

const run = async (
  harness: ReturnType<typeof buildTestHarness>,
  generator: MemoryGenerator,
) => {
  const work = completedWork();
  await harness.deps.uow.transaction((tx) => tx.work.insert(work));

  return generateMemoryUseCase(
    harness.deps,
    generator,
    { principal: system, now: NOW },
    {
      organizationId: ORG,
      workId: work.workId,
      sourceEventId: "event-1",
      sourceSnapshotId: "snapshot-1",
      sourceSnapshotHash: "snapshot-hash-1",
      secretaryIdentityId: SECRETARY,
      systemPrincipalId: "memory-generator",
      workerId: "worker-1",
    },
  );
};

describe("provider input", () => {
  it("carries no reference to any person", () => {
    const work = completedWork();
    const input = buildProviderInput(work, null);
    const serialized = canonicalize(input);

    // The Work knows who created and completed it. None of that reaches the
    // provider: it is retention surface ADR-0012 requires to stay erasable, and
    // the model has no use for it.
    expect(serialized).not.toContain(member.identityId);
    expect(serialized).not.toContain(member.membershipId);
  });

  it("hashes identically regardless of field order", () => {
    // The retry story rests on this. A hash that depended on insertion order
    // would make one logical operation produce two provider_input_hash values.
    const a = canonicalize({ b: 2, a: 1, c: { y: 2, x: 1 } });
    const b = canonicalize({ c: { x: 1, y: 2 }, a: 1, b: 2 });
    expect(a).toBe(b);
  });

  it("omits absent fields rather than emitting null", () => {
    const work = { ...completedWork(), description: null };
    expect(canonicalize(buildProviderInput(work, null))).not.toContain("null");
  });

  it("produces a stable hash across calls", () => {
    const work = completedWork();
    expect(providerInputHash(buildProviderInput(work, null))).toBe(
      providerInputHash(buildProviderInput(work, null)),
    );
  });
});

describe("a grounded response", () => {
  it("becomes a Memory draft", async () => {
    const harness = buildTestHarness(NOW);
    const memory = await run(harness, new RecordedGenerator(grounded));

    expect(memory?.status).toBe("Generated");
    expect(memory?.provenance.generationPolicyVersion).toBe(2);
  });

  it("marks the operation Generated and links the Memory", async () => {
    const harness = buildTestHarness(NOW);
    const memory = await run(harness, new RecordedGenerator(grounded));

    const operation = harness.generationOperations.find(ORG, WorkId("work-1"), 2);
    expect(operation).toMatchObject({ status: "Generated", attemptCount: 1 });
    expect(operation?.memoryId).toBe(memory?.memoryId);
  });

  it("records the provider input hash before the provider is called", async () => {
    const harness = buildTestHarness(NOW);
    const generator = new RecordedGenerator(grounded);
    await run(harness, generator);

    // ADR-0004's ordering: the operation commits with its hash first, so a
    // process that dies mid-call leaves a record of what was attempted.
    const operation = harness.generationOperations.find(ORG, WorkId("work-1"), 2);
    expect(operation?.providerInputHash).toBe(generator.seen?.providerInputHash);
  });
});

describe("an ungrounded response", () => {
  const invented: GeneratedContent = {
    ...grounded,
    content: "Twelve services were cut over, led by Dana Whitfield in 2027.",
  };

  it("never becomes a Memory", async () => {
    const harness = buildTestHarness(NOW);
    await expect(run(harness, new RecordedGenerator(invented))).rejects.toThrow();

    // The property the whole policy exists for: a draft asserting facts the
    // Work never recorded does not reach a reviewer.
    expect(await harness.memories.listByOrganization(ORG)).toEqual([]);
  });

  it("fails the operation terminally rather than retrying", async () => {
    const harness = buildTestHarness(NOW);
    await expect(run(harness, new RecordedGenerator(invented))).rejects.toThrow();

    // Retrying identical input produces an identical answer, so `RetryPending`
    // would only spend money to be told the same thing.
    expect(harness.generationOperations.find(ORG, WorkId("work-1"), 2)).toMatchObject(
      { status: "Failed" },
    );
  });
});

describe("a provider failure", () => {
  const refuse = () => {
    throw new GenerationRejectedError(
      "GENERATION_REFUSED",
      "The provider declined to generate this draft.",
      true,
    );
  };

  const timeout = () => {
    throw new Error("socket hang up");
  };

  it("records a refusal as terminal", async () => {
    const harness = buildTestHarness(NOW);
    await expect(run(harness, new RecordedGenerator(refuse))).rejects.toThrow();
    expect(harness.generationOperations.find(ORG, WorkId("work-1"), 2)).toMatchObject(
      { status: "Failed" },
    );
  });

  it("leaves a transport failure retryable", async () => {
    const harness = buildTestHarness(NOW);
    await expect(run(harness, new RecordedGenerator(timeout))).rejects.toThrow();

    // Unlike a refusal, the same input may well succeed next time.
    expect(harness.generationOperations.find(ORG, WorkId("work-1"), 2)).toMatchObject(
      { status: "RetryPending" },
    );
  });

  it("creates no Memory either way", async () => {
    const harness = buildTestHarness(NOW);
    await expect(run(harness, new RecordedGenerator(timeout))).rejects.toThrow();
    expect(await harness.memories.listByOrganization(ORG)).toEqual([]);
  });
});

describe("redelivery", () => {
  it("does not call the provider twice for one Work", async () => {
    const harness = buildTestHarness(NOW);
    const generator = new RecordedGenerator(grounded);
    const work = completedWork();
    await harness.deps.uow.transaction((tx) => tx.work.insert(work));

    const invoke = () =>
      generateMemoryUseCase(
        harness.deps,
        generator,
        { principal: system, now: NOW },
        {
          organizationId: ORG,
          workId: work.workId,
          sourceEventId: "event-1",
          sourceSnapshotId: "snapshot-1",
          sourceSnapshotHash: "snapshot-hash-1",
          secretaryIdentityId: SECRETARY,
          systemPrincipalId: "memory-generator",
          workerId: "worker-1",
        },
      );

    const first = await invoke();
    const second = await invoke();

    // At-least-once delivery means this runs more than once for the same Work.
    // A second provider call would be a second bill for the same draft.
    expect(generator.calls).toBe(1);
    expect(second?.memoryId).toBe(first?.memoryId);
  });
});

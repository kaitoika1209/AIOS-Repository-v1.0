import { describe, expect, it } from "vitest";

import {
  IdentityId,
  MembershipId,
  MemoryId,
  OrganizationId,
  WorkId,
  type AiPrincipal,
  type HumanMemberPrincipal,
  type Principal,
} from "@aios/types";

import {
  approveMemory,
  createGeneratedMemory,
  currentMemoryRevision,
  editGeneratedMemory,
  memoryRevisionByNumber,
  rejectMemory,
  reopenMemory,
  submitMemoryForReview,
  type MemoryState,
} from "./memory.js";
import type { ActorContext } from "./work.js";

const ORG = OrganizationId("org-1");
const NOW = new Date("2026-07-28T10:00:00Z");
const SECRETARY = IdentityId("secretary-1");

const human = (): HumanMemberPrincipal => ({
  type: "HumanMember",
  identityId: IdentityId("identity-1"),
  membershipId: MembershipId("membership-1"),
  organizationId: ORG,
  roles: ["Reviewer"],
});

const secretary: AiPrincipal = {
  type: "AI",
  identityId: SECRETARY,
  organizationId: ORG,
  assistanceOperation: "memory.generate.v1",
};

const system = { type: "System" as const, component: "memory-generator", organizationId: ORG };

const ctx = (principal: Principal = human()): ActorContext => ({ principal, now: NOW });

const generated = (): MemoryState =>
  createGeneratedMemory(
    {
      memoryId: MemoryId("memory-1"),
      organizationId: ORG,
      sourceWorkId: WorkId("work-1"),
      revisionId: "rev-1",
      generated: {
        title: "Shipping the MVP",
        summary: "We shipped on Friday.",
        content: "Full narrative.",
        sourceReferences: ["work-1"],
        contentHash: "hash-1",
      },
      provenance: {
        sourceSnapshotId: "snapshot-1",
        sourceSnapshotHash: "snap-hash",
        generationPolicyVersion: 1,
        generatedBySystemPrincipalId: "memory-generator",
        generatedAt: NOW,
      },
      generatedBy: SECRETARY,
    },
    ctx(system),
  ).state;

const inReview = (): MemoryState => submitMemoryForReview(generated(), ctx()).state;
const rejected = (): MemoryState => rejectMemory(inReview(), "Missing context", ctx()).state;

describe("generation", () => {
  it("starts Generated, active, and attributed to the Secretary", () => {
    const memory = generated();
    expect(memory.status).toBe("Generated");
    expect(memory.isActive).toBe(true);
    expect(currentMemoryRevision(memory).author).toMatchObject({
      actorType: "AI",
      actorId: SECRETARY,
      membershipId: null,
    });
  });

  it("does not require Human authority — a System Principal generates it", () => {
    expect(() => generated()).not.toThrow();
  });

  it("carries generation provenance", () => {
    expect(generated().provenance).toMatchObject({
      sourceSnapshotId: "snapshot-1",
      generationPolicyVersion: 1,
    });
  });
});

describe("human authority", () => {
  it.each([
    ["approve", () => approveMemory(inReview(), "ok", ctx(secretary))],
    ["reject", () => rejectMemory(inReview(), "no", ctx(secretary))],
    ["submit", () => submitMemoryForReview(generated(), ctx(secretary))],
    ["edit", () => editGeneratedMemory(generated(), { title: "x" }, "h", ctx(secretary))],
    ["reopen", () => reopenMemory(rejected(), "rev-2", ctx(secretary))],
  ])("the Secretary cannot %s a Memory", (_name, act) => {
    expect(act).toThrowError(/requires a Human Member/);
  });

  it("the Secretary may draft but never approve — the MVP's central boundary", () => {
    // It generated the content above, yet cannot approve its own draft.
    expect(() => approveMemory(inReview(), "self-approved", ctx(secretary))).toThrowError(
      /requires a Human Member/,
    );
  });
});

describe("draft correction", () => {
  it("edits the current revision rather than creating a new one", () => {
    const edited = editGeneratedMemory(
      generated(),
      { summary: "Corrected summary." },
      "hash-2",
      ctx(),
    ).state;

    expect(edited.revisions).toHaveLength(1);
    expect(currentMemoryRevision(edited).summary).toBe("Corrected summary.");
    expect(currentMemoryRevision(edited).contentHash).toBe("hash-2");
  });

  it("refuses edits once submitted", () => {
    expect(() =>
      editGeneratedMemory(inReview(), { title: "late" }, "h", ctx()),
    ).toThrowError(/cannot accept memory.edit_generated from state InReview/);
  });
});

describe("review", () => {
  it("Generated → InReview locks the revision", () => {
    const memory = inReview();
    expect(memory.status).toBe("InReview");
    expect(currentMemoryRevision(memory).status).toBe("Submitted");
    expect(memory.submittedRevisionId).toBe("rev-1");
  });

  it("approval is terminal and the content becomes immutable", () => {
    const approved = approveMemory(inReview(), "Accurate", ctx()).state;
    expect(approved.status).toBe("Approved");
    expect(currentMemoryRevision(approved).status).toBe("Approved");

    expect(() => editGeneratedMemory(approved, { title: "x" }, "h", ctx())).toThrowError(
      /cannot accept memory.edit_generated from state Approved/,
    );
    expect(() => reopenMemory(approved, "rev-2", ctx())).toThrowError(
      /cannot accept memory.reopen from state Approved/,
    );
    expect(() => rejectMemory(approved, "changed my mind", ctx())).toThrowError(
      /cannot accept memory.reject from state Approved/,
    );
  });

  it("records who reviewed and why", () => {
    const approved = approveMemory(inReview(), "Accurate", ctx()).state;
    expect(approved.reviewRecords).toHaveLength(1);
    expect(approved.reviewRecords[0]).toMatchObject({
      outcome: "Approved",
      note: "Accurate",
      revisionNumber: 1,
    });
  });

  it("rejection requires a note", () => {
    expect(() => rejectMemory(inReview(), "   ", ctx())).toThrowError(/requires a note/);
  });
});

describe("reopen", () => {
  it("Rejected → Generated creates the next revision", () => {
    const reopened = reopenMemory(rejected(), "rev-2", ctx()).state;
    expect(reopened.status).toBe("Generated");
    expect(reopened.revisions).toHaveLength(2);
    expect(currentMemoryRevision(reopened).revisionNumber).toBe(2);
  });

  it("does not rewrite the rejected revision", () => {
    const reopened = reopenMemory(rejected(), "rev-2", ctx()).state;
    const edited = editGeneratedMemory(
      reopened,
      { summary: "Rewritten after rejection." },
      "hash-3",
      ctx(),
    ).state;

    const original = memoryRevisionByNumber(edited, 1)!;
    expect(original.summary).toBe("We shipped on Friday.");
    expect(original.status).toBe("Rejected");
    expect(memoryRevisionByNumber(edited, 2)!.summary).toBe("Rewritten after rejection.");
  });

  it("keeps the rejection as review evidence", () => {
    const reopened = reopenMemory(rejected(), "rev-2", ctx()).state;
    expect(reopened.reviewRecords).toHaveLength(1);
    expect(reopened.reviewRecords[0]).toMatchObject({
      outcome: "Rejected",
      note: "Missing context",
    });
  });

  it("attributes the reopened revision to the human, not the Secretary", () => {
    const reopened = reopenMemory(rejected(), "rev-2", ctx()).state;
    expect(currentMemoryRevision(reopened).author.actorType).toBe("HumanMember");
  });
});

describe("events", () => {
  it("emits MemoryGenerated, then review events carrying the aggregate version", () => {
    const created = createGeneratedMemory(
      {
        memoryId: MemoryId("m"),
        organizationId: ORG,
        sourceWorkId: WorkId("work-1"),
        revisionId: "r",
        generated: {
          title: "t",
          summary: "s",
          content: "c",
          sourceReferences: [],
          contentHash: "h",
        },
        provenance: {
          sourceSnapshotId: "snap",
          sourceSnapshotHash: "h",
          generationPolicyVersion: 1,
          generatedBySystemPrincipalId: "gen",
          generatedAt: NOW,
        },
        generatedBy: SECRETARY,
      },
      ctx(system),
    );

    expect(created.events.map((e) => e.type)).toEqual(["MemoryGenerated"]);
    expect(created.events[0]!.aggregateVersion).toBe(1);
    // The generating actor is an AI Principal, which holds no Membership.
    expect(created.events[0]!.actorMembershipId).toBeNull();

    const approved = approveMemory(inReview(), "ok", ctx());
    expect(approved.events[0]!.aggregateVersion).toBe(approved.state.version);
  });
});

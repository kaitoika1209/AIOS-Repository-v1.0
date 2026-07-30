/**
 * AI assistance, through the Decision port (ADR-0011, Accepted).
 *
 * The properties worth asserting are the ones the ADR makes structural: deny by
 * default, fail closed on an unknown operation, no authoritative effect, and
 * adoption as the Human's own separate command.
 */

import { describe, expect, it, vi } from "vitest";

import {
  IdentityId,
  MembershipId,
  OrganizationId,
  type HumanMemberPrincipal,
  type Role,
} from "@aios/types";

import {
  ASSISTANCE_OPERATIONS,
  AssistanceNotGrantedError,
  DECISION_PORT_CONTRACT_VERSION,
  findGrantSpec,
  type DecisionAssistanceProvider,
} from "./assistance.js";
import { AuthorizationError } from "./authorization.js";
import {
  createDecisionUseCase,
  editDecisionDraftUseCase,
  listDecisionContributionsUseCase,
  requestDecisionMaterialUseCase,
} from "./decision-use-cases.js";
import { createWorkUseCase } from "./work-use-cases.js";
import { buildTestHarness } from "./testing/in-memory.js";

const ORG = OrganizationId("org-1");
const NOW = new Date("2026-07-30T10:00:00Z");
const AUTHOR = MembershipId("membership-author");
const STRANGER = MembershipId("membership-stranger");

const ctx = (membershipId = AUTHOR, roles: Role[] = ["Member"]) => ({
  principal: {
    type: "HumanMember",
    identityId: IdentityId(`identity-${membershipId}`),
    membershipId,
    organizationId: ORG,
    roles,
  } satisfies HumanMemberPrincipal,
  organizationId: ORG,
  now: NOW,
});

const provider: DecisionAssistanceProvider = {
  secretaryPrincipalId: "decision-secretary",
  draftMaterial: async (request) => ({
    content: `Material for: ${request.question}`,
  }),
};

const GRANT = {
  organizationId: ORG,
  secretaryPrincipalId: provider.secretaryPrincipalId,
  contextKey: "Decision",
  assistanceOperation: "decision.draft_material",
  portContractVersion: DECISION_PORT_CONTRACT_VERSION,
};

const setup = async (granted = true) => {
  const h = buildTestHarness(NOW);
  const work = await createWorkUseCase(h.deps, ctx(), { title: "Ship it" });
  const decision = await createDecisionUseCase(h.deps, ctx(), {
    relatedWorkId: work.workId,
    title: "Which database?",
    question: "Which database should we standardise on?",
    options: [{ optionId: "pg", summary: "PostgreSQL" }],
  });
  if (granted) await h.assistanceGrants.grant(GRANT);
  return { h, decisionId: decision.decisionId };
};

describe("the port contract", () => {
  it("exposes no Human-only operation", () => {
    // ADR-0011 lists what must not be a port member. The vocabulary is closed,
    // so this is a check that the closure holds rather than a search.
    const forbidden = [
      "work.complete",
      "work.cancel",
      "decision.approve",
      "decision.submit",
      "memory.approve",
      "organization.invite_member",
    ];
    for (const name of forbidden) {
      expect(ASSISTANCE_OPERATIONS as readonly string[]).not.toContain(name);
    }
  });

  it("fails closed on an unknown operation", () => {
    expect(findGrantSpec("Decision", "decision.decide_for_me")).toBeNull();
    expect(findGrantSpec("Knowledge", "decision.draft_material")).toBeNull();
  });
});

describe("requesting Decision material", () => {
  it("records an attributable advisory contribution", async () => {
    const { h, decisionId } = await setup();

    const contribution = await requestDecisionMaterialUseCase(
      h.deps,
      ctx(),
      provider,
      decisionId,
    );

    expect(contribution).toMatchObject({
      contributionType: "DecisionMaterialDraft",
      secretaryPrincipalId: "decision-secretary",
      requestedByMembershipId: AUTHOR,
      adoptedAt: null,
    });
    expect(contribution.content).toContain("standardise");
  });

  it("changes no authoritative Decision content", async () => {
    const { h, decisionId } = await setup();
    const before = (await h.decisions.findById(ORG, decisionId))!;

    await requestDecisionMaterialUseCase(h.deps, ctx(), provider, decisionId);

    const after = (await h.decisions.findById(ORG, decisionId))!;
    // Not the version, not the revision, not the question. The Secretary
    // proposes; nothing it does reaches the Aggregate.
    expect(after).toEqual(before);
    expect(h.outbox.typesOf()).toEqual(["WorkCreated", "DecisionCreated"]);
  });

  it("refuses when no grant is active", async () => {
    const { h, decisionId } = await setup(false);

    // Deny by default. The provider is never reached.
    const spy = vi.fn(provider.draftMaterial);
    await expect(
      requestDecisionMaterialUseCase(
        h.deps,
        ctx(),
        { ...provider, draftMaterial: spy },
        decisionId,
      ),
    ).rejects.toBeInstanceOf(AssistanceNotGrantedError);
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses once the grant is revoked", async () => {
    const { h, decisionId } = await setup();
    await requestDecisionMaterialUseCase(h.deps, ctx(), provider, decisionId);

    h.assistanceGrants.revoke(GRANT);

    // "current policy evaluation at execution time" — the grant is consulted
    // on every invocation, not cached from the first.
    await expect(
      requestDecisionMaterialUseCase(h.deps, ctx(), provider, decisionId),
    ).rejects.toBeInstanceOf(AssistanceNotGrantedError);
  });

  it("refuses a grant for a different contract version", async () => {
    const { h, decisionId } = await setup(false);
    await h.assistanceGrants.grant({ ...GRANT, portContractVersion: 99 });

    // A port whose contract changed is a different port.
    await expect(
      requestDecisionMaterialUseCase(h.deps, ctx(), provider, decisionId),
    ).rejects.toBeInstanceOf(AssistanceNotGrantedError);
  });

  it("refuses a grant issued to a different Secretary", async () => {
    const { h, decisionId } = await setup(false);
    await h.assistanceGrants.grant({
      ...GRANT,
      secretaryPrincipalId: "some-other-secretary",
    });

    await expect(
      requestDecisionMaterialUseCase(h.deps, ctx(), provider, decisionId),
    ).rejects.toBeInstanceOf(AssistanceNotGrantedError);
  });

  it("refuses a Reviewer, who holds no assistance permission", async () => {
    const { h, decisionId } = await setup();
    await expect(
      requestDecisionMaterialUseCase(
        h.deps,
        ctx(STRANGER, ["Reviewer"]),
        provider,
        decisionId,
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("refuses a Member unrelated to the Decision", async () => {
    const { h, decisionId } = await setup();
    await expect(
      requestDecisionMaterialUseCase(h.deps, ctx(STRANGER), provider, decisionId),
    ).rejects.toMatchObject({ name: "RelationshipRequiredError" });
  });

  it("treats an empty draft as a failed attempt, not a contribution", async () => {
    const { h, decisionId } = await setup();

    await expect(
      requestDecisionMaterialUseCase(
        h.deps,
        ctx(),
        { ...provider, draftMaterial: async () => ({ content: "   " }) },
        decisionId,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    expect(await h.contributions.listForDecision(ORG, decisionId)).toEqual([]);
  });

  it("sends the provider only the material the context chose", async () => {
    const { h, decisionId } = await setup();
    const seen: unknown[] = [];

    await requestDecisionMaterialUseCase(
      h.deps,
      ctx(),
      {
        ...provider,
        draftMaterial: async (request) => {
          seen.push(request);
          return { content: "ok" };
        },
      },
      decisionId,
    );

    // No identifiers, no actor, no review history: nothing the provider could
    // use to ask for more than it was given.
    expect(Object.keys(seen[0] as object).sort()).toEqual([
      "context",
      "options",
      "question",
    ]);
  });
});

describe("adoption", () => {
  it("is the Human's own edit command, and is recorded", async () => {
    const { h, decisionId } = await setup();
    const contribution = await requestDecisionMaterialUseCase(
      h.deps,
      ctx(),
      provider,
      decisionId,
    );

    const edited = await editDecisionDraftUseCase(
      h.deps,
      ctx(),
      decisionId,
      { context: contribution.content },
      contribution.contributionId,
    );

    // The content is authoritative because a Human wrote it through the edit
    // command, not because the Secretary produced it.
    expect(edited.version).toBe(2);
    const [recorded] = await h.contributions.listForDecision(ORG, decisionId);
    expect(recorded).toMatchObject({
      adoptedAt: NOW,
      adoptedByIdentityId: IdentityId(`identity-${AUTHOR}`),
    });
  });

  it("records adoption once", async () => {
    const { h, decisionId } = await setup();
    const contribution = await requestDecisionMaterialUseCase(
      h.deps,
      ctx(),
      provider,
      decisionId,
    );

    await editDecisionDraftUseCase(
      h.deps,
      ctx(),
      decisionId,
      { context: "first" },
      contribution.contributionId,
    );
    await editDecisionDraftUseCase(
      h.deps,
      { ...ctx(), now: new Date("2026-07-31T10:00:00Z") },
      decisionId,
      { context: "second" },
      contribution.contributionId,
    );

    const [recorded] = await h.contributions.listForDecision(ORG, decisionId);
    expect(recorded!.adoptedAt).toEqual(NOW);
  });

  it("does not require adoption for an ordinary edit", async () => {
    const { h, decisionId } = await setup();
    await requestDecisionMaterialUseCase(h.deps, ctx(), provider, decisionId);

    await editDecisionDraftUseCase(h.deps, ctx(), decisionId, { context: "mine" });

    const [recorded] = await h.contributions.listForDecision(ORG, decisionId);
    expect(recorded!.adoptedAt).toBeNull();
  });
});

describe("reading contributions", () => {
  it("is scoped to the Decision and refuses a stranger", async () => {
    const { h, decisionId } = await setup();
    await requestDecisionMaterialUseCase(h.deps, ctx(), provider, decisionId);

    expect(await listDecisionContributionsUseCase(h.deps, ctx(), decisionId)).toHaveLength(1);
    await expect(
      listDecisionContributionsUseCase(h.deps, ctx(STRANGER), decisionId),
    ).rejects.toMatchObject({ name: "RelationshipRequiredError" });
  });
});

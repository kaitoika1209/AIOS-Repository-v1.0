/**
 * AI assistance ports (ADR-0011, Accepted).
 *
 * The ADR's structural rule is interface segregation: "A string-based generic
 * `ExecuteCommand(commandName, payload)` or general tool executor is
 * prohibited." So there is no dispatcher here. Each context exposes a narrow
 * port with typed operations, and a Human-only command cannot be reached
 * through one because it is not a member of one.
 *
 * This release implements exactly one operation, which is the smallest useful
 * vertical slice ADR-0010's promotion rule asks for. Adding a second means
 * adding a method and a grant, not widening a payload.
 */

import type { DecisionId, IdentityId, MembershipId, OrganizationId } from "@aios/types";

/** Contexts that own an assistance port. Unknown values fail closed. */
export const ASSISTANCE_CONTEXTS = ["Decision"] as const;
export type AssistanceContext = (typeof ASSISTANCE_CONTEXTS)[number];

/**
 * Operations the ports expose.
 *
 * `decision.draft_material` prepares Decision material — one of the things
 * `mvp.md` says the Secretary may do. None of the Human-only commands ADR-0011
 * lists appears here, and none can: this is a closed vocabulary, not a name a
 * caller supplies.
 */
export const ASSISTANCE_OPERATIONS = ["decision.draft_material"] as const;
export type AssistanceOperation = (typeof ASSISTANCE_OPERATIONS)[number];

/** Contribution kinds a Decision may record. */
export const CONTRIBUTION_TYPES = ["DecisionMaterialDraft"] as const;
export type ContributionType = (typeof CONTRIBUTION_TYPES)[number];

/**
 * The port contract version.
 *
 * Part of a grant's identity, so a contract change invalidates existing grants
 * rather than silently reinterpreting them.
 */
export const DECISION_PORT_CONTRACT_VERSION = 1;

/**
 * A granted assistance permission.
 *
 * Version-controlled configuration in the same sense as the consumer registry:
 * the runtime never mints one. What the database stores is which Organizations
 * have activated a grant that this file declares to exist.
 */
export interface AssistanceGrantSpec {
  readonly contextKey: AssistanceContext;
  readonly assistanceOperation: AssistanceOperation;
  readonly portContractVersion: number;
  readonly contributionType: ContributionType;
}

export const ASSISTANCE_GRANTS: readonly AssistanceGrantSpec[] = [
  {
    contextKey: "Decision",
    assistanceOperation: "decision.draft_material",
    portContractVersion: DECISION_PORT_CONTRACT_VERSION,
    contributionType: "DecisionMaterialDraft",
  },
];

export const findGrantSpec = (
  contextKey: string,
  assistanceOperation: string,
): AssistanceGrantSpec | null =>
  ASSISTANCE_GRANTS.find(
    (g) =>
      g.contextKey === contextKey &&
      g.assistanceOperation === assistanceOperation,
  ) ?? null;

/** Refused because no active grant authorizes the invocation. */
export class AssistanceNotGrantedError extends Error {
  readonly code = "ASSISTANCE_NOT_GRANTED" as const;

  constructor(message: string) {
    super(message);
    this.name = "AssistanceNotGrantedError";
  }
}

/** One recorded advisory contribution. Never authoritative content. */
export interface SecretaryContribution {
  readonly contributionId: string;
  readonly decisionId: DecisionId;
  readonly decisionRevisionId: string;
  readonly secretaryPrincipalId: string;
  readonly requestedByMembershipId: MembershipId;
  readonly contributionType: ContributionType;
  readonly content: string;
  readonly createdAt: Date;
  readonly adoptedAt: Date | null;
  readonly adoptedByIdentityId: IdentityId | null;
}

export interface AssistanceGrantRepository {
  /**
   * Whether an active grant authorizes this exact invocation.
   *
   * All five identity fields, not a subset: ADR-0011 identifies a grant by
   * Organization, Secretary, context, operation, and contract version, and
   * matching on fewer would let a grant for one operation authorize another.
   */
  isGranted(input: {
    readonly organizationId: OrganizationId;
    readonly secretaryPrincipalId: string;
    readonly contextKey: string;
    readonly assistanceOperation: string;
    readonly portContractVersion: number;
  }): Promise<boolean>;

  /** Activate a grant. Called by the seed and by an Organization Owner. */
  grant(input: {
    readonly grantId: string;
    readonly organizationId: OrganizationId;
    readonly secretaryPrincipalId: string;
    readonly contextKey: string;
    readonly assistanceOperation: string;
    readonly portContractVersion: number;
    readonly grantedByMembershipId: MembershipId;
    readonly reason: string;
    readonly now: Date;
  }): Promise<void>;
}

export interface SecretaryContributionRepository {
  append(input: {
    readonly contributionId: string;
    readonly organizationId: OrganizationId;
    readonly decisionId: DecisionId;
    readonly decisionRevisionId: string;
    readonly secretaryPrincipalId: string;
    readonly requestedByIdentityId: IdentityId;
    readonly requestedByMembershipId: MembershipId;
    readonly contributionType: ContributionType;
    readonly content: string;
    readonly generationId: string;
    readonly now: Date;
  }): Promise<void>;

  listForDecision(
    organizationId: OrganizationId,
    decisionId: DecisionId,
  ): Promise<readonly SecretaryContribution[]>;

  /**
   * Record that a Human adopted a contribution.
   *
   * Returns false when no row matched. Called from inside the Human's own edit
   * transaction: "Adoption does not update the contribution into an
   * authoritative state automatically. The Human executes a Decision Aggregate
   * edit command."
   */
  markAdopted(input: {
    readonly organizationId: OrganizationId;
    readonly decisionId: DecisionId;
    readonly contributionId: string;
    readonly adoptedByIdentityId: IdentityId;
    readonly now: Date;
  }): Promise<boolean>;
}

/**
 * What a provider is asked to produce, and what it returns.
 *
 * The port owns the contract, so the provider sees only what the Decision
 * context chose to send — "the minimum permitted source data". No repository, no
 * Aggregate, no identifiers a provider could use to ask for more.
 */
export interface DecisionMaterialRequest {
  readonly question: string;
  readonly context: string | null;
  readonly options: readonly { readonly optionId: string; readonly summary: string }[];
}

export interface DecisionMaterialDraft {
  readonly content: string;
}

/**
 * The Secretary Runtime's provider seam.
 *
 * A port in the ADR-0004 sense as well: the provider computes a candidate with
 * no authority. Its output is stored as an advisory contribution and reaches
 * authoritative content only if a Human edits it in.
 */
export interface DecisionAssistanceProvider {
  readonly secretaryPrincipalId: string;
  draftMaterial(request: DecisionMaterialRequest): Promise<DecisionMaterialDraft>;
}

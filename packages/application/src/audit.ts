/**
 * The authorization audit record.
 *
 * `mvp.md` requires that "every protected action records the acting principal"
 * and that important transitions record previous and next state. The Outbox
 * cannot satisfy that alone, and the reason is structural rather than a matter
 * of missing columns: **a refused command produces no event**. Every denial in
 * the system was invisible.
 *
 * So this store records both outcomes. An `Allow` row is the decision behind an
 * event and links to it; a `Deny` row is the only record that the attempt
 * happened at all.
 *
 * The port exposes `record` and nothing else. "The audit repository should
 * expose `Insert` only", and "Audit information must not be silently
 * overwritten" — there is no method here that could.
 *
 * Two call sites feed it, and between them they cover what neither can alone:
 *
 * - `AuditInterceptor` records the decision. It wraps every non-`GET` request,
 *   so it cannot be forgotten per use case — and a denial never reaches a use
 *   case at all.
 * - `recordTransition`, below, records previous and next state, which the edge
 *   cannot see because it holds the request and the response, never the row the
 *   handler read.
 *
 * `RequestContextGuard` is a third, for the narrow set of refusals Nest makes
 * before any interceptor runs.
 */

import { randomUUID } from "node:crypto";

import { describeError, getLogger } from "./logging.js";
import {
  correlationIdForRecord,
  requestIdForRecord,
} from "./correlation.js";

import type { IdentityId, MembershipId, OrganizationId } from "@aios/types";

export const AUDIT_OUTCOMES = ["Allow", "Deny"] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

/**
 * The policy the decision was made under.
 *
 * Recorded rather than implied, so a decision can be re-read against the rules
 * that produced it. A permission set that changes later does not rewrite what
 * was allowed at the time.
 */
export const AUTHORIZATION_POLICY_ID = "aios-authorization-model";
export const AUTHORIZATION_POLICY_VERSION = 1;

export interface AuditRecord {
  readonly authorizationAuditId: string;
  readonly requestId: string;
  readonly correlationId: string;
  readonly commandId: string | null;

  readonly principalId: string;
  readonly principalType: string;
  /** Null when the request was refused before an Identity was resolved. */
  readonly identityId: IdentityId | null;
  readonly membershipId: MembershipId | null;
  /**
   * Null for a request refused at Organization resolution, and for Organization
   * creation, which has no Organization until it succeeds.
   */
  readonly organizationId: OrganizationId | null;

  readonly commandType: string;
  readonly permission: string | null;
  readonly resourceType: string | null;
  readonly resourceId: string | null;

  readonly outcome: AuditOutcome;
  /** Required on every `Deny`: a refusal that does not say why is not a record. */
  readonly reasonCode: string | null;

  /** Null on a denial, because a refused command changes no state. */
  readonly previousState: string | null;
  readonly nextState: string | null;

  readonly evaluatedAt: Date;
  readonly resultingEventId: string | null;
}

/**
 * Insert, and nothing else.
 *
 * `persistence-and-data-model.md` states the shape outright: "The audit
 * repository should expose `Insert`" only. There is no update, no delete, and no
 * read — an audit row's entire lifecycle is coming into existence.
 *
 * The missing read is not an oversight. `authorization.read_audit` is a Reserved
 * permission, so no route may expose the trail, and adding a method for a caller
 * that ADR-0010 forbids building would be exactly the speculative surface the
 * promotion rule exists to prevent. Until an ADR promotes it, the audit is read
 * with operational SQL by people who already hold database access.
 */
export interface AuditRepository {
  record(entry: AuditRecord): Promise<void>;
}

/**
 * Record a business transition.
 *
 * The edge interceptor records *that* a command was allowed; only the use case
 * knows what the resource was before it ran. `mvp.md` requires both states on
 * every important business transition, so this is the half the edge cannot
 * supply.
 *
 * Never awaited into the command's own transaction and never allowed to fail it:
 * an audit outage must not become an availability outage. `scripts/check_audit.py`
 * checks that every status-changing use case calls this, so it cannot be quietly
 * omitted.
 */
export const recordTransition = (
  audit: AuditRepository,
  input: {
    readonly organizationId: OrganizationId;
    readonly identityId: IdentityId | null;
    readonly membershipId: MembershipId | null;
    readonly commandType: string;
    readonly permission: string;
    readonly resourceType: string;
    readonly resourceId: string;
    readonly previousState: string;
    readonly nextState: string;
    readonly now: Date;
  },
): void => {
  void audit
    .record({
      authorizationAuditId: randomUUID(),
      // From the request, not minted here. Three sites used to call
      // `randomUUID()` independently, so one HTTP request produced three
      // unrelated correlation ids and no workflow could be followed across them.
      requestId: requestIdForRecord(),
      correlationId: correlationIdForRecord(),
      commandId: null,
      principalId: input.membershipId ?? "system",
      principalType: input.membershipId === null ? "System" : "HumanMember",
      identityId: input.identityId,
      membershipId: input.membershipId,
      organizationId: input.organizationId,
      commandType: input.commandType,
      permission: input.permission,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      outcome: "Allow",
      reasonCode: null,
      previousState: input.previousState,
      nextState: input.nextState,
      evaluatedAt: input.now,
      resultingEventId: null,
    })
    .catch((error: unknown) => {
      // Never `{ input, error }`. The input carries principal and Organization
      // identifiers, and a PostgreSQL error's `detail` carries the conflicting
      // value — on a duplicate that is a real email address.
      getLogger().log({
        severity: "ERROR",
        operationalLogName: "audit.write_failed",
        operationalLogClass: "Authorization",
        operationalLogCategory: "Security",
        message: "A transition audit record could not be written.",
        outcome: "Failure",
        attributes: {
          "authorization.permission": input.permission,
          "domain.command_type": input.commandType,
          ...describeError(error),
        },
      });
    });
};

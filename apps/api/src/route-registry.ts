/**
 * Route to permission mapping, for the audit's `permission` column.
 *
 * ADR-0014 says "The `operation` value recorded for observability is the
 * permission identifier, so `POST /works/{workId}/complete` reports
 * `work.complete`. Route and telemetry cannot drift apart." This is that
 * mapping, and `scripts/check_audit.py` compares it to the ADR's catalogue so
 * the two cannot drift.
 *
 * A route with no entry records `null` rather than a guess. Two routes have no
 * permission by design — invitation acceptance and Organization creation — and
 * inventing one for them would misreport how they are authorized.
 */

import type { Request } from "express";

/** Keyed by `METHOD path`, using the Express route pattern. */
const ROUTES: Readonly<Record<string, string>> = {
  "POST /works": "work.create",
  "PATCH /works/:workId": "work.edit",
  "POST /works/:workId/start": "work.start",
  "POST /works/:workId/assign": "work.assign",
  "POST /works/:workId/progress": "work.record_progress",
  "POST /works/:workId/complete": "work.complete",
  "POST /works/:workId/cancel": "work.cancel",
  "POST /decisions": "decision.create",
  "PATCH /decisions/:decisionId": "decision.edit_draft",
  "POST /decisions/:decisionId/submit": "decision.submit",
  "POST /decisions/:decisionId/approve": "decision.approve",
  "POST /decisions/:decisionId/reject": "decision.reject",
  "POST /decisions/:decisionId/withdraw": "decision.withdraw",
  "POST /decisions/:decisionId/revisions": "decision.start_revision",
  "POST /decisions/:decisionId/assistance": "decision.record_secretary_contribution",
  "PATCH /memories/:memoryId": "memory.edit_generated",
  "POST /memories/:memoryId/submit": "memory.submit",
  "POST /memories/:memoryId/approve": "memory.approve",
  "POST /memories/:memoryId/reject": "memory.reject",
  "POST /memories/:memoryId/reopen": "memory.reopen",
  "POST /notifications/:notificationId/acknowledge": "notification.acknowledge",
  "PATCH /organizations/:organizationId": "organization.rename",
  "POST /organizations/:organizationId/assistance-grants": "organization.grant_assistance",
  "POST /organizations/:organizationId/assistance-grants/revoke":
    "organization.revoke_assistance",
  "POST /organizations/:organizationId/suspend": "organization.suspend",
  "POST /organizations/:organizationId/reactivate": "organization.reactivate",
  "POST /organizations/:organizationId/archive": "organization.archive",
  "POST /organizations/:organizationId/members": "organization.invite_member",
  "POST /organizations/:organizationId/members/:membershipId/resend-invitation":
    "organization.resend_invitation",
  "POST /organizations/:organizationId/members/:membershipId/revoke-invitation":
    "organization.revoke_invitation",
  "POST /organizations/:organizationId/members/:membershipId/suspend":
    "organization.suspend_member",
  "POST /organizations/:organizationId/members/:membershipId/reactivate":
    "organization.reactivate_member",
  "POST /organizations/:organizationId/members/:membershipId/revoke":
    "organization.revoke_member",
  "POST /organizations/:organizationId/members/:membershipId/assign-role":
    "organization.assign_role",
  "POST /organizations/:organizationId/members/:membershipId/revoke-role":
    "organization.revoke_role",
  "POST /admin/events/:eventId/retry": "events.retry",
  "POST /admin/events/dead-letters/:deadLetterId/skip": "events.skip",
  "POST /admin/events/dead-letters/:deadLetterId/reprocess":
    "events.replay_domain_consumer",
  "POST /admin/events/replay/projection": "events.replay_projection",
  "POST /admin/workers/:workerType/pause": "operations.pause_worker",
  "POST /admin/workers/:workerType/resume": "operations.resume_worker",
  // Privileged operational *reads* (ADR-0022). Ordinary reads are not audited —
  // "a row per list request would bury the ones that matter" — but the
  // architecture requires the operational surface to "audit privileged or
  // cross-Organization access", and an operational read of an Organization's
  // failures is a privileged access whether or not it changes anything.
  "GET /admin/workflow-health": "operations.read_workflow_health",
  "GET /admin/events/failed": "events.inspect_failed",
};

/**
 * Permission families whose reads are audited.
 *
 * The distinction the interceptor needs, kept here beside the map it applies to.
 * `notification.read` is not in it; `events.inspect_failed` is.
 */
const AUDITED_READ_FAMILIES = ["events.", "operations."];

/** Whether this route's read should leave an audit row. */
export const isAuditedRead = (method: string, path: string): boolean => {
  if (method !== "GET") return false;
  const permission = permissionFor(method, path);
  return (
    permission !== null &&
    AUDITED_READ_FAMILIES.some((family) => permission.startsWith(family))
  );
};

export const permissionFor = (method: string, path: string): string | null =>
  ROUTES[`${method} ${path}`] ?? null;

/** Exposed so the drift check can compare this to ADR-0014. */
export const auditedRoutes = ROUTES;

/**
 * What the request acted on.
 *
 * Taken from the route parameters, and from the response only for a `status` and
 * `version` the handler reported. Never from the request body: a caller must not
 * be able to write their own audit row.
 */
export const resourceOf = (
  request: Request,
  body: unknown,
): {
  type: string | null;
  id: string | null;
  previousState: string | null;
  nextState: string | null;
} => {
  const params = request.params as Record<string, string | undefined>;

  const [type, id] =
    params["workId"] !== undefined
      ? ["Work", params["workId"]]
      : params["decisionId"] !== undefined
        ? ["Decision", params["decisionId"]]
        : params["memoryId"] !== undefined
          ? ["Memory", params["memoryId"]]
          : params["membershipId"] !== undefined
            ? ["Membership", params["membershipId"]]
            : params["notificationId"] !== undefined
              ? ["Notification", params["notificationId"]]
              : params["deadLetterId"] !== undefined
                ? ["DeadLetter", params["deadLetterId"]]
                : params["eventId"] !== undefined
                  ? ["OutboxMessage", params["eventId"]]
                  : params["organizationId"] !== undefined
                    ? ["Organization", params["organizationId"]]
                    : params["workerType"] !== undefined
                      ? ["Worker", params["workerType"]]
                      : [null, null];

  const status =
    typeof body === "object" && body !== null && "status" in body
      ? String((body as { status: unknown }).status)
      : null;

  return {
    type,
    // A creation has no path parameter, so the identifier comes from what the
    // handler returned — the only case where the response names the resource.
    id: id ?? identifierIn(body),
    // Not observable at the edge: the interceptor sees the request and the
    // response, never the row the handler read. The use case knows both states
    // and records the transition itself — see `recordTransition`.
    previousState: null,
    nextState: status,
  };
};

const identifierIn = (body: unknown): string | null => {
  if (typeof body !== "object" || body === null) return null;
  for (const key of ["workId", "decisionId", "memoryId", "organizationId"]) {
    if (key in body) return String((body as Record<string, unknown>)[key]);
  }
  return null;
};

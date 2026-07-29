/**
 * Operational recovery through the Application Layer.
 *
 * The rules being asserted are the authorization document's, not ordinary CRUD
 * ones: recovery is Organization business authority rather than infrastructure
 * access, the source event decides the Organization, and the request cannot
 * name another. The HTTP suite proves the same properties against PostgreSQL;
 * these prove they hold in the layer that owns them, without a database.
 */

import { describe, expect, it } from "vitest";

import {
  IdentityId,
  MembershipId,
  OrganizationId,
  type HumanMemberPrincipal,
  type Role,
} from "@aios/types";

import { AuthorizationError } from "./authorization.js";
import {
  listFailedEventsUseCase,
  retryFailedEventUseCase,
} from "./event-recovery-use-cases.js";
import { NotFoundError, type FailedEventSummary } from "./ports.js";
import { buildTestHarness } from "./testing/in-memory.js";

const ORG = OrganizationId("org-1");
const OTHER_ORG = OrganizationId("org-2");
const NOW = new Date("2026-07-28T10:00:00Z");

const ctx = (roles: Role[] = ["OrganizationOwner"], organizationId = ORG) => ({
  principal: {
    type: "HumanMember",
    identityId: IdentityId("identity-1"),
    membershipId: MembershipId("membership-1"),
    organizationId,
    roles,
  } satisfies HumanMemberPrincipal,
  organizationId,
  now: NOW,
});

const failure = (eventId: string, attemptCount = 5): FailedEventSummary => ({
  eventId,
  eventType: "WorkCreated",
  aggregateType: "Work",
  aggregateId: "work-1",
  aggregateVersion: 1,
  attemptCount,
  lastErrorCode: "CONSUMER_TIMEOUT",
  occurredAt: NOW,
  lastAttemptAt: NOW,
});

describe("failed event inspection", () => {
  it("lists only the acting Organization's failures", async () => {
    const h = buildTestHarness(NOW);
    h.eventRecovery.seedFailed(ORG, failure("event-mine"));
    h.eventRecovery.seedFailed(OTHER_ORG, failure("event-theirs"));

    const listed = await listFailedEventsUseCase(h.deps, ctx());

    expect(listed.map((e) => e.eventId)).toEqual(["event-mine"]);
  });

  it("refuses a Member", async () => {
    const h = buildTestHarness(NOW);
    await expect(
      listFailedEventsUseCase(h.deps, ctx(["Member"])),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe("failed event retry", () => {
  it("returns the delivery to the queue with its attempt count intact", async () => {
    const h = buildTestHarness(NOW);
    h.eventRecovery.seedFailed(ORG, failure("event-1", 5));

    await retryFailedEventUseCase(h.deps, ctx(), "event-1");

    expect(h.eventRecovery.statusOf("event-1")).toEqual({
      status: "Pending",
      attemptCount: 5,
    });
  });

  it("cannot reach another Organization's failed event", async () => {
    const h = buildTestHarness(NOW);
    h.eventRecovery.seedFailed(OTHER_ORG, failure("event-theirs"));

    // 404 rather than 403: the response must not confirm that the event exists
    // somewhere else.
    await expect(
      retryFailedEventUseCase(h.deps, ctx(), "event-theirs"),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(h.eventRecovery.statusOf("event-theirs")).toMatchObject({
      status: "Failed",
    });
  });

  it("refuses an event that is not Failed", async () => {
    const h = buildTestHarness(NOW);
    h.eventRecovery.seedFailed(ORG, failure("event-1"));
    await retryFailedEventUseCase(h.deps, ctx(), "event-1");

    await expect(
      retryFailedEventUseCase(h.deps, ctx(), "event-1"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses a Member", async () => {
    const h = buildTestHarness(NOW);
    h.eventRecovery.seedFailed(ORG, failure("event-1"));

    await expect(
      retryFailedEventUseCase(h.deps, ctx(["Member"]), "event-1"),
    ).rejects.toBeInstanceOf(AuthorizationError);
    // The permission check runs before the repository, so a denied request
    // leaves no trace on the row.
    expect(h.eventRecovery.statusOf("event-1")).toMatchObject({
      status: "Failed",
    });
  });
});

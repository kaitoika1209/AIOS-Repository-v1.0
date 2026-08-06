/**
 * Which process drains the Outbox.
 *
 * The observability baseline requires a separate Worker with its own liveness
 * and readiness, so an API process in production must not also be draining. The
 * choice is a pure function of the environment precisely so it can be asserted
 * here rather than discovered by watching which process does the work.
 */

import { describe, expect, it } from "vitest";

import { chooseWorkerMode } from "./app.js";
import {
  isDrainWorthLogging,
  type DrainResult,
} from "./outbox-worker.js";

describe("choosing where the Outbox worker runs", () => {
  it("runs in-process in development, where one process is the point", () => {
    expect(chooseWorkerMode({ NODE_ENV: "development" }).inProcess).toBe(true);
    expect(chooseWorkerMode({}).inProcess).toBe(true);
  });

  it("runs in-process under test, so a suite needs no second process", () => {
    expect(chooseWorkerMode({ NODE_ENV: "test" }).inProcess).toBe(true);
  });

  it("leaves the draining to a separate process in production", () => {
    // Not because in-process is unsafe — `FOR UPDATE SKIP LOCKED` and the
    // per-consumer delivery claim make concurrent drains correct — but because
    // it ties generation throughput to API replica count and leaves no worker to
    // pause independently.
    const chosen = chooseWorkerMode({ NODE_ENV: "production" });
    expect(chosen.inProcess).toBe(false);
    // The reason says what to run instead. An operator who deploys the API and
    // wonders why Memory never appears should not have to read the source.
    expect(chosen.reason).toContain("worker");
  });

  it("lets an explicit setting override the environment, in both directions", () => {
    expect(
      chooseWorkerMode({ NODE_ENV: "production", WORKER_IN_PROCESS: "true" }).inProcess,
    ).toBe(true);
    expect(
      chooseWorkerMode({ NODE_ENV: "development", WORKER_IN_PROCESS: "false" }).inProcess,
    ).toBe(false);
  });

  it("names the reason for every choice", () => {
    for (const env of [
      {},
      { NODE_ENV: "production" },
      { WORKER_IN_PROCESS: "true" },
      { WORKER_IN_PROCESS: "false" },
    ]) {
      expect(chooseWorkerMode(env).reason.length).toBeGreaterThan(0);
    }
  });
});

describe("whether a drain says it happened", () => {
  const drain = (over: Partial<DrainResult> = {}): DrainResult => ({
    claimed: 0,
    applied: 0,
    alreadyApplied: 0,
    failed: 0,
    notified: 0,
    ...over,
  });

  it("records a drain that claimed messages even when every consumer produced nothing", () => {
    // The regression this exists for. The condition was `applied || failed ||
    // notified`, and a staging rehearsal drained 120 messages through two
    // Workers leaving no record of any of them: each event reached the
    // `notifications` consumer, which correctly produced nothing because a
    // Member who assigns Work to themselves is not notified about it.
    //
    // A Worker publishing at full rate looked exactly like a Worker that had
    // stopped — runbook 3's premise arriving through the evidence an operator
    // uses to disprove it.
    expect(isDrainWorthLogging(drain({ claimed: 20 }))).toBe(true);
  });

  it("says nothing about an empty drain", () => {
    // The loop polls every 500ms. An idle queue is the ordinary case, and a
    // record per poll would bury the ones that matter.
    expect(isDrainWorthLogging(drain())).toBe(false);
  });

  it("records a failure even when nothing was claimed", () => {
    expect(isDrainWorthLogging(drain({ failed: 1 }))).toBe(true);
  });
});

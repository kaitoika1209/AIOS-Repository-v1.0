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

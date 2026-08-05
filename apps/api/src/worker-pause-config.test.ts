/**
 * The deployment-scoped pause (ADR-0022).
 *
 * Small, and worth testing anyway: it is the control an operator reaches for
 * when the Worker itself is defective, and its failure mode is silent. A typo
 * that pauses nothing leaves someone believing they contained an incident.
 */

import { describe, expect, it } from "vitest";

import { readDeploymentPause } from "./worker-pause-config.js";

describe("reading WORKER_PAUSED_TYPES", () => {
  it("pauses nothing when unset", () => {
    const result = readDeploymentPause({});
    expect(result.paused.size).toBe(0);
    expect(result.reason).toBe("no deployment pause");
  });

  it("pauses nothing when set to an empty string", () => {
    expect(readDeploymentPause({ WORKER_PAUSED_TYPES: "" }).paused.size).toBe(0);
  });

  it("reads a list, tolerating whitespace", () => {
    const result = readDeploymentPause({
      WORKER_PAUSED_TYPES: " MemoryGeneration , OutboxPublication ",
    });
    expect([...result.paused].sort()).toEqual(["MemoryGeneration", "OutboxPublication"]);
  });

  it("reports a name that pauses nothing rather than ignoring it", () => {
    const result = readDeploymentPause({ WORKER_PAUSED_TYPES: "MemoryGenerator" });

    // The near-miss spelling is the realistic typo, and the one an operator
    // would be least likely to notice.
    expect(result.paused.size).toBe(0);
    expect(result.unrecognised).toEqual(["MemoryGenerator"]);
    expect(result.reason).toContain("named nothing pausable");
  });

  it("keeps the names it understood alongside the ones it did not", () => {
    const result = readDeploymentPause({
      WORKER_PAUSED_TYPES: "MemoryGeneration,DeadLetter",
    });

    // `DeadLetter` is a workflow type with no claim loop, so it pauses nothing —
    // but `MemoryGeneration` must still take effect. Refusing the whole list
    // would turn a partly-wrong control into no control.
    expect([...result.paused]).toEqual(["MemoryGeneration"]);
    expect(result.unrecognised).toEqual(["DeadLetter"]);
  });
});

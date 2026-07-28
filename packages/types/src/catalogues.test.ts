/**
 * Drift tests.
 *
 * The documents are authoritative; this package is a projection of them. These
 * tests parse the documents and fail when the two disagree, so a document edit
 * that is not mirrored in code (or vice versa) breaks the build instead of
 * silently producing a wrong permission check.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { PERMISSIONS, ROLES } from "./authorization.js";
import {
  DECISION_STATUSES,
  GENERATION_OPERATION_STATUSES,
  MEMORY_STATUSES,
  MEMBERSHIP_STATUSES,
  ORGANIZATION_STATUSES,
  WORK_STATUSES,
} from "./statuses.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (relative: string) =>
  readFileSync(resolve(repoRoot, relative), "utf8");

/** Extract the `State` column of a state-machine "State Summary" table. */
const statesFromSummary = (markdown: string): string[] => {
  const rows = markdown.matchAll(/^\|\s*`(\w+)`\s*\|/gm);
  return [...new Set([...rows].map((m) => m[1]!))];
};

describe("permission catalogue", () => {
  const authorization = read("docs/architecture/authorization.md");

  it("matches docs/architecture/authorization.md", () => {
    const documented = new Set(
      [...authorization.matchAll(/`((?:work|decision|memory|events)\.[a-z_]+)`/g)].map(
        (m) => m[1]!,
      ),
    );
    expect([...documented].sort()).toEqual([...PERMISSIONS].sort());
  });

  it("matches the ADR-0014 route table one-to-one", () => {
    const adr = read(
      "docs/adr/0014-adopt-rest-with-explicit-command-sub-resources.md",
    );
    const routed = [
      ...adr.matchAll(/\|\s*`((?:work|decision|memory|events)\.[a-z_]+)`\s*\|/g),
    ].map((m) => m[1]!);
    expect(routed.sort()).toEqual([...PERMISSIONS].sort());
  });

  it("has no duplicates", () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
  });
});

describe("role catalogue", () => {
  it("matches docs/architecture/authorization.md", () => {
    const authorization = read("docs/architecture/authorization.md");
    const block = authorization.match(
      /## Organization Roles[\s\S]*?```text\n([\s\S]*?)```/,
    );
    expect(block).not.toBeNull();
    const documented = block![1]!.split("\n").map((l) => l.trim()).filter(Boolean);
    expect(documented.sort()).toEqual([...ROLES].sort());
  });
});

describe("state machines", () => {
  it.each([
    ["work", "docs/architecture/state-machines/work.md", WORK_STATUSES],
    ["decision", "docs/architecture/state-machines/decision.md", DECISION_STATUSES],
  ])("%s statuses match the State Summary table", (_name, path, expected) => {
    const documented = statesFromSummary(read(path));
    expect(documented.sort()).toEqual([...expected].sort());
  });

  it("memory review statuses match the State Summary table", () => {
    const markdown = read("docs/architecture/state-machines/memory.md");
    const summary = markdown.slice(
      markdown.indexOf("## State Summary"),
      markdown.indexOf("## Lifecycle"),
    );
    expect(statesFromSummary(summary).sort()).toEqual([...MEMORY_STATUSES].sort());
  });

  it("keeps generation-operation statuses separate from MemoryStatus", () => {
    // The state machine requires these never share one enum, even though
    // `Generated` appears in both.
    expect(GENERATION_OPERATION_STATUSES).toContain("Generated");
    expect(MEMORY_STATUSES).toContain("Generated");
    expect(GENERATION_OPERATION_STATUSES).not.toEqual(MEMORY_STATUSES);
    expect(GENERATION_OPERATION_STATUSES).toContain("Abandoned");
    expect(MEMORY_STATUSES as readonly string[]).not.toContain("Abandoned");
  });
});

describe("identity statuses", () => {
  const identity = read("docs/architecture/identity-and-organization.md");

  const documentedBlock = (heading: string): string[] => {
    const section = identity.slice(identity.indexOf(heading));
    const block = section.match(/```text\n([\s\S]*?)```/);
    return block![1]!.split("\n").map((l) => l.trim()).filter(Boolean);
  };

  it("organization statuses match", () => {
    expect(documentedBlock("## Organization Status").sort()).toEqual(
      [...ORGANIZATION_STATUSES].sort(),
    );
  });

  it("membership statuses match", () => {
    expect(documentedBlock("## Membership Status").sort()).toEqual(
      [...MEMBERSHIP_STATUSES].sort(),
    );
  });
});

#!/usr/bin/env python3
"""Verify that the authorization audit records what it claims to record.

The audit has two halves, and each can fail silently in its own way.

**The edge** records that a command was allowed or denied. Its `permission`
column comes from `apps/api/src/route-registry.ts`, which maps an Express route
pattern to a permission identifier. ADR-0014 says "The `operation` value
recorded for observability is the permission identifier ... Route and telemetry
cannot drift apart." Nothing enforced that: a renamed route silently falls out
of the map and every row for it records `null`. Check A is that comparison.

**The use case** records what changed, because the edge cannot see it — it holds
the request and the response, never the row the handler read. `mvp.md` requires
previous and next state on every important business transition, and a status
change is what makes one important. A use case that forgets the call still
works, still passes its tests, and quietly records nothing. Check B is that
comparison.

Check B needs to know which commands are transitions, and it does not guess.
Every status guard in the domain is written the same way — `requireStatus` in
Work, Decision, and Memory, and a direct `InvalidTransitionError` in Membership
and Organization — and each names the command it guards. Those call sites are
enumerated from source, then partitioned by the two lists below:

- `TRANSITIONS` — the command changes the Aggregate's status.
- `STATUS_PRECONDITION_ONLY` — the command requires a status but leaves it
  alone. Editing a Draft is the shape: valid only from `Draft`, and still
  `Draft` afterwards.

A guard in neither list fails the check. That is the part that makes this hold
over time: a new status-changing command *must* guard its status, because that
is how an Aggregate refuses an invalid transition, so it cannot be added without
landing here and being classified.

    python3 scripts/check_audit.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

ROUTE_ADR = "docs/adr/0014-adopt-rest-with-explicit-command-sub-resources.md"
REGISTRY = "apps/api/src/route-registry.ts"
DOMAIN = "packages/domain/src"
APPLICATION = "packages/application/src"

# `| `work.start` | `POST /works/{workId}/start` |`
ROUTE_ROW = re.compile(r"^\| `([a-z_]+\.[a-z_]+)` \| `([A-Z]+) ([^`]+)` \|", re.MULTILINE)

# `{workId}` in the ADR is `:workId` in an Express route pattern.
PATH_PARAMETER = re.compile(r"\{(\w+)\}")

# `"POST /works/:workId/start": "work.start",` — the value may wrap onto its own
# line when the key is long, so the newline is optional.
REGISTRY_ROW = re.compile(r'"([A-Z]+ [^"]+)":\s*\n?\s*"([a-z_]+\.[a-z_]+)"')

# The two status-guard forms. Both name the command in the same position.
GUARD_REQUIRE_STATUS = re.compile(r'requireStatus\(\s*\w+,\s*"([^"]+)"')
GUARD_INVALID_TRANSITION = re.compile(
    r'new InvalidTransitionError\(\s*"[A-Za-z]+",\s*[\w.]+,\s*"([^"]+)"'
)

# Any string literal passed to a transition-recording call. `recordTransition`
# takes named fields and the per-Aggregate helpers take positionals, so rather
# than parse either shape, collect every literal in the call and ask whether the
# command's label is among them. A helper passes both its permission and its
# command name, and either identifies the transition.
AUDIT_CALL = re.compile(
    r"(?:recordTransition|audit\w+Transition)\(", re.MULTILINE
)

# Commands that change their Aggregate's status. Each must record the
# transition; the edge cannot, because it never sees the previous state.
TRANSITIONS = {
    "work.start",
    "work.request_decision",
    "work.record_decision_outcome",
    "work.complete",
    "work.cancel",
    "decision.submit",
    "decision.approve",
    "decision.reject",
    "decision.withdraw",
    "decision.start_revision",
    "memory.submit",
    "memory.approve",
    "memory.reject",
    "memory.reopen",
    "RevokeInvitation",
    "SuspendOrganization",
    "ReactivateOrganization",
    "ArchiveOrganization",
    "SuspendMembership",
    "ReactivateMembership",
    "RevokeMembership",
}

# Guards that read the status without changing it. Listed rather than inferred,
# so that reclassifying one is a reviewed edit.
STATUS_PRECONDITION_ONLY = {
    # Editing content is valid only while the Aggregate is still editable, and
    # leaves it exactly as editable as it was.
    "work.edit": "edits Work content; status unchanged",
    "decision.edit_draft": "edits the Draft revision; status unchanged",
    "memory.edit_generated": "edits the generated draft; status unchanged",
    "organization.rename": "renames an Active Organization; status unchanged",
    # Assignment and progress are about who and what, not about lifecycle.
    "work.assign": "changes participants; Work stays in a non-terminal status",
    "work.record_progress": "appends a progress record; status unchanged",
    # Documented in the Aggregate as explicitly not a transition: "resending
    # must not create a second Membership, and it is not a lifecycle transition".
    "ResendInvitation": "supersedes the token; Membership stays Invited",
    # Roles change what a Member may do, not whether they are one: "role removal
    # does not silently revoke Membership", and assignment requires an already
    # Active one.
    "AssignOrganizationRole": "grants a role; Membership stays Active",
}

# Permissions that are routed but must not appear in the registry, because the
# registry is keyed by route and another permission already owns theirs.
#
# ADR-0007's atomic activation puts two commands in one transaction, so
# `POST /decisions/{decisionId}/submit` carries both `decision.submit` and
# `work.request_decision`. The edge sees one request and records one row, under
# the route's own command; the Work half is recorded separately by the use case,
# which is the only place that knows the Work's previous status anyway.
SHARES_A_ROUTE = {
    "work.request_decision": "decision.submit",
}

# Permission families whose *reads* are audited, mirroring
# `AUDITED_READ_FAMILIES` in the route registry. Kept as a tuple because
# `str.startswith` takes one.
AUDITED_READ_FAMILIES = ("events.", "operations.")

# Transitions whose guard is not one of the two standard forms, so the scan
# cannot find them. Each is listed with the guard it uses instead, and each is
# still required to record its transition.
UNGUARDED_TRANSITIONS = {
    # Refuses with `InvitationNotAcceptableError`, which deliberately reports one
    # identical message for every cause so a caller cannot enumerate tokens.
    "AcceptInvitation": "InvitationNotAcceptableError",
}


def read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


def guarded_commands() -> dict[str, str]:
    """Every status guard in the domain, mapped to the file that declares it."""
    found: dict[str, str] = {}
    for path in sorted((ROOT / DOMAIN).rglob("*.ts")):
        if path.name.endswith(".test.ts"):
            continue
        text = path.read_text(encoding="utf-8")
        for command in GUARD_REQUIRE_STATUS.findall(text):
            found[command] = path.name
        for command in GUARD_INVALID_TRANSITION.findall(text):
            # `requireStatus` itself throws with a `command` variable, not a
            # literal, so its own body never matches. Guard against a future
            # helper that would.
            found[command] = path.name
    return found


def audited_commands() -> set[str]:
    """Every label passed to a transition-recording call in the application."""
    found: set[str] = set()
    for path in sorted((ROOT / APPLICATION).rglob("*.ts")):
        if path.name.endswith(".test.ts") or path.name == "audit.ts":
            continue
        text = path.read_text(encoding="utf-8")
        for match in AUDIT_CALL.finditer(text):
            found |= set(re.findall(r'"([^"]+)"', argument_text(text, match.end())))
    return found


def argument_text(text: str, start: int) -> str:
    """The source between a call's opening parenthesis and its match."""
    depth = 1
    index = start
    while index < len(text) and depth > 0:
        if text[index] in "({[":
            depth += 1
        elif text[index] in ")}]":
            depth -= 1
        index += 1
    return text[start : index - 1]


def check_routes(failures: list[str]) -> None:
    routed = {
        permission: (method, path)
        for permission, method, path in ROUTE_ROW.findall(read(ROUTE_ADR))
    }
    registered = {
        permission: route for route, permission in REGISTRY_ROW.findall(read(REGISTRY))
    }

    for permission, (method, path) in sorted(routed.items()):
        # `{workId}` in the ADR is `:workId` in Express.
        pattern = PATH_PARAMETER.sub(r":\1", path)
        expected = f"{method} {pattern}"

        if method == "GET":
            # Privileged operational reads are audited (ADR-0022): the
            # architecture requires the operational surface to "audit privileged
            # or cross-Organization access". Ordinary reads are not — a row per
            # list request would bury the ones that matter — so a GET outside
            # those families must not appear, and one inside them must.
            privileged = permission.startswith(AUDITED_READ_FAMILIES)

            if privileged and permission not in registered:
                failures.append(
                    f"{permission!r} is a privileged operational read routed as "
                    f"{expected!r} (ADR-0014) but has no entry in {REGISTRY}, so "
                    f"the interceptor skips it and it leaves no audit row"
                )
            elif privileged and registered[permission] != expected:
                failures.append(
                    f"{permission!r} is routed as {expected!r} (ADR-0014) but "
                    f"{REGISTRY} maps it from {registered[permission]!r} — a "
                    f"pattern that does not match is never looked up"
                )
            elif not privileged and permission in registered:
                failures.append(
                    f"{permission!r} is an ordinary GET route but appears in "
                    f"{REGISTRY} — only privileged operational reads are audited"
                )
            continue

        if permission in SHARES_A_ROUTE:
            owner = SHARES_A_ROUTE[permission]
            # The route belongs to the other permission, and the audit records
            # it under that one. An entry here would overwrite the owner's.
            if permission in registered:
                failures.append(
                    f"{permission!r} shares {expected!r} with {owner!r} but has "
                    f"its own entry in {REGISTRY} — one route records one "
                    f"permission at the edge"
                )
            if registered.get(owner) != expected:
                failures.append(
                    f"{permission!r} is recorded as sharing {expected!r} with "
                    f"{owner!r}, but {REGISTRY} does not map that route to "
                    f"{owner!r} — the sharing arrangement is stale"
                )
            continue

        if permission not in registered:
            failures.append(
                f"{permission!r} is routed as {expected!r} (ADR-0014) but has no "
                f"entry in {REGISTRY}, so its audit rows record permission=null"
            )
        elif registered[permission] != expected:
            failures.append(
                f"{permission!r} is routed as {expected!r} (ADR-0014) but "
                f"{REGISTRY} maps it from {registered[permission]!r} — a pattern "
                f"that does not match is never looked up"
            )

    for permission, route in sorted(registered.items()):
        if permission not in routed:
            failures.append(
                f"{REGISTRY} maps {route!r} to {permission!r}, which ADR-0014 "
                f"does not route"
            )


def check_transitions(failures: list[str]) -> None:
    guarded = guarded_commands()
    audited = audited_commands()

    for command, source in sorted(guarded.items()):
        if command in STATUS_PRECONDITION_ONLY:
            if command in TRANSITIONS:
                failures.append(
                    f"{command!r} is listed both as a transition and as "
                    f"precondition-only — it cannot be both"
                )
            continue
        if command not in TRANSITIONS:
            failures.append(
                f"{command!r} guards a status in {source} but is classified "
                f"neither as a transition nor as precondition-only in "
                f"{Path(__file__).name} — decide which it is"
            )

    for command in sorted(TRANSITIONS):
        if command not in guarded and command not in UNGUARDED_TRANSITIONS:
            failures.append(
                f"{command!r} is listed as a transition but no domain command "
                f"guards its status — the command is gone or was renamed"
            )

    for command in sorted(TRANSITIONS | set(UNGUARDED_TRANSITIONS)):
        if command not in audited:
            failures.append(
                f"{command!r} changes its Aggregate's status but no use case "
                f"records the transition — the audit will hold no previous or "
                f"next state for it (mvp.md)"
            )


def main() -> int:
    for relative in (ROUTE_ADR, REGISTRY):
        if not (ROOT / relative).exists():
            print(f"{relative} not found", file=sys.stderr)
            return 1

    failures: list[str] = []
    check_routes(failures)
    check_transitions(failures)

    if failures:
        print(f"Audit checks FAILED ({len(failures)} problem(s)):\n")
        for failure in failures:
            print(f"  - {failure}")
        return 1

    transitions = len(TRANSITIONS) + len(UNGUARDED_TRANSITIONS)
    print(
        f"Audit checks passed "
        f"({len(REGISTRY_ROW.findall(read(REGISTRY)))} audited routes match "
        f"ADR-0014, {transitions} status transitions recorded, "
        f"{len(STATUS_PRECONDITION_ONLY)} status guards classified as "
        f"non-transitions)."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

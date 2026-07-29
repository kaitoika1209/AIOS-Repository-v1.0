#!/usr/bin/env python3
"""Verify that every routed permission is actually enforced in code.

`scripts/check_docs.py` proves the ADR-0014 route catalogue and the
authorization catalogue agree with each other. Both are documents. Nothing
proved either agrees with the code, so "which routes are still missing?" had to
be answered by reading — and was answered wrongly more than once.

A permission counts as enforced when some use case calls
`requirePermission(ctx, "<permission>")`. That is the single choke point the
authorization document requires: services ask for a permission, never inspect a
role, so a permission with no such call is a route nobody is guarding.

Permissions that are routed but deliberately not built yet are listed in
`UNIMPLEMENTED` below. The list is the point: a gap has to be written down and
reviewed rather than discovered later by counting. Implementing one means
deleting its line, and this script fails if you forget.

    python3 scripts/check_routes.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

ROUTE_ADR = "docs/adr/0014-adopt-rest-with-explicit-command-sub-resources.md"

# Where use cases live. The check deliberately ignores `authorization.ts`, which
# names every permission in its role map — searching for a bare string there
# would report full coverage while nothing was enforced.
SOURCE_ROOTS = ["packages/application/src", "apps/api/src"]

ROUTE_ROW = re.compile(r"^\| `([a-z_]+\.[a-z_]+)` \| `([^`]+)` \|", re.MULTILINE)
ENFORCED = re.compile(r'requirePermission\(\s*[^,]+,\s*"([a-z_]+\.[a-z_]+)"')

# Routed, documented, and not yet built. Each entry is a promise, not an excuse:
# it appears in ADR-0014's catalogue, so the route is specified and the
# permission is granted to roles — there is simply no handler yet.
UNIMPLEMENTED: dict[str, str] = {
    # The three recovery operations that assert something about the original
    # delivery. Each needs a registered ConsumerRegistration to decide whether
    # the assertion is safe for a given consumer, and consumer registration is
    # not in this release. RetryOriginal asserts nothing, which is why
    # `events.retry` ships and these do not.
    "events.skip": "needs a registered ConsumerRegistration policy",
    "events.replay_domain_consumer": "needs a registered ConsumerRegistration policy",
    "events.replay_projection": "needs a registered ConsumerRegistration policy",
}


def enforced_permissions() -> set[str]:
    found: set[str] = set()
    for root in SOURCE_ROOTS:
        for path in (ROOT / root).rglob("*.ts"):
            if path.name.endswith(".test.ts"):
                continue
            found |= set(ENFORCED.findall(path.read_text(encoding="utf-8")))
    return found


def main() -> int:
    adr = ROOT / ROUTE_ADR
    if not adr.exists():
        print(f"{ROUTE_ADR} not found", file=sys.stderr)
        return 1

    routed = dict(ROUTE_ROW.findall(adr.read_text(encoding="utf-8")))
    enforced = enforced_permissions()
    failures: list[str] = []

    for permission, route in sorted(routed.items()):
        if permission in enforced:
            if permission in UNIMPLEMENTED:
                failures.append(
                    f"{permission!r} is enforced but still listed as unimplemented "
                    f"in {Path(__file__).name} — delete the line"
                )
            continue
        if permission not in UNIMPLEMENTED:
            failures.append(
                f"{permission!r} is routed as {route!r} but no use case calls "
                f"requirePermission for it (ADR-0014)"
            )

    # A stale entry names a permission that is no longer routed at all.
    for permission in sorted(set(UNIMPLEMENTED) - set(routed)):
        failures.append(
            f"{permission!r} is listed as unimplemented but has no route (ADR-0014)"
        )

    if failures:
        print(f"Route enforcement checks FAILED ({len(failures)} problem(s)):\n")
        for failure in failures:
            print(f"  - {failure}")
        return 1

    implemented = len(routed) - len(UNIMPLEMENTED)
    print(
        f"Route enforcement checks passed "
        f"({implemented}/{len(routed)} routed permissions enforced, "
        f"{len(UNIMPLEMENTED)} recorded as unimplemented)."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Structural checks for the AIOS documentation set.

Enforces the mechanical rules defined in docs/document-governance.md:

  1. every relative Markdown link resolves, and every repository path written as a
     bare code span (`docs/...`) points at a file that exists;
  2. every ADR declares Status, Date, and Blueprint Version, with a valid Status;
  3. every document under docs/architecture/ and docs/product/ declares a scope
     classification header, using only the closed ADR-0010 vocabulary;
  4. each Markdown file has exactly one H1 and no heading-level skips;
  5. paired example headings (Good/Bad, Preferred/Avoid) sit at the same level;
  6. the ADR-0014 route catalogue stays one-to-one with the ADR-0010 permission
     catalogue in authorization.md.

Run from the repository root:

    python3 scripts/check_docs.py

Exits non-zero if any check fails.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Templates legitimately start at H2 and are not part of the doc hierarchy.
HEADING_EXEMPT = {".github/pull_request_template.md"}

# Directories whose documents must declare a scope classification.
SCOPE_REQUIRED_DIRS = ("docs/architecture", "docs/product")
# Product direction, not an architecture artifact: declares a Document class header
# and "MVP implementation authority: None" instead of a scope classification.
SCOPE_EXEMPT = {"docs/product/vision.md"}

VALID_STATUS = re.compile(r"^(Proposed|Accepted|Rejected|Superseded by ADR-\d{4})$")

# ADR-0010 defines exactly four classifications. "Mixed — ..." may contain them.
# Anything else (Deferred, Directional, Blueprint, ...) is prose, not a classification.
VALID_SCOPE = re.compile(
    r"^(MVP Normative|Reserved Extension Point|Future Hypothesis"
    r"|Explicitly Out of Scope|Mixed|Phase \d+ delegates to MVP Normative scope)\b"
)

# Headings that come in pairs and must be siblings.
PAIRED_HEADINGS = {"Good", "Bad", "Preferred", "Avoid"}

failures: list[str] = []


def fail(path: Path, message: str) -> None:
    failures.append(f"{path.relative_to(ROOT)}: {message}")


def markdown_files() -> list[Path]:
    return sorted(
        p for p in ROOT.rglob("*.md") if ".git" not in p.parts and "node_modules" not in p.parts
    )


def headings(text: str) -> list[tuple[int, int, str]]:
    """Return (line_no, level, title), skipping fenced code blocks."""
    out: list[tuple[int, int, str]] = []
    in_fence = False
    for i, line in enumerate(text.split("\n"), 1):
        if line.startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        m = re.match(r"^(#{1,6})\s+(\S.*)$", line)
        if m:
            out.append((i, len(m.group(1)), m.group(2).strip()))
    return out


def check_links(path: Path, text: str) -> None:
    for m in re.finditer(r"\[[^\]]*\]\(([^)]+)\)", text):
        target = m.group(1).strip()
        if target.startswith(("http://", "https://", "mailto:", "#")):
            continue
        target = target.split("#", 1)[0]
        if not target:
            continue
        if not (path.parent / target).exists():
            fail(path, f"broken link -> {target}")


# Repository paths written as `docs/...` code spans. These are not Markdown links, so
# they are invisible to link checking and rot silently when files move.
BARE_PATH = re.compile(r"`((?:docs|scripts|apps|packages|services|infra)/[\w./-]+\.\w+)`")


def check_bare_paths(path: Path, text: str) -> None:
    for m in BARE_PATH.finditer(text):
        target = m.group(1)
        if "*" in target:
            continue
        if not (ROOT / target).exists():
            fail(path, f"bare path reference does not exist -> {target}")


def check_headings(path: Path, text: str) -> None:
    rel = path.relative_to(ROOT).as_posix()
    if rel in HEADING_EXEMPT:
        return
    hs = headings(text)
    if not hs:
        return
    levels = [lv for _, lv, _ in hs]
    if levels.count(1) != 1:
        fail(path, f"expected exactly one H1, found {levels.count(1)}")
    if levels[0] != 1:
        fail(path, "document does not start with an H1")
    for (ln, a, _), (_, b, title) in zip(hs, hs[1:]):
        if b > a + 1:
            fail(path, f"heading level skips H{a} -> H{b} near line {ln} ({title!r})")
            break


def check_adr(path: Path, text: str) -> None:
    head = "\n".join(text.split("\n")[:12])
    for field in ("Status", "Date", "Blueprint Version"):
        if not re.search(rf"^\*\*{field}:\*\*\s+\S", head, re.M):
            fail(path, f"ADR metadata missing required field: {field}")
    m = re.search(r"^\*\*Status:\*\*\s+(.+?)\s*$", head, re.M)
    if m and not VALID_STATUS.match(m.group(1).strip()):
        fail(path, f"invalid ADR Status {m.group(1).strip()!r}")
    m = re.search(r"^\*\*Date:\*\*\s+(.+?)\s*$", head, re.M)
    if m and not re.match(r"^\d{4}-\d{2}-\d{2}$", m.group(1).strip()):
        fail(path, f"Date must be YYYY-MM-DD, got {m.group(1).strip()!r}")


def check_scope(path: Path, text: str) -> None:
    rel = path.relative_to(ROOT).as_posix()
    if rel in SCOPE_EXEMPT or not rel.startswith(SCOPE_REQUIRED_DIRS):
        return
    if rel.endswith("README.md"):
        return
    head = "\n".join(text.split("\n")[:15])
    m = re.search(r"\*\*Scope classification:\*\*\s*(.+?)\s*$", head, re.M)
    if not m:
        fail(path, "missing scope classification header (ADR-0010)")
        return
    value = m.group(1).strip()
    if not VALID_SCOPE.match(value):
        fail(
            path,
            f"scope classification {value!r} is not in the ADR-0010 vocabulary "
            "(MVP Normative | Reserved Extension Point | Future Hypothesis | "
            "Explicitly Out of Scope | Mixed — ...)",
        )


def check_paired_headings(path: Path, text: str) -> None:
    """Good/Bad and Preferred/Avoid must be siblings, not parent and child."""
    parent_level: int | None = None
    pairs: dict[int, list[tuple[str, int]]] = {}
    for ln, level, title in headings(text):
        label = title.strip().rstrip(":")
        if label in PAIRED_HEADINGS:
            if parent_level is not None:
                pairs.setdefault(parent_level, []).append((label, level))
        else:
            parent_level = level
    for group in pairs.values():
        levels = {lv for _, lv in group}
        if len(levels) > 1:
            fail(
                path,
                "paired example headings are at differing levels "
                f"({', '.join(f'{n}=H{lv}' for n, lv in group)}); they must be siblings",
            )
            return


PERMISSION_NAME = re.compile(r"^[a-z_]+\.[a-z_]+$")
ROUTE_ROW = re.compile(r"^\| `([a-z_]+\.[a-z_]+)` \| `([^`]+)` \|", re.MULTILINE)

AUTHZ_DOC = "docs/architecture/authorization.md"
ROUTE_ADR = "docs/adr/0014-adopt-rest-with-explicit-command-sub-resources.md"

# The one route ADR-0014 permits to carry two permissions, under the heading
# "Atomic activation is the one route that carries two permissions".
SHARED_ROUTE = {"decision.submit", "work.request_decision"}

CATALOGUE_HEADING = "## Permission Catalogue"
RESERVED_HEADING = "## Reserved Permissions"


def fenced_block_after(text: str, heading: str) -> set[str] | None:
    """The first fenced block following a heading, as a set of non-empty lines.

    Reading a delimited block rather than scanning for inline code spans is what
    makes the catalogue a *declaration*. Under the old rule, mentioning a
    permission anywhere in prose silently enrolled it, and omitting the backticks
    silently excluded it — so the check could be satisfied by formatting.
    """
    start = text.find(heading)
    if start < 0:
        return None
    fence = text.find("```", start)
    if fence < 0:
        return None
    body_start = text.find("\n", fence) + 1
    end = text.find("```", body_start)
    if end < 0:
        return None
    return {line.strip() for line in text[body_start:end].splitlines() if line.strip()}


def check_route_catalogue() -> None:
    """ADR-0014 requires exactly one route per permission, and vice versa."""
    authz = ROOT / AUTHZ_DOC
    adr = ROOT / ROUTE_ADR
    if not (authz.exists() and adr.exists()):
        return

    authz_text = authz.read_text(encoding="utf-8")
    permissions = fenced_block_after(authz_text, CATALOGUE_HEADING)
    if permissions is None:
        failures.append(f"{AUTHZ_DOC}: no fenced block under {CATALOGUE_HEADING!r}")
        return

    malformed = sorted(p for p in permissions if not PERMISSION_NAME.match(p))
    for name in malformed:
        failures.append(f"{AUTHZ_DOC}: {name!r} is not a permission identifier")
    permissions -= set(malformed)

    # A reserved name must stay reserved. Listing it in both places would leave
    # the reader unable to tell whether it is grantable.
    reserved = fenced_block_after(authz_text, RESERVED_HEADING) or set()
    for name in sorted(permissions & reserved):
        failures.append(f"{AUTHZ_DOC}: {name!r} is both catalogued and reserved")

    rows = ROUTE_ROW.findall(adr.read_text(encoding="utf-8"))
    routed = {permission for permission, _ in rows}

    for missing in sorted(permissions - routed):
        failures.append(f"{ROUTE_ADR}: permission {missing!r} has no route (ADR-0014)")
    for extra in sorted(routed - permissions):
        failures.append(
            f"{ROUTE_ADR}: route for {extra!r} has no permission in {AUTHZ_DOC} (ADR-0014)"
        )
    for name in sorted(routed & reserved):
        failures.append(f"{ROUTE_ADR}: {name!r} is reserved and must not be routed")

    # Two permissions sharing a route would defeat the one-to-one rule from the
    # other direction, which the set comparison above cannot see. ADR-0014 names
    # one exemption, and it is not a routing choice: ADR-0007 requires
    # `Decision.SubmitForReview` and `Work.RequestBlockingDecision` to commit in
    # one transaction, and two routes cannot share one.
    seen: dict[str, str] = {}
    for permission, route in rows:
        if route in seen and {seen[route], permission} != SHARED_ROUTE:
            failures.append(
                f"{ROUTE_ADR}: route {route!r} is claimed by both "
                f"{seen[route]!r} and {permission!r} (ADR-0014)"
            )
        seen[route] = permission


def main() -> int:
    files = markdown_files()
    if not files:
        print("no Markdown files found", file=sys.stderr)
        return 1

    check_route_catalogue()

    for path in files:
        text = path.read_text(encoding="utf-8")
        rel = path.relative_to(ROOT).as_posix()
        check_links(path, text)
        check_bare_paths(path, text)
        check_headings(path, text)
        check_paired_headings(path, text)
        check_scope(path, text)
        if rel.startswith("docs/adr/") and not rel.endswith("README.md"):
            check_adr(path, text)

    if failures:
        print(f"Documentation checks FAILED ({len(failures)} problem(s)):\n", file=sys.stderr)
        for f in failures:
            print(f"  - {f}", file=sys.stderr)
        print(
            "\nSee docs/document-governance.md for the rules these checks enforce.",
            file=sys.stderr,
        )
        return 1

    print(f"Documentation checks passed ({len(files)} files).")
    return 0


if __name__ == "__main__":
    sys.exit(main())

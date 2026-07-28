#!/usr/bin/env python3
"""Structural checks for the AIOS documentation set.

Enforces the mechanical rules defined in docs/document-governance.md:

  1. every relative Markdown link resolves;
  2. every ADR declares Status, Date, and Blueprint Version, with a valid Status;
  3. every document under docs/architecture/ and docs/product/ declares a scope
     classification header;
  4. each Markdown file has exactly one H1 and no heading-level skips.

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
SCOPE_EXEMPT = {"docs/product/vision.md"}  # declares a Directional header instead

VALID_STATUS = re.compile(r"^(Proposed|Accepted|Rejected|Superseded by ADR-\d{4})$")

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
    if not re.search(r"\*\*Scope classification:\*\*", head):
        fail(path, "missing scope classification header (ADR-0010)")


def main() -> int:
    files = markdown_files()
    if not files:
        print("no Markdown files found", file=sys.stderr)
        return 1

    for path in files:
        text = path.read_text(encoding="utf-8")
        rel = path.relative_to(ROOT).as_posix()
        check_links(path, text)
        check_headings(path, text)
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

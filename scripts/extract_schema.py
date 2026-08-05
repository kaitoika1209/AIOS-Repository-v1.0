#!/usr/bin/env python3
"""Extract executable SQL from the persistence architecture document.

`docs/architecture/persistence-and-data-model.md` is the authoritative schema.
This script turns its ```sql blocks into a script that can be applied to a real
PostgreSQL database, so "conceptual DDL" is verified rather than assumed.

Ordering: tables first in dependency order, then indexes and ALTER statements.
Statements referring to tables that have no CREATE TABLE yet are skipped and
reported, since several aggregates are still documented only conceptually.

    python3 scripts/extract_schema.py            # write build/schema.sql
    python3 scripts/extract_schema.py --list     # report coverage only
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Per docs/document-governance.md, persistence owns aggregate tables and
# events-and-outbox owns the Outbox and consumer tables.
DOCS = [
    ROOT / "docs/architecture/persistence-and-data-model.md",
    ROOT / "docs/architecture/events-and-outbox.md",
]

# Dependency order. A table must follow everything its foreign keys reference.
TABLE_ORDER = [
    "human_identities",
    "organizations",
    "authentication_subjects",
    "memberships",
    "membership_role_assignments",
    "organization_invitations",
    "work_items",
    "work_participants",
    "work_progress_records",
    "decisions",
    "decision_revisions",
    "decision_secretary_contributions",
    "secretary_assistance_grants",
    "memories",
    "memory_revisions",
    "memory_generation_operations",
    "notifications",
    "authorization_audit_records",
    "outbox_messages",
    "processed_events",
    "consumer_ordering_state",
    "dead_letter_events",
    "event_replays",
    "worker_pauses",
    "organization_workflow_health",
]

SQL_BLOCK = re.compile(r"```sql\n(.*?)```", re.S)
CREATE_TABLE = re.compile(r"^\s*CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+)", re.M)
STATEMENT = re.compile(r"^\s*(CREATE\s+(?:UNIQUE\s+)?INDEX|ALTER TABLE)", re.M)

# Illustrative placeholders, not real tables.
PLACEHOLDERS = {"aggregate_table", "large_table", "child_table", "parent_table"}


def blocks() -> list[str]:
    out: list[str] = []
    for doc in DOCS:
        out += [b.strip() for b in SQL_BLOCK.findall(doc.read_text(encoding="utf-8"))]
    return out


def collect() -> tuple[dict[str, str], list[tuple[str, str]], set[str]]:
    tables: dict[str, str] = {}
    statements: list[tuple[str, str]] = []
    referenced: set[str] = set()

    for block in blocks():
        created = CREATE_TABLE.search(block)
        if created:
            tables[created.group(1)] = block
            continue
        if not STATEMENT.search(block):
            continue
        target = re.search(r"(?:ON|ALTER TABLE)\s+([a-z_]+)", block)
        if target:
            statements.append((target.group(1), block))

    for block in blocks():
        referenced |= set(re.findall(r"REFERENCES\s+([a-z_]+)", block, re.I))

    return tables, statements, referenced


def build_sql(tables: dict[str, str], statements: list[tuple[str, str]]) -> str:
    known = set(tables)
    ordered = [t for t in TABLE_ORDER if t in known]
    ordered += sorted(known - set(ordered))

    parts = [tables[t].rstrip().rstrip(";") for t in ordered]
    parts += [
        block.rstrip().rstrip(";") for target, block in statements if target in known
    ]
    return ";\n\n".join(parts) + ";\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--list", action="store_true", help="report coverage only")
    parser.add_argument("--out", default="build/schema.sql")
    args = parser.parse_args()

    tables, statements, referenced = collect()
    known = set(tables)
    missing = sorted(referenced - known - PLACEHOLDERS)
    skipped = sorted({t for t, _ in statements if t not in known} - PLACEHOLDERS)

    print(f"Tables with executable DDL ({len(known)}):")
    for t in sorted(known):
        print(f"  - {t}")

    if missing:
        print(f"\nReferenced by a foreign key but documented conceptually only ({len(missing)}):")
        for t in missing:
            print(f"  - {t}")

    if skipped:
        print(f"\nIndexes/constraints skipped, target table not yet defined ({len(skipped)}):")
        for t in skipped:
            print(f"  - {t}")

    if args.list:
        return 0

    out = ROOT / args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(build_sql(tables, statements), encoding="utf-8")
    print(f"\nWrote {out.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

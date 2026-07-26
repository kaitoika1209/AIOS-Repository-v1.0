# Glossary

## Purpose

This glossary defines the official terminology used throughout AIOS.

All documentation, source code, user interfaces, and discussions should use these terms consistently.

---

## Organization

The company, team, or business unit operating within AIOS.

An Organization is the tenant, ownership, authorization, and data-isolation boundary for its Human Members and Organization-owned resources.

---

## Principal

An authenticated or trusted execution identity that may request or perform actions in AIOS.

AIOS recognizes three principal categories:

- Human Member
- AI Principal
- System Principal

Principal type is part of the authorization boundary. A non-Human Principal must never be treated as a Human Member.

---

## Member

A human participant who has a Membership in an Organization.

A Member may receive Organization-scoped roles and permissions and may perform authoritative business actions when authorized.

**Member** is reserved for humans. A Secretary, AI Employee, or System Principal is not a Member and must not hold Human Memberships or Human roles.

AIOS intentionally uses **Member** instead of **User** for a human participant in the domain.

---

## AI Principal

A non-human execution identity that performs governed assistance or explicitly permitted delegated operations.

The Secretary and future AI Employees are AI Principals.

AI Principals do not inherit Human Member permissions and cannot exercise Human-only business authority.

---

## System Principal

A trusted internal execution identity used for technical processing such as event delivery, background work, retries, and reconciliation.

A System Principal may execute an explicitly permitted operational action caused by prior authoritative intent. It cannot create new Human business intent, hold a Human Membership, or exercise Human-only authority.

---

## Work

The central business object of AIOS.

A work item represents a business activity with a clear objective.

Every meaningful activity belongs to a Work.

---

## Decision

A formal human decision made during the lifecycle of work.

AI may propose decisions.

Humans remain responsible for approving them.

---

## Memory

Organizational experience generated from completed work.

A memory records what happened, why it happened, and what was learned.

---

## Knowledge

> **Blueprint status:** Future — outside the MVP.

Reusable organizational guidance that is created separately from historical Memory and explicitly published through Human-authorized review.

Knowledge must be supported by traceable Evidence. In the initial future model, every publishable Knowledge revision references at least one Approved Memory as Evidence.

A Generated, InReview, Rejected, or Approved Memory does not automatically become Knowledge. Memory approval establishes trustworthy history; it does not establish reusable organizational guidance.

---

## Workflow

The process that defines how work progresses through its lifecycle.

Examples include review, approval, and publishing.

---

## Capability

> **Blueprint status:** Future — outside the MVP.

An organizational ability supported by reusable Knowledge and observed performance.

Examples:

- Marketing
- Sales
- Customer Support
- Software Development

Capability must not be inferred from one unreviewed AI output or from one historical Memory alone.

---

## Workspace

The primary working environment for members inside AIOS.

A workspace provides access to work, AI collaboration, and organizational information.

---

## Secretary

The primary advisory AI interface within AIOS.

The Secretary is an AI Principal assigned to one Organization. It helps Human Members organize Work, prioritize activity, and coordinate future AI Employees.

The Secretary is not a Member and cannot perform Human-only authoritative actions.

---

## AI Employee

A future AI Principal assigned a specialized organizational role.

Examples:

- Researcher
- Writer
- Analyst
- Reviewer

AI Employees collaborate with Human Members under explicit authorization and governance. They are not Members, do not hold Human Memberships or Human roles, and cannot exercise Human-only business authority.

---

## Replay

A reconstruction of completed work.

Replay allows organizations to review decisions, actions, and outcomes for learning and improvement.

---

## Organization Brain

The long-term organizational intelligence layer.

It combines memories, knowledge, and capabilities to improve future work.

---

## Evidence

> **Blueprint status:** Future — outside the MVP.

A traceable reference used to support, limit, or contradict a Knowledge revision.

In the initial future model, Evidence includes one or more Approved Memories and every publishable Knowledge revision references at least one Approved Memory.

Evidence represents the organizational experiences upon which a piece of Knowledge is based.

Evidence ensures that every Knowledge record can be traced back to the historical events that justified its creation or subsequent revisions.

Evidence is immutable once associated with a Knowledge revision, preserving auditability and explainability.

A single Memory may support multiple Knowledge records.

A single Knowledge record may be supported by multiple Memories.

---

# Naming Consistency

The following terms should be used consistently throughout AIOS.

| Preferred | Avoid |
|-----------|-------|
| Member | User, Human User |
| AI Principal | AI Member, Non-Human Member |
| System Principal | System Member |
| Work | Task |
| Memory | History |
| Organization | Company |
| AI Employee | Assistant |
| Secretary | Chatbot |
| Knowledge | Documentation |

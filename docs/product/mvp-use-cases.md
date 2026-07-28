# MVP Use Cases

> **Scope classification:** MVP Normative  
> **MVP implementation authority:** Yes, subject to [`docs/product/mvp.md`](mvp.md)  
> **Promotion requirement:** Not applicable

## Purpose

This document defines the primary use case for the AIOS Minimum Viable Product (MVP).

The MVP is intentionally optimized for one representative workflow.

Future use cases should be validated only after this workflow has proven successful.

---

## Primary Use Case

A small product team collaborates with AI to research, discuss, approve, and complete work while automatically capturing organizational experience.

---

## Target Team

The representative team consists of:

- 2–10 members
- One organization
- One shared workspace
- One Secretary

The team works together to plan and deliver business activities.

---

## Scenario

A member creates a new work item.

The Secretary assists by organizing the work, summarizing discussions, and suggesting improvements.

Members collaborate, discuss options, and create decisions when required.

Once the work is completed, AIOS automatically generates an organizational Memory.

The generated Memory is reviewed by a human and, once approved, becomes authoritative
organizational history.

---

## User Journey

### Step 1 — Create Work

A member creates a new Work.

The Work includes:

- Title
- Description
- Assignee
- Priority
- Due date (optional)

---

### Step 2 — Collaborate

Members collaborate inside the Work.

The Secretary assists by:

- Summarizing discussions
- Drafting content
- Identifying action items
- Suggesting improvements

The Secretary provides recommendations but does not make decisions.

---

### Step 3 — Make Decisions

Members create Decisions when approval is required.

A Decision may be:

- Approved
- Rejected

Approved Decisions become part of the Work history.

---

### Step 4 — Complete Work

Once the objective has been achieved, the Work is marked as completed.

Completion records:

- Participants
- Decisions
- Timeline
- AI contributions

---

### Step 5 — Generate Memory

Completing a Work automatically creates a Memory.

The generated Memory contains:

- Summary
- Outcome
- Key decisions
- Lessons learned
- Related Work

Generated Memories remain unreviewed.

---

### Step 6 — Review Memory

A designated member reviews the Memory.

The reviewer may:

- Approve
- Revise
- Reject

Approved Memory is immutable and becomes the organization's authoritative record of the
completed Work. Approved Memory is **not** Knowledge. Promoting Memory into reusable
Knowledge is a separate business process introduced in Phase 4 and is out of scope for
the MVP.

---

## Success Criteria

The MVP is successful if a team can:

- Create Work
- Collaborate with the Secretary
- Record Decisions
- Complete Work
- Generate organizational Memories
- Review and approve those Memories
- Build a growing repository of human-approved organizational experience

---

## Out of Scope

The following are intentionally excluded:

- Knowledge and Knowledge promotion
- Evidence
- Capability
- MemoryRevision after approval
- AI Employees
- Autonomous AI collaboration
- Workflow automation
- External integrations and external knowledge ingestion
- Semantic retrieval
- Marketplace
- Organization Brain
- Advanced governance

See the scope classification table in [`docs/product/mvp.md`](mvp.md) for the
authoritative list.

---

## Guiding Principle

The MVP validates one simple hypothesis:

> Organizations become smarter when everyday work is captured and reviewed into trustworthy organizational Memory.

Whether that Memory can be transformed into reusable Knowledge is a separate hypothesis
that the MVP does not attempt to prove.

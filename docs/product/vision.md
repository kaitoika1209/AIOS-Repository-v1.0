# Product Vision

> **Scope classification:** Directional — not an implementation authority  
> **MVP implementation authority:** None  
> **Promotion requirement:** Vision statements become implementable only through
> [`docs/product/mvp.md`](mvp.md) or a successor release-scope document

## Purpose

This document states why AIOS exists and what it is ultimately trying to change.

It is deliberately directional. It does not authorize implementation, define scope, or
override any authoritative document. See [Document Governance](../document-governance.md).

---

## Why AIOS Exists

Organizations accumulate experience constantly, but almost none of it is retained in a
usable form.

Work is completed in ticket trackers. Decisions are made in meetings and chat threads.
The reasoning behind those decisions lives in the memory of whoever happened to be
present. When those people move teams or leave, the organization does not merely lose
documentation — it loses the ability to explain its own past.

The result is an organization that repeats resolved debates, re-learns known lessons, and
cannot answer *why* it does what it does.

---

## The Problem

Existing work management software optimizes for **throughput**: moving items to done.

That optimization leaves three gaps.

### Decisions are not first-class

Decisions are recorded as comments, if at all. There is no durable record of what was
decided, who held the authority to decide it, what alternatives were considered, or what
the decision was based on.

### Experience is not captured at the moment it exists

The best moment to capture what a piece of work taught the organization is immediately
after that work completes. Almost no tool captures anything at that moment, and asking
people to write retrospectives later reliably fails.

### AI is bolted on rather than governed

AI features are commonly added as an assistant sitting beside the product, with unclear
authority and no audit trail. An organization cannot safely delegate to a system when it
cannot say what that system was permitted to do or what it actually did.

---

## Our Vision

> AIOS is the operating system for organizational intelligence.

AIOS treats **Work**, **Decision**, and **Memory** as first-class business objects rather
than as incidental records. Completed Work produces reviewed organizational Memory, and
that Memory becomes the organization's authoritative account of its own history.

AI participates throughout — but as a governed advisory principal, never as a
decision-maker. AI proposes. Humans decide. Every meaningful action is attributable.

The long-term ambition is that approved experience becomes reusable Knowledge and
measurable organizational Capability. That ambition is a hypothesis to be validated in
later phases, not a present commitment.

---

## Product Principles

### Everything begins with Work

Work is the central business object. Decisions, Memory, participants, and AI
contributions all attach to Work. Nothing meaningful happens outside of it.

### AI proposes, humans decide

AI Principals may summarize, draft, organize, and recommend. They may never approve,
reject, complete Work, grant permissions, or modify approved historical records. Business
authority is held by humans only.

### Every important decision should be explainable

A Decision records its context, alternatives, outcome, reviewer, and time. An
organization should be able to reconstruct its own reasoning without relying on anyone's
recollection.

### Approved history is immutable

Once a human approves a Memory, it becomes a permanent record. History that can be
quietly rewritten cannot be trusted, and untrustworthy history is worse than none.

### Memory is not Knowledge

Memory is what happened. Knowledge is what generalizes. Collapsing the two produces
confident, unvalidated advice. AIOS keeps the boundary explicit — see
[ADR-0002](../adr/0002-memory-vs-knowledge.md).

### Every completed work should improve future work

The value of the system compounds. Each completed Work should leave the organization
measurably better equipped than it was before.

---

## Long-Term Direction

AIOS develops in phases, each validated before the next begins. See
[`roadmap.md`](roadmap.md) for the authoritative phase definitions.

1. **Foundation** — trustworthy Work, Decision, and human-approved Memory with one Secretary.
2. **Structured Collaboration** — repeatable patterns and stronger coordination.
3. **AI Organization** — multiple governed AI Principals working alongside humans.
4. **Organizational Intelligence** — Evidence, Knowledge, and Capability derived from approved experience.
5. **Platform and Ecosystem** — a governed extension model for developers and partners.

Each phase must preserve the invariants of the phase before it. Extensions must never
bypass domain invariants, authorization, or human authority.

---

## What Success Looks Like

AIOS succeeds when an organization can answer these questions from the system itself,
without asking a person:

- What did we decide, and who had the authority to decide it?
- Why did we decide it that way, and what else did we consider?
- What did that work actually teach us?
- What did the AI contribute, and what was it permitted to do?
- Where has this problem been solved before?

The narrower near-term test is the MVP hypothesis: that a small team will complete real
work inside AIOS and find the resulting Memory worth reviewing and approving.

If teams do not value the Memory produced, no later phase will rescue the product. That
is why the MVP ends at Approved Memory.

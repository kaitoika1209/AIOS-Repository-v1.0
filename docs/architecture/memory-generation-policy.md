# Memory Generation Policy

> **Scope classification:** MVP Normative  
> **MVP implementation authority:** Yes  
> **Promotion requirement:** Not applicable  
> **Authority rank:** see [Document Governance](../document-governance.md)

**Status:** Draft  
**Phase:** MVP  
**Provider:** Anthropic ([ADR-0016](../adr/0016-bind-anthropic-as-the-model-provider.md))

---

## Purpose

This document defines what the Secretary sends to the model, what shape it must
send back, what is done with the answer before anyone sees it, and how any of
that is known to work.

It is the content of the *generation policy* that
[ADR-0012](../adr/0012-define-memory-source-snapshot-and-data-governance.md)
requires to be versioned and recorded with every Memory. The policy is one unit:
prompt, output schema, model, and validation rules version together, because a
Memory generated under one of them cannot be reasoned about using another.

---

## What Generation Is, and Is Not

Generation produces a **draft**. It is not a decision, not a record, and not
history. [ADR-0004](../adr/0004-separate-external-computation-and-business-effects.md)
classifies it as `ExternalComputation`, which has one consequence that shapes
everything below:

> The provider response is untrusted candidate content. It has no Human or
> domain authority, and becomes meaningful only after local validation.

The deterministic generator this replaces was safe for a reason worth naming: it
invented nothing. Every sentence it wrote was a rearrangement of what the Work
already recorded, so approving its output could not introduce a falsehood. A
language model gives that property up.

The rest of this document is the machinery that buys as much of it back as can
be bought mechanically, plus an honest statement of what cannot be.

---

## Generation Policy Version

```text
generation_policy_version = 2
```

Version 1 is the deterministic generator, retained and still used when no
provider credential is configured. Version 2 is the policy defined here.

The version is recorded on every Memory. It **must** be incremented when any of
the following changes:

- the prompt text;
- the output schema;
- the model identifier;
- the groundedness rules; or
- the canonicalization of the source snapshot into provider input.

Incrementing is not optional bookkeeping. A reviewer looking at a two-year-old
Memory needs to know which rules produced it, and a `provider_input_hash` is only
comparable within one policy version.

---

## Source Snapshot to Provider Input

The provider sees the source snapshot and nothing else. Not the live Work, not a
projection, not the Organization's other Memories — the immutable snapshot
captured when `WorkCompleted` was consumed, exactly as the
[Memory state machine](state-machines/memory.md) requires.

Canonicalization is deterministic so that a retry produces a byte-identical
input and therefore the same `provider_input_hash`:

```text
1. Take the fields below from the snapshot, in this order.
2. Omit any field whose value is absent. Do not emit a placeholder.
3. Serialize as JSON with sorted keys and no insignificant whitespace.
4. Hash with SHA-256. That hash is provider_input_hash.
```

Fields:

| Field | Source |
|---|---|
| `workId` | snapshot |
| `title` | Work title at completion |
| `description` | Work description at completion |
| `completionSummary` | the summary the completing human wrote |
| `completedAt` | ISO-8601, UTC |
| `decision` | present only when the completion gate was satisfied |

When present, `decision` carries the submitted Decision snapshot: its
`decisionId`, `question`, the `selectedOptionId`, and the approver's recorded
`rationale`.

Nothing identifying a person is included. The snapshot references humans by
`identityId`, and identifiers are not sent — the model has no use for them, and
[ADR-0012](../adr/0012-define-memory-source-snapshot-and-data-governance.md)
treats every additional field crossing the boundary as retention surface that
must later be erasable.

---

## The Prompt

The prompt is data, not prose to be paraphrased. It is stored as a single
versioned constant so that the bytes recorded in provenance are the bytes sent.

### System prompt

```text
You write the organization's record of a completed piece of work.

You are a secretary. You are not a participant, not a reviewer, and not an
author of opinions. A human will read what you write, correct it, and decide
whether it becomes the organization's history. Your draft is a proposal.

Write only what the source material states.

- Every fact in your output must be traceable to the source material.
- Do not add context, background, or explanation from your own knowledge.
- Do not name people, teams, systems, tools, dates, or figures that the
  source material does not name.
- Do not infer what happened between recorded facts.
- Do not evaluate whether the work was done well.
- Do not recommend follow-up work.

When the source material is thin, write a short record. A short accurate
record is correct. Padding it is not.

If the source material does not support a section, omit it rather than
writing that information was unavailable.

Write in plain past tense, in the third person, without headings in the
summary. Do not begin with "This document", "This memory", or "In summary".
```

### User message

The canonicalized provider input from the previous section, verbatim, as JSON.

### Why the prompt reads as constraint rather than instruction

Most of it says what *not* to do. That is deliberate: the failure this policy
exists to prevent is not a poorly written draft, it is a plausible false one. A
model asked to "write a good summary" will fill gaps, because filling gaps is
what makes prose read well. The reviewer cannot tell a filled gap from a recorded
fact, and approval is terminal.

---

## Output Schema

The response is constrained to this schema. A response that does not match it is
discarded — not repaired, not partially used.

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["title", "summary", "content", "sourceReferences"],
  "properties": {
    "title": {
      "type": "string",
      "description": "A short name for this record. Reuse the Work's title unless it is uninformative."
    },
    "summary": {
      "type": "string",
      "description": "One paragraph stating what was done and what resulted. No headings, no lists."
    },
    "content": {
      "type": "string",
      "description": "The full record in Markdown. May use headings and lists."
    },
    "sourceReferences": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Which parts of the source material this record draws on."
    }
  }
}
```

`sourceReferences` is provenance, not Evidence in the Knowledge sense
([ADR-0002](../adr/0002-memory-vs-knowledge.md)). It records what the draft was
derived from. It does not make the draft true, and approving a Memory does not
promote its references into reusable organizational Knowledge.

The schema is mirrored by `GeneratedContent` in the domain layer, minus
`contentHash`, which is computed locally after validation rather than accepted
from the provider.

---

## Model and Request Parameters

| Parameter | Value | Reason |
|---|---|---|
| Model | `claude-opus-5` | Pinned by policy version, not by environment. |
| `max_tokens` | 8192 | Bounds cost per call and caps thinking plus response together. |
| Thinking | adaptive, output omitted | On by default for this model. Reasoning is not recorded: it is not part of the Memory, and persisting it would enlarge the retention surface ADR-0012 bounds. |
| Effort | `medium` | Restating recorded facts accurately is not an intelligence-limited task. Higher effort spends tokens on deliberation that groundedness rules already constrain. |
| Sampling parameters | none | Rejected by this model. Behaviour is steered by the prompt. |

### Token budget

Provider input is bounded by the source snapshot, which is bounded by Work
content limits. The budget per generation is therefore:

```text
input   ≈ prompt (~350 tokens) + snapshot (typically < 2,000)
output  ≤ 8,192 (thinking + response)
```

One completed Work produces at most one generation per policy version — the
uniqueness constraint on `memory_generation_operations` guarantees it — so
spend scales with completed Work, not with retries. A retry reuses the same
operation row and the same input.

### Refusals

`stop_reason: "refusal"` is checked before the response body is read. A refusal
is not an error to retry blindly: retrying identical input produces an identical
refusal. It is recorded on the operation as a terminal `Failed` with a reason
code, leaving the Work without a Memory draft until a human intervenes. This is
the correct outcome — the alternative is a retry loop that spends money to be
refused repeatedly.

---

## Local Validation

Validation runs on every response before a Memory exists. Failing it means no
draft is created and the operation retries; nothing reaches a reviewer.

### 1. Shape

The response parses, matches the schema, and has non-empty `title`, `summary`,
and `content`.

### 2. Groundedness

This is the substantive check. The draft is scanned for tokens that assert
specific, checkable facts, and every one must appear in the provider input:

| Class | Rule |
|---|---|
| Numbers | Every numeric literal must appear in the source. Markdown list markers are not literals; identifiers are excluded and checked as identifiers. |
| Dates | Every date, in any recognized format, must appear in the source. |
| Identifiers | Every UUID, issue key, commit-like hash, or `@handle` must appear in the source. |
| URLs | Every URL must appear in the source. |
| Capitalized names | Every capitalized multi-word phrase on one line, not at a sentence start, must be supported by the source — either as the whole phrase, or with every word in it present. |

Comparison is on a normalized form: case-folded, punctuation-stripped, and with
dates parsed to a common representation, so that "2026-07-29" in the source
satisfies "29 July 2026" in the draft.

Two relaxations in the name rule are deliberate, and both exist to stop the
validator rejecting correct drafts:

- **Word-level support.** A source saying "the payments team" supports a draft
  saying "Payments Team". Re-describing recorded facts in new phrasing is what a
  good draft does, and a validator that punishes it gets switched off.
- **One line only.** A phrase does not span a line break. Matching across one
  joined the last word of a paragraph to the first word of the next heading and
  reported the result as an invented name — found by the end-to-end test, not by
  reading the rule.

The check is deliberately **narrow and mechanical**. It answers one question —
did the model introduce a specific fact that is not in the source? — and it
answers that question well. It says nothing about whether the prose is fair,
complete, or well judged.

### What it cannot catch

A fluent, plausible, wrong sentence containing no numbers, dates, or names passes
every rule above. "The team considered several alternatives before proceeding"
is unfalsifiable by any local check and may be entirely invented.

That residual risk is not closed by validation. It is closed — to the extent it
is closed at all — by the fact that approval is human, terminal, attributed, and
made with the source snapshot visible.

Stating this plainly is part of the policy. A validator described as catching
hallucinations, rather than as catching one specific mechanical class of them,
would encourage exactly the misplaced trust the human review gate exists to
prevent.

---

## Evaluation

Generation quality is measured, not proven. Two suites, with different jobs.

### Fixture evaluation — runs in CI, no credential

Recorded provider responses paired with the snapshots that produced them. Each
case asserts one property of the pipeline that must hold regardless of what a
model returns on any given day:

- a grounded response validates and produces the expected `GeneratedContent`;
- a response inventing a figure, a date, a name, or an identifier is rejected;
- a schema-violating response is rejected without a partial draft;
- a refusal is recorded as `Failed`, not retried;
- identical input produces an identical `provider_input_hash`.

Fixtures are checked in. They make regressions in validation, canonicalization,
and error handling fail the build on machines with no provider access — which is
every CI machine and most development ones.

### Live evaluation — runs only when a credential is present

    ANTHROPIC_API_KEY=... pnpm --filter @aios/api evaluate

The same cases against the real provider, reporting whether:

- responses match the schema;
- responses pass groundedness on realistic snapshots; and
- a snapshot with almost no content produces a short draft rather than a padded
  one.

The script prints each draft and reports groundedness. It does not score
judgement — whether a draft is fair, complete, and appropriately brief is for
the reader, and a number would read like a verdict it has not earned.

Live evaluation is not a gate on merge. It is how the prompt is developed, and
how a policy version is justified before being pinned. A change to any element
of the policy requires a live run recorded in the pull request that bumps the
version.

### What is deliberately not built

**A model grading the model.** An LLM judge would need its own evaluation to be
trustworthy, and its failure mode — agreeing with fluent, confident, wrong
output — is precisely the failure mode being guarded against. Human approval is
already the judge, and it is the one whose authority the architecture recognizes.

---

## Related Documents

- [ADR-0016: Bind Anthropic as the Model Provider](../adr/0016-bind-anthropic-as-the-model-provider.md)
- [ADR-0004: Separate External Computation from External Business Effects](../adr/0004-separate-external-computation-and-business-effects.md)
- [ADR-0008: Define the Work-to-Memory Generation Process](../adr/0008-define-work-to-memory-generation-process.md)
- [ADR-0012: Define the Memory Source Snapshot and Data Governance](../adr/0012-define-memory-source-snapshot-and-data-governance.md)
- [Memory State Machine](state-machines/memory.md)
- [Memory Aggregate](aggregates/memory.md)
- [Persistence and Data Model](persistence-and-data-model.md)

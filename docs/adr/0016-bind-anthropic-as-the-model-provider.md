# ADR-0016: Bind Anthropic as the Model Provider and Call It Directly

**Status:** Proposed  
**Date:** 2026-07-29  
**Blueprint Version:** 0.2.1  
**Decision Owner:** Organizational Learning  
**Review Trigger:** before a second generation use case is added, when a provider's structured-output contract changes, when generation quality is measured against a provider alternative, or when an orchestration framework becomes necessary for a real workflow

## Context

Memory generation is the last unimplemented half of the MVP loop. A deterministic
stub currently produces drafts; replacing it requires two choices the existing
documents answer only partially.

**Which provider.** [`engineering/tech-stack.md`](../engineering/tech-stack.md)
selects OpenAI, and adds two qualifications: "The model provider may change in
the future" and "The application should remain provider-agnostic". That is a
selection made before any generation code existed, in a document that
anticipates its own revision.

**Which runtime.** The same document selects LangGraph, justified by "stateful
workflows", "multi-agent orchestration", and "human-in-the-loop support". None of
those describe what Memory generation actually is.
[ADR-0004](0004-separate-external-computation-and-business-effects.md)
classifies it as `ExternalComputation`: one provider call, no conversation, no
tools, no agent loop. The state it needs is already durable — a
`memory_generation_operation` row with a lease, an attempt count, and a retry
schedule. The human-in-the-loop step is not a workflow pause; it is the Memory
review lifecycle, which is a domain Aggregate with its own state machine and its
own persistence.

The architectural constraint that matters more than either selection is
ADR-0004's characterization of the provider response: it "is untrusted candidate
content", "has no Human or domain authority", and "becomes meaningful only after
local validation". Whatever provider is chosen, the code that consumes it is
adversarial-by-default.

## Decision

**AIOS uses Anthropic as the model provider for Memory generation, and calls the
Messages API directly through the official SDK.**

The provider is reached through one adapter implementing the `MemoryGenerator`
port. That port is declared in the Application Layer, takes a `WorkState` and a
source snapshot, and returns candidate content. Nothing above it names a
provider, a model, or a prompt.

`claude-opus-5` is the model. The generation policy — prompt, output schema,
model identifier, and validation rules — is versioned as a unit and recorded with
every Memory, per [ADR-0012](0012-define-memory-source-snapshot-and-data-governance.md).
See [Memory Generation Policy](../architecture/memory-generation-policy.md) for
its content.

**No orchestration framework is adopted.** A single provider call behind a port
does not need one, and introducing LangGraph would put workflow state in a second
place while `memory_generation_operations` remains the authoritative record that
ADR-0004 requires.

This supersedes the Model Provider and Runtime selections in `tech-stack.md`,
which is amended to point here. Nothing else in that document changes.

## Alternatives considered

**Keep OpenAI, as `tech-stack.md` selects.** Rejected on evidence rather than
preference. The selection carries no rationale — the document gives a "Why" for
every other choice and none for this one — and explicitly anticipates change. The
port is provider-neutral either way, so the decision is reversible at the cost of
one file. What tips it is operational: the Secretary is an AI participant subject
to a Human authority boundary this repository takes seriously, and Anthropic
publishes the model behavior and safety posture that boundary is reasoned about.
A provider chosen without a recorded reason is not a decision to defend.

**Implement both and select by environment variable.** Rejected. Two adapters
double the surface that must be evaluated for groundedness, and the second would
be unevaluated — the evaluation harness runs against recorded responses from one
provider. Provider-agnosticism is a property of the *port*, which this decision
preserves; it is not a requirement to ship two implementations. Adding the second
later costs one file and the evaluation run that justifies it.

**Adopt LangGraph as `tech-stack.md` selects.** Rejected: none of its three
stated justifications apply. Generation is a single stateless call; there are no
multiple agents; and the human review step is a domain state machine, not a
workflow interrupt. Adopting it would create a second home for state that
ADR-0004 requires to live in `memory_generation_operations`.

**Trust the provider's structured output and skip local validation.** Rejected
as a direct contradiction of ADR-0004. A schema guarantees *shape*, not
*truthfulness*: a response can be perfectly typed and still name a person who
does not exist. The property that makes the current stub safe is that it invents
nothing, and replacing it with a model gives that property up unless something
enforces it.

## Consequences

**The Secretary can write a Memory draft that reads like a colleague wrote it.**
That is the point of the release, and it is what the deterministic stub — which
only restates the Work — cannot do.

**Generation becomes non-deterministic, and correctness becomes a measurement
rather than a proof.** Every other rule in this repository is enforced by a type,
a constraint, or a test that passes or fails. Generation quality is not, so it is
bounded from the outside instead: the output schema constrains shape, the
groundedness validator constrains content, and human approval remains the only
thing that makes a Memory authoritative. A draft that fails validation is
discarded and the operation retried; it never reaches a reviewer.

**A hallucination that survives validation and approval becomes organizational
history.** This is the residual risk, and it cannot be engineered to zero.
Validation catches invented identifiers, figures, and dates because those are
checkable against the snapshot; it cannot catch a fluent, plausible, wrong
sentence. The mitigations are that approval is human, terminal, and attributed,
and that the reviewer sees the source snapshot the draft was generated from.

**Generation now costs money per completed Work**, where the stub cost nothing.
The token budget in the generation policy bounds it per call; nothing bounds the
number of calls except the number of completed Works.

**An outage or a refusal blocks Memory drafts.** ADR-0004 already handles this
correctly: generation is computation-only, so a failure is retried rather than
escalated, and no business outcome is inferred from a timeout. Work completion is
unaffected — the Memory simply arrives later.

**A second use case may want a framework this decision declines.** Revisit at
that point rather than pre-building for it. The port is the seam that makes the
revisit cheap.

## Related documents

- [ADR-0004: Separate External Computation from External Business Effects](0004-separate-external-computation-and-business-effects.md)
- [ADR-0008: Define the Work-to-Memory Generation Process](0008-define-work-to-memory-generation-process.md)
- [ADR-0011: Bound the Secretary to Context-Owned Assistance Ports](0011-bound-secretary-to-context-owned-assistance-ports.md)
- [ADR-0012: Define the Memory Source Snapshot and Data Governance](0012-define-memory-source-snapshot-and-data-governance.md)
- [Memory Generation Policy](../architecture/memory-generation-policy.md)
- [Technology Stack](../engineering/tech-stack.md)
- [Document Governance](../document-governance.md)

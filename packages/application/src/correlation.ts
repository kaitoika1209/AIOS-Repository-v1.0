/**
 * Request-scoped correlation.
 *
 * The observability architecture requires "server-owned request and workflow
 * correlation", and until now there was none: the edge audit, the use-case
 * audit, and the Outbox each called `randomUUID()` for their own
 * `correlationId`. One HTTP request therefore produced three unrelated
 * identifiers, and nothing could follow a business workflow from the request
 * that started it to the event it emitted — which is the entire purpose of the
 * field.
 *
 * `AsyncLocalStorage` rather than threading a parameter through every use case:
 * correlation is ambient by nature — it belongs to the request, not to any
 * argument list — and passing it explicitly would put a telemetry concern into
 * the signature of every command in the system.
 *
 * ## The trust boundary
 *
 * Both identifiers are minted here and never accepted from a caller. The
 * architecture is unambiguous: "At every public ingress, AIOS MUST generate a new
 * server-owned `requestId` and `correlationId`. A value supplied by an external
 * caller MUST NOT be accepted, promoted, or copied into the internal
 * `correlationId` field."
 *
 * A caller's own value may be *retained* as `externalCorrelationId` — untrusted
 * metadata, useful for matching up logs with a client's, and forbidden from
 * affecting anything: "MUST NOT be used for authorization, tenant selection,
 * ownership checks, idempotency, uniqueness, database joins, routing,
 * rate-limit identity, or workflow state changes." It is kept in a separate
 * field precisely so that no code can reach for it by accident while meaning the
 * real one.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export interface CorrelationContext {
  /** One inbound transport request. A retry gets a new one. */
  readonly requestId: string;
  /**
   * One end-to-end business workflow, server-owned.
   *
   * Spans commands, events, and Worker executions — which is why the Outbox
   * and the audit must read it here rather than each minting one.
   */
  readonly correlationId: string;
  /** What the caller claimed, if anything. Untrusted, and load-bearing on nothing. */
  readonly externalCorrelationId: string | null;
}

const storage = new AsyncLocalStorage<CorrelationContext>();

/** The longest caller-supplied correlation value that will be retained. */
const MAX_EXTERNAL_LENGTH = 128;

/**
 * Bounded validation for a caller's correlation header.
 *
 * Length-capped and character-restricted, because this value reaches logs: an
 * unbounded header is a way to flood a log sink, and one containing newlines is
 * a way to forge log lines. It is discarded rather than truncated — a mangled
 * identifier correlates with nothing, so keeping a prefix would only look useful.
 */
export const acceptExternalCorrelation = (value: string | undefined): string | null => {
  if (value === undefined) return null;
  if (value.length === 0 || value.length > MAX_EXTERNAL_LENGTH) return null;
  return /^[\w.:-]+$/.test(value) ? value : null;
};

/** Mint a context for one inbound request. */
export const newCorrelation = (externalCorrelationId: string | null = null): CorrelationContext => ({
  requestId: randomUUID(),
  correlationId: randomUUID(),
  externalCorrelationId,
});

/** Run `fn` with this correlation visible to everything it calls. */
export const runWithCorrelation = <T>(
  context: CorrelationContext,
  fn: () => T,
): T => storage.run(context, fn);

/** The current request's correlation, or null outside one. */
export const currentCorrelation = (): CorrelationContext | null =>
  storage.getStore() ?? null;

/**
 * The correlation identifier to record on a durable row.
 *
 * Falls back to a fresh identifier rather than throwing or writing null: work
 * that legitimately begins outside a request — the Worker's own drains, the
 * seed script, a migration — still deserves an identifier that ties its own
 * records together. What it must never do is silently share one with an
 * unrelated workflow, which a constant or a null would.
 */
export const correlationIdForRecord = (): string =>
  currentCorrelation()?.correlationId ?? randomUUID();

/** The request identifier to record, on the same terms. */
export const requestIdForRecord = (): string =>
  currentCorrelation()?.requestId ?? randomUUID();

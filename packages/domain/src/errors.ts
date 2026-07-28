/**
 * Domain errors.
 *
 * `docs/engineering/coding-standards.md` reserves exceptions for exceptional
 * situations and asks that business validation be represented explicitly. These
 * types carry a stable `code` so the Presentation Layer can map them to the
 * status codes ADR-0014 defines without inspecting messages.
 */

export type DomainErrorCode =
  | "WORK_INVALID_TRANSITION"
  | "WORK_COMPLETION_GATE_UNSATISFIED"
  | "WORK_BLOCKING_DECISION_EXISTS"
  | "WORK_BLOCKING_REFERENCE_MISMATCH"
  | "WORK_IMMUTABLE"
  | "DECISION_INVALID_TRANSITION"
  | "DECISION_IMMUTABLE"
  | "CROSS_ORGANIZATION_REFERENCE"
  | "HUMAN_AUTHORITY_REQUIRED"
  | "VERSION_CONFLICT"
  | "VALIDATION_FAILED";

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: DomainErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

/**
 * An invalid state-machine transition.
 *
 * ADR-0014 maps this to 409 rather than 422: the request is well formed and the
 * invariant is intact, the Aggregate is simply not in a state that permits the
 * command.
 */
export class InvalidTransitionError extends DomainError {
  constructor(
    aggregate: "Work" | "Decision",
    from: string,
    command: string,
    allowed: readonly string[],
  ) {
    super(
      aggregate === "Work" ? "WORK_INVALID_TRANSITION" : "DECISION_INVALID_TRANSITION",
      `${aggregate} cannot accept ${command} from state ${from}.`,
      { aggregate, from, command, allowedFrom: allowed },
    );
    this.name = "InvalidTransitionError";
  }
}

/**
 * A reference crossing an Organization boundary.
 *
 * The database makes this unrepresentable through composite foreign keys; this
 * error catches it earlier, before a write is attempted.
 */
export class CrossOrganizationError extends DomainError {
  constructor(expected: string, actual: string, subject: string) {
    super(
      "CROSS_ORGANIZATION_REFERENCE",
      `${subject} belongs to a different Organization.`,
      { expected, actual, subject },
    );
    this.name = "CrossOrganizationError";
  }
}

/** An action reserved for Human Members was attempted by another principal. */
export class HumanAuthorityRequiredError extends DomainError {
  constructor(command: string, principalType: string) {
    super(
      "HUMAN_AUTHORITY_REQUIRED",
      `${command} requires a Human Member; ${principalType} principals cannot perform it.`,
      { command, principalType },
    );
    this.name = "HumanAuthorityRequiredError";
  }
}

export class VersionConflictError extends DomainError {
  constructor(expected: number, actual: number) {
    super("VERSION_CONFLICT", "The resource was modified by another request.", {
      expected,
      actual,
    });
    this.name = "VersionConflictError";
  }
}

export class ValidationError extends DomainError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("VALIDATION_FAILED", message, details);
    this.name = "ValidationError";
  }
}

/**
 * Branded identifier types.
 *
 * Identifiers are opaque (ADR-0014). Branding prevents passing an
 * `OrganizationId` where a `WorkId` is expected, which the architecture treats
 * as a tenant-isolation concern rather than a typo.
 *
 * External identity provider subjects are deliberately absent: per ADR-0013 and
 * `docs/architecture/identity-and-organization.md`, they live only in
 * `authentication_subject_references` and never reach the domain.
 */

declare const brand: unique symbol;

type Brand<T, TBrand extends string> = T & { readonly [brand]: TBrand };

export type OrganizationId = Brand<string, "OrganizationId">;
export type IdentityId = Brand<string, "IdentityId">;
export type MembershipId = Brand<string, "MembershipId">;
export type RoleAssignmentId = Brand<string, "RoleAssignmentId">;

export type WorkId = Brand<string, "WorkId">;
export type DecisionId = Brand<string, "DecisionId">;
export type MemoryId = Brand<string, "MemoryId">;

export type EventId = Brand<string, "EventId">;
export type OutboxMessageId = Brand<string, "OutboxMessageId">;
export type GenerationOperationId = Brand<string, "GenerationOperationId">;

/** Aggregate version used for optimistic concurrency (`If-Match`, ADR-0014). */
export type AggregateVersion = Brand<number, "AggregateVersion">;

const asBrand = <T extends string>(value: string): Brand<string, T> =>
  value as Brand<string, T>;

export const OrganizationId = (value: string): OrganizationId =>
  asBrand<"OrganizationId">(value);
export const IdentityId = (value: string): IdentityId => asBrand<"IdentityId">(value);
export const MembershipId = (value: string): MembershipId =>
  asBrand<"MembershipId">(value);
export const WorkId = (value: string): WorkId => asBrand<"WorkId">(value);
export const DecisionId = (value: string): DecisionId => asBrand<"DecisionId">(value);
export const MemoryId = (value: string): MemoryId => asBrand<"MemoryId">(value);

export const AggregateVersion = (value: number): AggregateVersion => {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`AggregateVersion must be a positive integer, got ${value}`);
  }
  return value as AggregateVersion;
};

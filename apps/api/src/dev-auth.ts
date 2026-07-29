/**
 * Development authentication adapter.
 *
 * ADR-0013 makes the provider replaceable by design: everything below the edge
 * consumes a `HumanMemberPrincipal`, and the only integration point is mapping
 * a `(provider, issuer, subject)` tuple to an identity. This adapter supplies
 * that tuple from headers instead of verifying a Clerk session.
 *
 * Swapping in Clerk replaces this class and nothing else. It performs no
 * verification and must never be mounted in a deployed environment — `main.ts`
 * refuses to start with it outside development.
 */

import type { Request } from "express";

import type { AuthAdapter, AuthenticatedSubject } from "./request-context.js";

export const DEV_PROVIDER = "dev";
export const DEV_ISSUER = "https://dev.local";

export class DevAuthAdapter implements AuthAdapter {
  async authenticate(request: Request): Promise<AuthenticatedSubject | null> {
    const subject = request.header("x-dev-subject");
    if (subject === undefined || subject.trim().length === 0) {
      return null;
    }
    return {
      provider: DEV_PROVIDER,
      issuer: DEV_ISSUER,
      subject,
      // Clerk supplies a name with the session; here it comes from a header so
      // an invitation accepted by a new subject gets a readable Identity.
      displayName: request.header("x-dev-display-name") ?? subject,
      ...(request.header("x-dev-email") === undefined
        ? {}
        : { email: request.header("x-dev-email")! }),
    };
  }
}

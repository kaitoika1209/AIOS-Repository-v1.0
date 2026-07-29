/**
 * Clerk authentication adapter (ADR-0013).
 *
 * Clerk answers exactly one question: which external subject is making this
 * request? Everything the ADR forbids it from owning — Organization, Membership,
 * roles, permissions, invitations — is resolved from PostgreSQL by
 * `PrincipalResolver`, which this adapter never touches.
 *
 * That boundary is why the file is short. The only integration point is mapping
 * a verified session to a `(provider, issuer, subject)` tuple, and no layer
 * below the edge sees a Clerk token, session, user object, or subject string.
 *
 * Two Clerk features are deliberately unused: Organizations and the `org_*`
 * session claims. Reading either would create a second source of truth for the
 * tenant boundary, which the ADR says requires a new ADR of its own.
 */

import { verifyToken } from "@clerk/backend";
import type { Request } from "express";

import type { AuthAdapter, AuthenticatedSubject } from "./request-context.js";

export const CLERK_PROVIDER = "clerk";

/**
 * Claims this adapter reads.
 *
 * `sub` and `iss` are the subject tuple. `name` and `email` are profile values
 * that seed a Human Identity on first sight — AIOS-owned from then on, and
 * never a join key: "Identity is keyed by `identity_id`; the subject tuple is
 * the only external key."
 */
interface SessionClaims {
  readonly sub?: unknown;
  readonly iss?: unknown;
  readonly name?: unknown;
  readonly email?: unknown;
}

export interface ClerkOptions {
  /**
   * The PEM public key, for networkless verification.
   *
   * Preferred over `secretKey`: verifying against a fetched JWKS puts a network
   * call on the authentication path of every request, and an outage there
   * becomes an outage here.
   */
  readonly jwtKey?: string | undefined;
  readonly secretKey?: string | undefined;
  /**
   * Frontend origins permitted to mint the session.
   *
   * Checked by Clerk against the token's `azp` claim, which is what stops a
   * token issued for another application from authenticating here.
   */
  readonly authorizedParties?: readonly string[] | undefined;
}

/**
 * Extract the session token.
 *
 * `Authorization: Bearer` first, then the `__session` cookie. Both are read
 * because a first-party browser session uses the cookie while a server-to-server
 * or mobile caller sends the header.
 */
const tokenFrom = (request: Request): string | null => {
  const header = request.header("authorization");
  if (header !== undefined && /^Bearer /i.test(header)) {
    const token = header.slice(7).trim();
    if (token.length > 0) return token;
  }

  // Parsed without a cookie middleware so the adapter stays self-contained and
  // the app does not have to mount one for authentication to work.
  const cookies = request.header("cookie");
  if (cookies === undefined) return null;

  for (const part of cookies.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === "__session" && rest.length > 0) {
      const value = decodeURIComponent(rest.join("=")).trim();
      if (value.length > 0) return value;
    }
  }

  return null;
};

const stringOr = (value: unknown, fallback: string): string =>
  typeof value === "string" && value.trim().length > 0 ? value : fallback;

export class ClerkAuthAdapter implements AuthAdapter {
  constructor(private readonly options: ClerkOptions) {
    if (
      (options.jwtKey ?? "").length === 0 &&
      (options.secretKey ?? "").length === 0
    ) {
      // Refused at construction rather than on the first request. An adapter
      // with no key can only fail every request, and failing at startup names
      // the misconfiguration instead of reporting it as a login problem.
      throw new Error(
        "Clerk authentication requires CLERK_JWT_KEY or CLERK_SECRET_KEY.",
      );
    }
  }

  async authenticate(request: Request): Promise<AuthenticatedSubject | null> {
    const token = tokenFrom(request);
    if (token === null) {
      return null;
    }

    let claims: SessionClaims;
    try {
      claims = (await verifyToken(token, {
        ...(this.options.jwtKey === undefined
          ? {}
          : { jwtKey: this.options.jwtKey }),
        ...(this.options.secretKey === undefined
          ? {}
          : { secretKey: this.options.secretKey }),
        ...(this.options.authorizedParties === undefined
          ? {}
          : { authorizedParties: [...this.options.authorizedParties] }),
      })) as SessionClaims;
    } catch {
      // Every verification failure is one outcome: no subject. Expired,
      // malformed, wrong signature, and wrong party are not distinguished,
      // because telling a caller which one it was tells them how to get closer.
      return null;
    }

    const subject = claims.sub;
    const issuer = claims.iss;
    if (typeof subject !== "string" || subject.length === 0) {
      return null;
    }
    if (typeof issuer !== "string" || issuer.length === 0) {
      // A verified token with no issuer cannot form the subject tuple, and
      // substituting a configured default would let one instance's tokens
      // resolve against another's identities.
      return null;
    }

    return {
      provider: CLERK_PROVIDER,
      issuer,
      subject,
      // Seeds the Human Identity created when an invitation is accepted. Falls
      // back to the subject so the row is never nameless.
      displayName: stringOr(claims.name, stringOr(claims.email, subject)),
      ...(typeof claims.email === "string" && claims.email.length > 0
        ? { email: claims.email }
        : {}),
    };
  }
}

/**
 * Choose the adapter for an environment.
 *
 * The development adapter is refused outside development and test, mirroring
 * the seed script. A header-supplied subject in a deployed environment is not a
 * weaker authentication — it is none at all.
 */
export const clerkOptionsFrom = (
  env: NodeJS.ProcessEnv,
): ClerkOptions | null => {
  const jwtKey = env["CLERK_JWT_KEY"];
  const secretKey = env["CLERK_SECRET_KEY"];

  if ((jwtKey ?? "").length === 0 && (secretKey ?? "").length === 0) {
    return null;
  }

  const parties = (env["CLERK_AUTHORIZED_PARTIES"] ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  return {
    jwtKey,
    secretKey,
    ...(parties.length > 0 ? { authorizedParties: parties } : {}),
  };
};

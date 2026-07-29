/**
 * Clerk adapter tests against real signature verification.
 *
 * Tokens are minted here with a generated RSA key and verified by Clerk's own
 * `verifyToken` against the matching public key, so the signature path is
 * genuinely exercised rather than stubbed. A mocked verifier would prove only
 * that the adapter calls it.
 *
 * No Clerk account, network, or credential is involved: `jwtKey` is the
 * networkless verification path, and a locally generated key is
 * indistinguishable from an instance key to the verifier.
 */

import { createSign, generateKeyPairSync } from "node:crypto";
import type { Request } from "express";
import { beforeAll, describe, expect, it } from "vitest";

import { CLERK_PROVIDER, ClerkAuthAdapter, clerkOptionsFrom } from "./clerk-auth.js";

const ISSUER = "https://example.clerk.accounts.dev";

let privateKeyPem: string;
let publicKeyPem: string;

const base64url = (value: Buffer | string): string =>
  Buffer.from(value).toString("base64url");

/** Mint an RS256 token. Clerk session tokens are ordinary JWTs. */
const sign = (
  claims: Record<string, unknown>,
  key: string = privateKeyPem,
): string => {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test" }));
  const payload = base64url(
    JSON.stringify({
      iss: ISSUER,
      sub: "user_abc123",
      iat: now,
      nbf: now - 5,
      exp: now + 600,
      ...claims,
    }),
  );

  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(key, "base64url")}`;
};

/** Just enough of an Express request for the adapter's two header reads. */
const requestWith = (headers: Record<string, string>): Request =>
  ({
    header: (name: string) => headers[name.toLowerCase()],
  }) as unknown as Request;

const bearer = (token: string) => requestWith({ authorization: `Bearer ${token}` });

beforeAll(() => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
});

const adapter = (authorizedParties?: string[]) =>
  new ClerkAuthAdapter({
    jwtKey: publicKeyPem,
    ...(authorizedParties === undefined ? {} : { authorizedParties }),
  });

describe("configuration", () => {
  it("refuses to construct with no key at all", () => {
    // An adapter with no key can only fail every request. Failing at
    // construction names the misconfiguration instead of reporting it as a
    // login problem.
    expect(() => new ClerkAuthAdapter({})).toThrowError(
      /CLERK_JWT_KEY or CLERK_SECRET_KEY/,
    );
  });

  it("reports Clerk as unconfigured when neither variable is set", () => {
    expect(clerkOptionsFrom({})).toBeNull();
    expect(clerkOptionsFrom({ CLERK_JWT_KEY: "" })).toBeNull();
  });

  it("reads the authorized parties as a list", () => {
    expect(
      clerkOptionsFrom({
        CLERK_JWT_KEY: publicKeyPem,
        CLERK_AUTHORIZED_PARTIES: "https://a.example, https://b.example",
      }),
    ).toMatchObject({
      authorizedParties: ["https://a.example", "https://b.example"],
    });
  });
});

describe("authenticating a session", () => {
  it("maps a verified token to the subject tuple", async () => {
    const subject = await adapter().authenticate(bearer(sign({})));

    expect(subject).toEqual({
      provider: CLERK_PROVIDER,
      issuer: ISSUER,
      subject: "user_abc123",
      displayName: "user_abc123",
    });
  });

  it("takes the display name from the session, falling back to the email", async () => {
    expect(
      (await adapter().authenticate(bearer(sign({ name: "Olivia Reed" }))))
        ?.displayName,
    ).toBe("Olivia Reed");

    expect(
      (await adapter().authenticate(bearer(sign({ email: "olivia@example.test" }))))
        ?.displayName,
    ).toBe("olivia@example.test");
  });

  it("reads the __session cookie when there is no Authorization header", async () => {
    const token = sign({});
    const subject = await adapter().authenticate(
      requestWith({ cookie: `foo=bar; __session=${token}; baz=qux` }),
    );

    expect(subject?.subject).toBe("user_abc123");
  });

  it("returns no subject when no token is presented", async () => {
    expect(await adapter().authenticate(requestWith({}))).toBeNull();
    expect(
      await adapter().authenticate(requestWith({ authorization: "Bearer " })),
    ).toBeNull();
    expect(
      await adapter().authenticate(requestWith({ cookie: "other=value" })),
    ).toBeNull();
  });
});

describe("refusing a token", () => {
  /**
   * Every rejection is the same outcome: no subject.
   *
   * Asserted as a table rather than individually because the point is that they
   * are indistinguishable. Reporting which check failed would tell a caller
   * how to get closer.
   */
  it.each([
    [
      "signed by another key",
      () => {
        const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
        return sign({}, other.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
      },
    ],
    ["expired", () => sign({ exp: Math.floor(Date.now() / 1000) - 60 })],
    ["not yet valid", () => sign({ nbf: Math.floor(Date.now() / 1000) + 600 })],
    ["malformed", () => "not.a.jwt"],
    ["tampered after signing", () => `${sign({}).slice(0, -4)}AAAA`],
  ])("returns no subject for a token that is %s", async (_name, mint) => {
    expect(await adapter().authenticate(bearer(mint()))).toBeNull();
  });

  it("refuses a token minted for another application", async () => {
    // `azp` is what stops a token issued for a different frontend from
    // authenticating here.
    const token = sign({ azp: "https://attacker.example" });

    expect(
      await adapter(["https://app.example"]).authenticate(bearer(token)),
    ).toBeNull();
    expect(
      await adapter(["https://attacker.example"]).authenticate(bearer(token)),
    ).not.toBeNull();
  });

  it("refuses a verified token with no subject or no issuer", async () => {
    // A verified token missing either half cannot form the subject tuple.
    // Substituting a configured issuer would let one instance's tokens resolve
    // against another instance's identities.
    expect(await adapter().authenticate(bearer(sign({ sub: "" })))).toBeNull();
    expect(await adapter().authenticate(bearer(sign({ iss: undefined })))).toBeNull();
  });

  it("never returns an Organization, role, or permission", async () => {
    // ADR-0013: Clerk is not the source of truth for any value used in an
    // authorization decision. Even when the session carries Clerk Organization
    // claims, the adapter must not surface them.
    const subject = await adapter().authenticate(
      bearer(sign({ org_id: "org_clerk_1", org_role: "admin", org_permissions: ["x"] })),
    );

    expect(Object.keys(subject!).sort()).toEqual([
      "displayName",
      "issuer",
      "provider",
      "subject",
    ]);
  });
});

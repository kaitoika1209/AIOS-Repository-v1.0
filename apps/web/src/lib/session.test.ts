/**
 * The session boundary's one non-negotiable rule.
 *
 * `chooseSessionProvider` is the whole of A1 that can be tested without a
 * browser, a Clerk instance, or a running API — and it is the part where being
 * wrong is silent. A client that quietly fell back to the development adapter
 * outside development would authenticate nobody while appearing to authenticate
 * everybody, and would look completely normal doing it.
 */

import { describe, expect, it } from "vitest";

import { chooseSessionProvider } from "./session";

const clerk = {
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_x",
  CLERK_SECRET_KEY: "sk_test_x",
};

describe("choosing a session provider", () => {
  it("uses Clerk whenever both keys are present", () => {
    for (const environment of ["development", "test", "production"]) {
      const choice = chooseSessionProvider({ NODE_ENV: environment, ...clerk });
      expect(choice.provider).toBe("clerk");
    }
  });

  it("permits the development identities in development and test", () => {
    for (const environment of ["development", "test"]) {
      const choice = chooseSessionProvider({ NODE_ENV: environment });
      expect(choice.provider).toBe("dev");
      expect(choice.reason).toContain(environment);
    }
  });

  it("refuses the development identities anywhere else", () => {
    // The rule this file exists for, and the same one `chooseAuth` enforces on
    // the API. Throwing rather than falling back: a deployed client with no
    // Clerk keys would otherwise serve every visitor as whichever development
    // identity a cookie named — including one they set themselves.
    expect(() => chooseSessionProvider({ NODE_ENV: "production" })).toThrow(
      /refused under NODE_ENV=production/,
    );
    expect(() => chooseSessionProvider({ NODE_ENV: "staging" })).toThrow();
  });

  it("refuses a half-configured Clerk rather than falling back to it", () => {
    // One key without the other is a misconfiguration, and the dangerous
    // reading of it is "Clerk is nearly set up, use the development adapter for
    // now". In production that is the bypass above, arriving by a different
    // route.
    expect(() =>
      chooseSessionProvider({
        NODE_ENV: "production",
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_x",
      }),
    ).toThrow();
    expect(() =>
      chooseSessionProvider({ NODE_ENV: "production", CLERK_SECRET_KEY: "sk_test_x" }),
    ).toThrow();
  });

  it("treats an unset NODE_ENV as development", () => {
    // Next.js sets NODE_ENV itself, but a script that imports this module
    // directly may not. Defaulting to `production` would make local development
    // refuse to start; defaulting to `development` is the safe direction only
    // because a deployment always sets it — which is why the default is stated
    // here rather than left implicit.
    expect(chooseSessionProvider({}).provider).toBe("dev");
  });
});

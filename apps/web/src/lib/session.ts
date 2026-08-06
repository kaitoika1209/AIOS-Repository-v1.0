/**
 * The web client's session boundary (A1, ADR-0013).
 *
 * Until this file existed, `apps/web` had **no session at all**. `currentUser()`
 * read a cookie, and any value in that cookie naming a development identity
 * acted as that person: no sign-in, no sign-out, no verification, and no
 * unauthenticated state — every page rendered as somebody. That is correct for
 * a development switcher and is exactly what must not exist anywhere else.
 *
 * The shape here mirrors `chooseAuth` on the API, deliberately, because the two
 * halves have the same rule and it should be recognisably the same rule:
 *
 *   - a provider is chosen once, at startup, and **logged**;
 *   - the development adapter is **refused outside `development` and `test`**,
 *     by throwing rather than by falling back, so a misconfiguration fails
 *     loudly instead of serving a signed-out visitor as the seeded Owner.
 *
 * What crosses into the rest of the client is `WebSession`, which is four
 * fields. Nothing above this file knows whether the person signed in through
 * Clerk or picked a name from a list, which is what makes the swap
 * configuration rather than surgery.
 *
 * **The Clerk path has never been executed.** There is no Clerk instance and no
 * key. It is written against the published API and typechecks; that is not the
 * same as working, and `release-readiness.md` says so.
 */

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

/** Where the development adapter keeps its choice. Not a credential. */
export const DEV_SUBJECT_COOKIE = "aios_dev_subject";

export type SessionProvider = "dev" | "clerk";

/**
 * A signed-in person, as the rest of the client sees them.
 *
 * `token()` is a function rather than a field because a Clerk session token is
 * short-lived and minted on demand. Reading it once at sign-in and holding it
 * would produce a client that works for a minute and then quietly 401s.
 */
export interface WebSession {
  readonly provider: SessionProvider;
  readonly subject: string;
  readonly displayName: string;
  readonly email: string | null;
  token(): Promise<string | null>;
}

/**
 * The development identities.
 *
 * Only Olivia is seeded. Alice and Raj have no Membership — and no Identity —
 * until Olivia invites them and they accept, which is why signing in as them
 * before that produces "not authenticated" rather than a working session. That
 * is the invitation flow being real, not a gap.
 *
 * `expectedRole` drives demo copy only. It confers nothing: real roles come from
 * the Membership, and every form submits to the API whether or not the label
 * says it will succeed.
 */
export const DEV_USERS = [
  { subject: "olivia", label: "Olivia", seeded: true, expectedRole: "OrganizationOwner" },
  { subject: "alice", label: "Alice", seeded: false, expectedRole: "Member" },
  { subject: "raj", label: "Raj", seeded: false, expectedRole: "Reviewer" },
] as const;

export type DevUser = (typeof DEV_USERS)[number];

export interface ProviderChoice {
  readonly provider: SessionProvider;
  readonly reason: string;
}

/**
 * The three values this decision depends on.
 *
 * Narrower than `NodeJS.ProcessEnv` on purpose. A function that takes the whole
 * environment can read anything in it, and a reader cannot tell what it
 * actually depends on without reading the body — which for a function that
 * decides whether authentication is enforced is the wrong amount of mystery.
 *
 * It also makes the function testable: Next.js declares `NODE_ENV` as a union
 * of three literals, so a test cannot construct an environment claiming
 * `staging` — which is exactly the case worth testing.
 */
export interface SessionEnvironment {
  readonly NODE_ENV?: string | undefined;
  readonly NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?: string | undefined;
  readonly CLERK_SECRET_KEY?: string | undefined;
  readonly NEXT_PUBLIC_CLERK_SIGN_IN_URL?: string | undefined;
}

/**
 * Which provider this process runs with.
 *
 * Throws when the development adapter would be used outside development. The
 * API's `chooseAuth` does the same thing, and for the same reason: a client that
 * fell back to a header-based identity in production would authenticate nobody
 * while appearing to authenticate everybody.
 *
 * `test` is permitted alongside `development` so a suite can exercise the
 * development path without pretending to be a browser.
 */
export const chooseSessionProvider = (env: SessionEnvironment): ProviderChoice => {
  const environment = env["NODE_ENV"] ?? "development";
  const publishable = env["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"] ?? "";
  const secret = env["CLERK_SECRET_KEY"] ?? "";

  if (publishable !== "" && secret !== "") {
    return { provider: "clerk", reason: "Clerk sessions (ADR-0013)" };
  }

  if (environment !== "development" && environment !== "test") {
    // Never a fallback. The failure this prevents is silent: a deployed client
    // with no Clerk keys would otherwise serve every visitor as whichever
    // development identity a cookie named, including one they set themselves.
    throw new Error(
      `Clerk is not configured and the development session adapter is refused under NODE_ENV=${environment}. ` +
        "Set NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY.",
    );
  }

  return {
    provider: "dev",
    reason: `development identities (NODE_ENV=${environment}); no Clerk keys are set`,
  };
};

let announced = false;

/**
 * Say which provider is running, once.
 *
 * The same reason `metrics.sink_selected` and `auth.adapter_selected` exist:
 * which adapter is live should be a fact in the log rather than something
 * inferred from behaviour during an incident.
 */
const announce = (choice: ProviderChoice): void => {
  if (announced) return;
  announced = true;
  // A plain line rather than the structured logger: this process is Next.js, it
  // does not carry `@aios/application`'s logger, and inventing a second envelope
  // shape would be worse than one honest line.
  console.log(
    JSON.stringify({
      severity: "INFO",
      operationalLogName: "web.session_provider_selected",
      message: "The web session provider was selected.",
      attributes: { "web.session_provider": choice.reason },
    }),
  );
};

const devSession = async (): Promise<WebSession | null> => {
  const store = await cookies();
  const subject = store.get(DEV_SUBJECT_COOKIE)?.value;
  const user = DEV_USERS.find((u) => u.subject === subject);

  // No cookie is *signed out*, not "fall back to the first identity". The old
  // `currentUser()` fell back, which is why there was no unauthenticated state
  // to protect anything against.
  if (user === undefined) return null;

  return {
    provider: "dev",
    subject: user.subject,
    displayName: user.label,
    email: null,
    // No token: the API's development adapter reads `x-dev-subject`, and
    // inventing a fake bearer token here would make the two paths differ in a
    // way that hides which one is running.
    token: async () => null,
  };
};

const clerkSession = async (): Promise<WebSession | null> => {
  // Imported dynamically so a development process never loads Clerk's
  // middleware-dependent helpers, which throw when `clerkMiddleware` has not
  // run — and it has not, because `middleware.ts` only registers it when the
  // keys are present.
  const { auth, currentUser } = await import("@clerk/nextjs/server");
  const { userId, getToken } = await auth();
  if (userId === null || userId === undefined) return null;

  const user = await currentUser();
  const email = user?.primaryEmailAddress?.emailAddress ?? null;

  return {
    provider: "clerk",
    subject: userId,
    displayName: user?.fullName ?? user?.username ?? userId,
    email,
    // Minted per call. Clerk session tokens are short-lived by design; caching
    // one would produce a client that works for a minute and then 401s.
    token: async () => (await getToken()) ?? null,
  };
};

/**
 * The person making this request, or null.
 *
 * Null is an ordinary answer — a visitor who has not signed in — and every
 * caller must handle it. `requireSession` is the shorthand for "not here".
 */
export const getSession = async (): Promise<WebSession | null> => {
  const choice = chooseSessionProvider(process.env);
  announce(choice);
  return choice.provider === "clerk" ? clerkSession() : devSession();
};

/**
 * The signed-in person, or a redirect to sign in.
 *
 * Called by every page **and every server action**. The actions are the part
 * that matters and the part that is easy to miss: a server action is a POST
 * endpoint that anyone who knows its identifier can call directly, without ever
 * rendering the page that contains its form. Gating only the pages would leave
 * every command reachable by an unauthenticated caller.
 *
 * The API would still refuse those calls — it authenticates independently, and
 * this client is not a security boundary for it — but a client that forwards
 * unauthenticated commands is one configuration change away from being one.
 */
export const requireSession = async (): Promise<WebSession> => {
  const session = await getSession();
  if (session === null) redirect("/sign-in");
  return session;
};

/**
 * Where to send someone who needs to sign in.
 *
 * With Clerk, its hosted page: this client renders no Clerk components and holds
 * no Clerk state, which keeps "the browser never talks to the API directly"
 * true of authentication as well.
 */
export const signInDestination = (env: SessionEnvironment): string | null => {
  const url = env["NEXT_PUBLIC_CLERK_SIGN_IN_URL"] ?? "";
  return url === "" ? null : url;
};

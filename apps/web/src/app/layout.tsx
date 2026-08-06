import type { ReactNode } from "react";

import { api, currentOrganization, myOrganizations } from "../lib/api";
import { getSession } from "../lib/session";
import { signOut, switchOrganization } from "./actions";
import "./globals.css";

export const metadata = {
  title: "AIOS",
  description: "Work, Decision, and human-approved organizational Memory",
};

/**
 * Nothing here is prerenderable, and saying so is a correctness statement
 * rather than a build setting.
 *
 * Every page in this client renders one person's view, fetched with that
 * person's credential. A statically rendered page would be one user's data
 * served to the next — and `next build` found this the honest way: it runs
 * under `NODE_ENV=production`, tried to prerender `/me`, and hit
 * `chooseSessionProvider`'s refusal. The refusal was right; prerendering a
 * page that requires a session is what was wrong.
 *
 * It was accidentally true before A1, because every page happened to read a
 * cookie. Depending on that is depending on an implementation detail of a
 * function nobody was thinking about.
 */
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: ReactNode }) {
  // `getSession`, not `requireSession`. The layout wraps the sign-in page too,
  // and a redirect from here would send an unauthenticated visitor to a page
  // that immediately re-rendered this layout and redirected again. Pages and
  // server actions do the gating; the layout only decides what to draw.
  const session = await getSession();

  // Which Organizations this person may act in, and which they are in now. Both
  // swallowed on failure for the same reason as the count below: an unreachable
  // API must not blank the whole layout.
  let organizations: readonly Awaited<ReturnType<typeof myOrganizations>>[number][] = [];
  let organization: Awaited<ReturnType<typeof currentOrganization>> = null;
  if (session !== null) {
    try {
      organizations = await myOrganizations(session);
      organization = await currentOrganization(session);
    } catch {
      organizations = [];
    }
  }

  // Read here rather than on the notifications page so the count is visible from
  // anywhere. Swallowed on failure: an unreachable API must not blank the whole
  // layout, and the pages below report the error themselves. Skipped entirely
  // when there is no Organization — every scoped route would refuse.
  let unacknowledged = 0;
  if (session !== null && organization !== null) {
    try {
      unacknowledged = (await api.listNotifications(session)).unacknowledged;
    } catch {
      unacknowledged = 0;
    }
  }

  return (
    <html lang="en">
      <body>
        <header className="bar">
          <div className="inner">
            <span className="brand">
              <a href="/">AIOS</a>
            </span>
            {session !== null && (
              <>
                <a className="small" href="/me">
                  My workspace
                </a>
                <a className="small" href="/notifications">
                  Notifications{unacknowledged > 0 ? ` (${unacknowledged})` : ""}
                </a>
                <a className="small" href="/members">
                  Members
                </a>
                <a className="small" href="/settings">
                  Settings
                </a>
                <a className="small" href="/join">
                  Join
                </a>
              </>
            )}
            <span className="spacer" />

            {/*
              Organization selection. The API scopes every route by
              `X-Organization-Id`, and until `GET /organizations` existed nothing
              could tell a client what to put there — so this was an environment
              variable and a person could only ever see one Organization.
            */}
            {session !== null && organizations.length > 0 && (
              <form action={switchOrganization} className="row">
                <span className="small muted">in</span>
                <select
                  name="organizationId"
                  defaultValue={organization?.organizationId}
                  style={{ margin: 0, width: "auto" }}
                >
                  {organizations.map((o) => (
                    <option key={o.organizationId} value={o.organizationId}>
                      {o.name}
                      {o.status === "Active" ? "" : ` (${o.status})`}
                    </option>
                  ))}
                </select>
                <button className="secondary" type="submit">
                  Go
                </button>
              </form>
            )}

            {/*
              Who is signed in, and how to stop being them.

              This was an identity switcher — a select on every page that made
              you somebody else without ever signing in or out. Changing identity
              now means signing out and back in, which is the same number of
              clicks and a true statement about what happened.
            */}
            {session === null ? (
              <a className="small" href="/sign-in">
                Sign in
              </a>
            ) : (
              <form action={signOut} className="row">
                <span className="small muted">signed in as</span>
                <span className="small">
                  <strong>{session.displayName}</strong>
                </span>
                <button className="secondary" type="submit">
                  Sign out
                </button>
              </form>
            )}
          </div>
        </header>

        <main className="wrap">{children}</main>
      </body>
    </html>
  );
}

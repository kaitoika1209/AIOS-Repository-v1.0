import type { ReactNode } from "react";

import { DEV_USERS, api, currentOrganization, currentUser, myOrganizations } from "../lib/api";
import { switchOrganization, switchUser } from "./actions";
import "./globals.css";

export const metadata = {
  title: "AIOS",
  description: "Work, Decision, and human-approved organizational Memory",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();

  // Which Organizations this person may act in, and which they are in now. Both
  // swallowed on failure for the same reason as the count below: an unreachable
  // API must not blank the whole layout.
  let organizations: readonly Awaited<ReturnType<typeof myOrganizations>>[number][] = [];
  let organization: Awaited<ReturnType<typeof currentOrganization>> = null;
  try {
    organizations = await myOrganizations(user.subject);
    organization = await currentOrganization(user.subject);
  } catch {
    organizations = [];
  }

  // Read here rather than on the notifications page so the count is visible from
  // anywhere. Swallowed on failure: an unreachable API must not blank the whole
  // layout, and the pages below report the error themselves. Skipped entirely
  // when there is no Organization — every scoped route would refuse.
  let unacknowledged = 0;
  if (organization !== null) {
    try {
      unacknowledged = (await api.listNotifications(user.subject)).unacknowledged;
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
            <span className="spacer" />

            {/*
              Organization selection. The API scopes every route by
              `X-Organization-Id`, and until `GET /organizations` existed nothing
              could tell a client what to put there — so this was an environment
              variable and a person could only ever see one Organization.
            */}
            {organizations.length > 0 && (
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
              Development identity switcher. Authority differs by role — a
              Member cannot approve a Decision — so seeing both sides requires
              acting as both people. Clerk replaces this.
            */}
            <form action={switchUser} className="row">
              <span className="small muted">acting as</span>
              <select name="subject" defaultValue={user.subject} style={{ margin: 0, width: "auto" }}>
                {DEV_USERS.map((u) => (
                  <option key={u.subject} value={u.subject}>
                    {u.label} ({u.seeded ? "seeded Owner" : u.expectedRole})
                  </option>
                ))}
              </select>
              <button className="secondary" type="submit">
                Switch
              </button>
            </form>
          </div>
        </header>

        <main className="wrap">{children}</main>
      </body>
    </html>
  );
}

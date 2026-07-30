import type { ReactNode } from "react";

import { DEV_USERS, api, currentUser } from "../lib/api";
import { switchUser } from "./actions";
import "./globals.css";

export const metadata = {
  title: "AIOS",
  description: "Work, Decision, and human-approved organizational Memory",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();

  // Read here rather than on the notifications page so the count is visible from
  // anywhere. Swallowed on failure: an unreachable API must not blank the whole
  // layout, and the pages below report the error themselves.
  let unacknowledged = 0;
  try {
    unacknowledged = (await api.listNotifications(user.subject)).unacknowledged;
  } catch {
    unacknowledged = 0;
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
            <a className="small" href="/join">
              Join
            </a>
            <span className="spacer" />

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

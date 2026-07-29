import type { ReactNode } from "react";

import { DEV_USERS, currentUser } from "../lib/api";
import { switchUser } from "./actions";
import "./globals.css";

export const metadata = {
  title: "AIOS",
  description: "Work, Decision, and human-approved organizational Memory",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();

  return (
    <html lang="en">
      <body>
        <header className="bar">
          <div className="inner">
            <span className="brand">
              <a href="/">AIOS</a>
            </span>
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

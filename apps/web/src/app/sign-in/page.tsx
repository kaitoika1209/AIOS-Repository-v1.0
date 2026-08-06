import { redirect } from "next/navigation";

import {
  DEV_USERS,
  chooseSessionProvider,
  getSession,
  signInDestination,
} from "../../lib/session";
import { signInAsDevelopmentUser } from "../actions";

/**
 * Sign in.
 *
 * There was no such page. The client had a switcher in the global header that
 * changed who you were on any page, with no signed-out state to arrive from —
 * which is why every route was reachable by everyone and nothing needed
 * protecting.
 *
 * Two providers, one page. With Clerk configured this is a redirect to Clerk's
 * hosted sign-in: the client renders no Clerk components and holds no Clerk
 * state, so "the browser never talks to the API directly" stays true of
 * authentication too. Without it — development only, and `chooseSessionProvider`
 * throws anywhere else — it is the identity list, which is the old switcher
 * relocated to the one place a switcher belongs.
 */
export default async function SignInPage() {
  // Already signed in: nothing to do here, and leaving the page reachable would
  // make "sign in" look like a way to become someone else, which is what the
  // header switcher used to be.
  if ((await getSession()) !== null) redirect("/");

  const choice = chooseSessionProvider(process.env);

  if (choice.provider === "clerk") {
    const destination = signInDestination(process.env);
    if (destination !== null) redirect(destination);

    return (
      <section className="card">
        <h1>Sign in</h1>
        <p className="small">
          Clerk is configured but <code>NEXT_PUBLIC_CLERK_SIGN_IN_URL</code> is not
          set, so there is nowhere to send you. This is a deployment
          misconfiguration rather than something you can fix from here.
        </p>
      </section>
    );
  }

  return (
    <section className="card">
      <h1>Sign in</h1>
      <p className="small muted">{choice.reason}</p>
      <p className="small">
        Authority differs by role — a Member cannot approve a Decision — so
        seeing both sides means signing in as more than one person. Only Olivia
        is seeded; the others have no Membership until she invites them and they
        accept, so signing in as them first gives “not authenticated”, which is
        the invitation flow being real rather than a gap.
      </p>

      {DEV_USERS.map((user) => (
        <form key={user.subject} action={signInAsDevelopmentUser} className="row">
          <input type="hidden" name="subject" value={user.subject} />
          <button type="submit">
            Sign in as {user.label} ({user.seeded ? "seeded Owner" : user.expectedRole})
          </button>
        </form>
      ))}
    </section>
  );
}

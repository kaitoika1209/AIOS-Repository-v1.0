import { requireSession } from "../../lib/session";
import { acceptInvitation } from "../actions";
import { ActionForm } from "../ui";

/**
 * Invitation acceptance.
 *
 * The only page that works without a Membership, because accepting is how a
 * Membership begins. Switch identity first: the invitation is claimed by
 * whoever is signed in when it is accepted.
 */
export default async function Join({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const session = await requireSession();
  const { token } = await searchParams;

  return (
    <>
      <h1>Join an Organization</h1>

      <div className="card">
        <h2>Accept an invitation</h2>
        <p className="hint">
          You are signed in as <strong>{session.displayName}</strong>. Accepting
          binds this identity to the Membership the token names, with the roles
          the inviter chose — sign out first if that is not who you mean to be.
        </p>
        <p className="hint">
          The Organization comes from the token, not from this page. There is
          nothing here to choose.
        </p>
        <ActionForm action={acceptInvitation} submitLabel="Accept">
          <input
            type="text"
            name="token"
            defaultValue={token ?? ""}
            placeholder="Invitation token"
          />
        </ActionForm>
      </div>

      <p className="small muted">
        Once accepted, <a href="/">Work</a> and <a href="/members">Members</a>{" "}
        become reachable as the new Member.
      </p>
    </>
  );
}

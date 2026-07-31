import { ApiError, api, currentUser } from "../../lib/api";
import {
  assignRole,
  inviteMember,
  lastIssuedInvitation,
  reactivateMember,
  resendInvitation,
  revokeInvitation,
  revokeMember,
  revokeRole,
  suspendMember,
} from "../actions";
import { ActionForm } from "../ui";

/**
 * Roles a Member may be given from here.
 *
 * `OrganizationOwner` is absent, and its absence is the point: only an Owner may
 * grant it (ADR-0018), so offering it to everyone would produce a control that
 * is refused for most of the people who can see it. Ownership is handed over
 * deliberately, not from a dropdown beside "Reviewer".
 */
const GRANTABLE_ROLES = ["OrganizationAdmin", "Member", "Reviewer"] as const;

const statusClass = (status: string): string =>
  status === "Active" ? "badge ok"
  : status === "Invited" ? "badge warn"
  : status === "Revoked" ? "badge bad"
  : "badge";

export default async function Members() {
  const user = await currentUser();
  const issued = await lastIssuedInvitation();

  let items: Awaited<ReturnType<typeof api.listMembers>>["items"] = [];
  let loadError: string | null = null;

  try {
    items = (await api.listMembers(user.subject)).items;
  } catch (error) {
    loadError =
      error instanceof ApiError
        ? `${error.code} — ${error.message}`
        : "The API is not reachable. Start it with `pnpm --filter @aios/api dev`.";
  }

  return (
    <>
      <h1>Members</h1>

      {loadError && (
        <div className="card">
          <p className="error">{loadError}</p>
          <p className="hint">
            Acting as someone with no Membership in this Organization resolves to
            no principal at all, so every route refuses. That is the invitation
            flow working: authority begins at acceptance, not at sign-in. Accept
            an invitation at <a href="/join">/join</a>, or switch back to Olivia.
          </p>
        </div>
      )}

      {issued && (
        <div className="card">
          <h2>Invitation issued</h2>
          <p className="hint">
            The token is shown once, here, because nothing delivers it yet — the{" "}
            <code>MembershipInvited</code> consumer that would send an email is
            not in this release. It is never stored: the database holds only its
            hash.
          </p>
          <p className="small">
            Sent to <strong>{issued.email}</strong>
          </p>
          <p>
            <a href={`/join?token=${encodeURIComponent(issued.token)}`}>
              Open the acceptance link
            </a>
          </p>
        </div>
      )}

      <div className="card">
        <h2>Invite someone</h2>
        <p className="hint">
          An invitation names the roles the person will hold. It cannot grant
          Owner — becoming an Owner is ownership assignment, which has no command
          in this release.
        </p>
        <p className="hint">
          Only an Owner or Admin may invite. The form is shown to everyone
          because the API is the authority on that, not this page: press it as a
          Member to watch it refuse.
        </p>
        <ActionForm action={inviteMember} submitLabel="Send invitation">
          <input type="email" name="email" placeholder="name@example.test" />
          <select name="role" defaultValue="Member">
            <option value="Member">Member</option>
            <option value="Reviewer">Reviewer</option>
            <option value="OrganizationAdmin">OrganizationAdmin</option>
            <option value="OrganizationOwner">
              OrganizationOwner (will be refused)
            </option>
          </select>
        </ActionForm>
      </div>

      <div className="card">
        <h2>Everyone in this Organization</h2>
        {items.length === 0 ? (
          <p className="muted small">Nobody yet.</p>
        ) : (
          <ul className="list">
            {items.map((member) => (
              <li key={member.membershipId}>
                <div className="row">
                  <strong>{member.displayName ?? member.email}</strong>
                  <span className={statusClass(member.status)}>{member.status}</span>
                  {member.roles.map((role) => (
                    <span className="badge" key={role}>
                      {role}
                    </span>
                  ))}
                </div>
                {member.status === "Invited" && (
                  <div className="small muted">
                    Invited {member.invitedAt?.slice(0, 10)}, expires{" "}
                    {member.invitationExpiresAt?.slice(0, 10)} — holds no
                    authority until accepted.
                  </div>
                )}
                {member.status === "Invited" && (
                  <div className="row">
                    <ActionForm
                      action={resendInvitation}
                      submitLabel="Resend"
                      variant="secondary"
                    >
                      <input
                        type="hidden"
                        name="membershipId"
                        value={member.membershipId}
                      />
                    </ActionForm>
                    <ActionForm
                      action={revokeInvitation}
                      submitLabel="Revoke"
                      variant="danger"
                    >
                      <input
                        type="hidden"
                        name="membershipId"
                        value={member.membershipId}
                      />
                      <input type="text" name="reason" placeholder="Reason" />
                    </ActionForm>
                  </div>
                )}

                {(member.status === "Active" || member.status === "Suspended") && (
                  <>
                    <div className="row">
                      {member.status === "Active" ? (
                        <ActionForm
                          action={suspendMember}
                          submitLabel="Suspend"
                          variant="secondary"
                        >
                          <input
                            type="hidden"
                            name="membershipId"
                            value={member.membershipId}
                          />
                          <input
                            type="text"
                            name="reason"
                            placeholder="Reason for suspending"
                          />
                        </ActionForm>
                      ) : (
                        <ActionForm
                          action={reactivateMember}
                          submitLabel="Reactivate"
                          variant="secondary"
                        >
                          <input
                            type="hidden"
                            name="membershipId"
                            value={member.membershipId}
                          />
                          <input
                            type="text"
                            name="reason"
                            placeholder="Reason for reactivating"
                          />
                        </ActionForm>
                      )}
                      <ActionForm
                        action={revokeMember}
                        submitLabel="Remove"
                        variant="danger"
                      >
                        <input
                          type="hidden"
                          name="membershipId"
                          value={member.membershipId}
                        />
                        <input
                          type="text"
                          name="reason"
                          placeholder="Reason for removing"
                        />
                      </ActionForm>
                    </div>

                    <div className="row">
                      <ActionForm
                        action={assignRole}
                        submitLabel="Grant role"
                        variant="secondary"
                      >
                        <input
                          type="hidden"
                          name="membershipId"
                          value={member.membershipId}
                        />
                        <select name="role" defaultValue="Reviewer">
                          {GRANTABLE_ROLES.filter(
                            (role) => !member.roles.includes(role),
                          ).map((role) => (
                            <option key={role} value={role}>
                              {role}
                            </option>
                          ))}
                        </select>
                      </ActionForm>
                      {member.roles.length > 0 && (
                        <ActionForm
                          action={revokeRole}
                          submitLabel="Withdraw role"
                          variant="secondary"
                        >
                          <input
                            type="hidden"
                            name="membershipId"
                            value={member.membershipId}
                          />
                          <select name="role" defaultValue={member.roles[0]}>
                            {member.roles.map((role) => (
                              <option key={role} value={role}>
                                {role}
                              </option>
                            ))}
                          </select>
                          <input
                            type="text"
                            name="reason"
                            placeholder="Reason for withdrawing"
                          />
                        </ActionForm>
                      )}
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

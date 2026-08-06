import { ApiError, api } from "../../lib/api";
import { requireSession } from "../../lib/session";
import {
  archiveOrganization,
  grantAssistance,
  reactivateOrganization,
  renameOrganization,
  revokeAssistance,
  suspendOrganization,
} from "../actions";
import { ActionForm } from "../ui";

/**
 * The Secretary's advisory operations, as the API declares them.
 *
 * Hard-coded rather than fetched, because there is no route that lists grants —
 * ADR-0019 deliberately does not promote one, since nothing consumed it. This
 * page is that consumer arriving, so the read becomes worth adding; until it
 * exists, the page offers both commands and lets the API answer.
 */
const ASSISTANCE_OPERATIONS = [
  {
    operation: "decision.draft_material",
    label: "Prepare Decision material",
    detail:
      "Lets the Secretary draft options and context for a Decision that is still a Draft. It cannot submit, approve, or reject one.",
  },
] as const;

const statusClass = (status: string): string =>
  status === "Active" ? "badge ok" : status === "Suspended" ? "badge warn" : "badge bad";

export default async function Settings() {
  const session = await requireSession();

  let organization: Awaited<ReturnType<typeof api.organization>> | null = null;
  let loadError: string | null = null;

  try {
    organization = await api.organization(session);
  } catch (error) {
    loadError =
      error instanceof ApiError
        ? `${error.code} — ${error.message}`
        : "The API is not reachable. Start it with `pnpm --filter @aios/api dev`.";
  }

  return (
    <>
      <h1>Organization settings</h1>

      {loadError && (
        <div className="card">
          <p className="error">{loadError}</p>
          <p className="hint">
            A Suspended or Archived Organization refuses this page too — the
            resolver declines to issue a principal for one, so every route
            answers <code>404</code>. Reactivation is the single exception, and
            it is below.
          </p>
          <div className="card">
            <h2>Reactivate</h2>
            <p className="muted small">
              The one command a suspended Organization still accepts. Only an
              Owner holds it.
            </p>
            <ActionForm action={reactivateOrganization} submitLabel="Reactivate">
              <input type="text" name="reason" placeholder="Reason" />
            </ActionForm>
          </div>
        </div>
      )}

      {organization && (
        <>
          <div className="card">
            <div className="row">
              <strong>{organization.name}</strong>
              <span className={statusClass(organization.status)}>
                {organization.status}
              </span>
            </div>
            <p className="muted small">
              Everything below is refused for anyone who does not hold the
              permission, and the refusal is shown rather than hidden.
            </p>
          </div>

          <div className="card">
            <h2>Name</h2>
            <ActionForm action={renameOrganization} submitLabel="Rename">
              <input
                type="text"
                name="name"
                defaultValue={organization.name}
                placeholder="Organization name"
              />
            </ActionForm>
          </div>

          <div className="card">
            <h2>Secretary</h2>
            <p className="muted small">
              What this Organization allows its Secretary to do. Every invocation
              is checked against an active grant, so withdrawing one stops the
              Secretary immediately.
            </p>
            {ASSISTANCE_OPERATIONS.map((op) => (
              <div key={op.operation}>
                <div className="row">
                  <strong>{op.label}</strong>
                  <code className="small">{op.operation}</code>
                </div>
                <p className="muted small">{op.detail}</p>
                <div className="row">
                  <ActionForm
                    action={grantAssistance}
                    submitLabel="Allow"
                    variant="secondary"
                  >
                    <input type="hidden" name="operation" value={op.operation} />
                  </ActionForm>
                  <ActionForm
                    action={revokeAssistance}
                    submitLabel="Withdraw"
                    variant="secondary"
                  >
                    <input type="hidden" name="operation" value={op.operation} />
                  </ActionForm>
                </div>
              </div>
            ))}
          </div>

          {/*
            Both of these take the Organization away from everyone in it, so both
            ask for the name to be retyped. Reactivation does not: putting an
            obstacle in front of recovery is the wrong place for one.
          */}
          <div className="card">
            <h2>Pause this Organization</h2>
            <p className="muted small">
              Suspending stops every request from every Member, including yours.
              Only an Owner can undo it, from this page.
            </p>
            <ActionForm action={suspendOrganization} submitLabel="Suspend" variant="danger">
              <input type="hidden" name="expectedName" value={organization.name} />
              <input type="text" name="reason" placeholder="Reason" />
              <input
                type="text"
                name="confirmName"
                placeholder={`Type "${organization.name}" to confirm`}
              />
            </ActionForm>
          </div>

          <div className="card">
            <h2>Archive this Organization</h2>
            <p className="muted small">
              Archival is permanent — an Archived Organization does not return to
              Active. It is refused while any Work is still in progress or
              waiting for a Decision.
            </p>
            <ActionForm action={archiveOrganization} submitLabel="Archive" variant="danger">
              <input type="hidden" name="expectedName" value={organization.name} />
              <input type="text" name="reason" placeholder="Reason" />
              <input
                type="text"
                name="confirmName"
                placeholder={`Type "${organization.name}" to confirm`}
              />
            </ActionForm>
          </div>
        </>
      )}
    </>
  );
}

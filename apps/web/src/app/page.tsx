import { ApiError, api, currentOrganization } from "../lib/api";
import { requireSession } from "../lib/session";
import { createOrganization, createWork } from "./actions";
import { ActionForm } from "./ui";

const statusClass = (status: string): string =>
  status === "Completed" ? "badge ok"
  : status === "WaitingForDecision" ? "badge warn"
  : status === "Cancelled" ? "badge bad"
  : "badge";

export default async function Home() {
  const session = await requireSession();

  // Asked before any scoped request, because someone who belongs to no
  // Organization has nothing to be shown and every scoped route would refuse
  // them. That is an ordinary state — a person who has signed in and not yet
  // been invited anywhere — and it needs an offer, not an error.
  const organization = await currentOrganization(session).catch(() => null);

  if (organization === null) {
    return (
      <>
        <h1>No Organization yet</h1>
        <div className="card">
          <p className="hint">
            You are signed in but hold no Membership anywhere. Either create an
            Organization — you become its first Owner — or{" "}
            <a href="/join">accept an invitation</a> to one that already exists.
          </p>
          <ActionForm action={createOrganization} submitLabel="Create Organization">
            <label htmlFor="new-organization-name">Name</label>
            <input id="new-organization-name" name="name" placeholder="Acme Product Team" />
          </ActionForm>
        </div>
      </>
    );
  }

  let items: Awaited<ReturnType<typeof api.listWork>>["items"] = [];
  let loadError: string | null = null;

  try {
    items = (await api.listWork(session)).items;
  } catch (error) {
    loadError =
      error instanceof ApiError
        ? `${error.code} — ${error.message}`
        : "The API is not reachable. Start it with `pnpm --filter @aios/api dev`.";
  }

  return (
    <>
      <h1>Work</h1>

      {loadError && (
        <div className="card">
          <p className="error">{loadError}</p>
          <p className="hint">
            If this says you are not authenticated, the identity you are acting
            as has no Membership here yet. Only the Owner is seeded; everyone
            else joins through <a href="/members">an invitation</a>. That is the
            boundary working — authority begins at acceptance.
          </p>
        </div>
      )}

      <div className="card">
        <h2>Create Work</h2>
        {organization.roles.includes("Reviewer") && organization.roles.length === 1 ? (
          <p className="hint">
            You hold Reviewer only, and a Reviewer holds review authority — the
            API will refuse this. The roles here are the ones your Membership
            actually carries, read from <code>GET /organizations</code>, rather
            than a guess about who you are.
          </p>
        ) : null}
        <ActionForm action={createWork} submitLabel="Create">
          <input type="text" name="title" placeholder="What needs to happen?" />
        </ActionForm>
      </div>

      <div className="card">
        <h2>All Work</h2>
        {items.length === 0 ? (
          <p className="muted small">Nothing yet.</p>
        ) : (
          <ul className="list">
            {items.map((work) => (
              <li key={work.workId}>
                <div className="row">
                  <a href={`/works/${work.workId}`}>{work.title}</a>
                  <span className={statusClass(work.status)}>{work.status}</span>
                  {work.completionGate !== "NotRequired" && (
                    <span className="badge">gate: {work.completionGate}</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

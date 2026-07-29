import { ApiError, api, currentUser } from "../lib/api";
import { createWork } from "./actions";
import { ActionForm } from "./ui";

const statusClass = (status: string): string =>
  status === "Completed" ? "badge ok"
  : status === "WaitingForDecision" ? "badge warn"
  : status === "Cancelled" ? "badge bad"
  : "badge";

export default async function Home() {
  const user = await currentUser();

  let items: Awaited<ReturnType<typeof api.listWork>>["items"] = [];
  let loadError: string | null = null;

  try {
    items = (await api.listWork(user.subject)).items;
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
        {user.expectedRole === "Reviewer" ? (
          <p className="hint">
            Raj joins as a Reviewer, and a Reviewer holds review authority only —
            creating Work is denied. Switch to Olivia or Alice to create one, or
            press the button to see the API refuse it.
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

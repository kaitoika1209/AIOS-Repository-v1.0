import { notFound } from "next/navigation";

import { ApiError, api, currentUser } from "../../../lib/api";
import {
  approveDecision,
  approveMemory,
  completeWork,
  editMemory,
  reopenMemory,
  rejectDecision,
  rejectMemory,
  requestDecision,
  startRevision,
  startWork,
  submitMemory,
} from "../../actions";
import { ActionForm } from "../../ui";

const gateLabel: Record<string, string> = {
  NotRequired: "No approval required",
  Pending: "Waiting on a Decision",
  Satisfied: "Approved — completion permitted",
  Unsatisfied: "Rejected — completion blocked",
};

export default async function WorkPage({
  params,
}: {
  params: Promise<{ workId: string }>;
}) {
  const { workId } = await params;
  const user = await currentUser();

  let work: Awaited<ReturnType<typeof api.getWork>>;
  try {
    work = await api.getWork(user.subject, workId);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

  const decisions = (await api.listDecisionsForWork(user.subject, workId)).items;
  const memory = (await api.memoryForWork(user.subject, workId)).memory;
  const openDecision = decisions.find((d) => d.status === "InReview");
  const rejected = decisions.find((d) => d.status === "Rejected");

  return (
    <>
      <p className="small muted">
        <a href="/">← All Work</a>
      </p>
      <h1>{work.title}</h1>

      <div className="card">
        <div className="row">
          <span className="badge">{work.status}</span>
          <span className="badge">{gateLabel[work.completionGate] ?? work.completionGate}</span>
          <span className="badge">v{work.version}</span>
        </div>
        {work.completionSummary && (
          <p className="small" style={{ marginBottom: 0 }}>
            <strong>Outcome:</strong> {work.completionSummary}
          </p>
        )}
      </div>

      {work.status === "Draft" && (
        <div className="card">
          <h2>Start</h2>
          <ActionForm action={startWork} submitLabel="Start Work">
            <input type="hidden" name="workId" value={work.workId} />
          </ActionForm>
        </div>
      )}

      {work.status === "InProgress" && (
        <>
          <div className="card">
            <h2>Request a blocking Decision</h2>
            <p className="hint">
              Submitting a Decision moves this Work to <em>WaitingForDecision</em> in
              the same transaction, so it can never wait on a Decision that was
              never submitted.
            </p>
            <ActionForm action={requestDecision} submitLabel="Create and submit">
              <input type="hidden" name="workId" value={work.workId} />
              <input type="text" name="question" placeholder="What must be decided?" />
              <textarea name="options" placeholder={"One option per line\nShip on Friday\nDefer to next week"} />
            </ActionForm>
          </div>

          <div className="card">
            <h2>Complete</h2>
            {work.completionGate === "Unsatisfied" && (
              <p className="hint">
                The last Decision was rejected, so completion is refused until a new
                one is approved. Press the button to see the API say so.
              </p>
            )}
            {work.completionGate === "Satisfied" && (
              <p className="hint">
                A Decision was approved. Completion is still an explicit human
                action — approval never completes Work by itself.
              </p>
            )}
            <ActionForm action={completeWork} submitLabel="Complete Work">
              <input type="hidden" name="workId" value={work.workId} />
              <input type="text" name="completionSummary" placeholder="What was the outcome?" />
            </ActionForm>
          </div>
        </>
      )}

      {work.status === "WaitingForDecision" && !openDecision && (
        <div className="card">
          <p className="hint">
            The Decision has been resolved. The outcome reaches this Work
            asynchronously through the Outbox — reload in a moment.
          </p>
        </div>
      )}

      {openDecision && (
        <div className="card">
          <h2>Decision under review</h2>
          <p style={{ marginTop: 0 }}>{openDecision.question}</p>

          {user.role === "Reviewer" ? (
            <>
              <h3>Approve</h3>
              <ActionForm action={approveDecision} submitLabel="Approve">
                <input type="hidden" name="workId" value={work.workId} />
                <input type="hidden" name="decisionId" value={openDecision.decisionId} />
                <select name="selectedOptionId" defaultValue={openDecision.options[0]?.optionId}>
                  {openDecision.options.map((option) => (
                    <option key={option.optionId} value={option.optionId}>
                      {option.summary}
                    </option>
                  ))}
                </select>
                <input type="text" name="rationale" placeholder="Why?" />
              </ActionForm>

              <h3 style={{ marginTop: "1.2rem" }}>Reject</h3>
              <ActionForm action={rejectDecision} submitLabel="Reject" variant="danger">
                <input type="hidden" name="workId" value={work.workId} />
                <input type="hidden" name="decisionId" value={openDecision.decisionId} />
                <input type="text" name="rationale" placeholder="Why not?" />
              </ActionForm>
            </>
          ) : (
            <div className="hint">
              <p style={{ marginTop: 0 }}>
                Only a Reviewer may approve or reject. Switch to Raj to review this —
                or press Approve to watch the API deny it.
              </p>
              <ActionForm action={approveDecision} submitLabel="Approve anyway" variant="secondary">
                <input type="hidden" name="workId" value={work.workId} />
                <input type="hidden" name="decisionId" value={openDecision.decisionId} />
                <input type="hidden" name="selectedOptionId" value={openDecision.options[0]?.optionId ?? ""} />
                <input type="hidden" name="rationale" value="Attempted by a Member" />
              </ActionForm>
            </div>
          )}
        </div>
      )}

      {rejected && (
        <div className="card">
          <h2>Start a new revision</h2>
          <p className="hint">
            Revision {rejected.revisionNumber} was rejected. A new revision copies
            its content forward; the rejected one stays as evidence and is never
            rewritten.
          </p>
          <ActionForm action={startRevision} submitLabel="Start revision" variant="secondary">
            <input type="hidden" name="workId" value={work.workId} />
            <input type="hidden" name="decisionId" value={rejected.decisionId} />
          </ActionForm>
        </div>
      )}

      {work.status === "Completed" && memory === null && (
        <div className="card">
          <h2>Memory</h2>
          <p className="hint">
            Completing this Work durably requested a Memory draft. Generation runs
            asynchronously — reload in a moment.
          </p>
        </div>
      )}

      {memory && (
        <div className="card">
          <h2>Memory</h2>
          <div className="row" style={{ marginBottom: ".8rem" }}>
            <span className="badge">{memory.status}</span>
            <span className="badge">rev {memory.revisionNumber}</span>
            <span className="badge">
              drafted by {memory.authoredBy === "AI" ? "the Secretary" : "a human"}
            </span>
          </div>

          <h3>Summary</h3>
          <p style={{ marginTop: 0 }}>{memory.summary}</p>

          <details>
            <summary className="small muted" style={{ cursor: "pointer" }}>
              Full draft
            </summary>
            <pre
              className="small"
              style={{ whiteSpace: "pre-wrap", marginTop: ".6rem" }}
            >
              {memory.content}
            </pre>
          </details>

          {memory.status === "Generated" && (
            <>
              <h3 style={{ marginTop: "1.2rem" }}>Correct the draft</h3>
              <p className="hint">
                The Secretary drafted this. A human corrects it before review —
                AI proposes, humans decide.
              </p>
              <ActionForm action={editMemory} submitLabel="Save correction" variant="secondary">
                <input type="hidden" name="workId" value={work.workId} />
                <input type="hidden" name="memoryId" value={memory.memoryId} />
                <textarea name="summary" defaultValue={memory.summary} />
              </ActionForm>

              <h3 style={{ marginTop: "1.2rem" }}>Submit for review</h3>
              <ActionForm action={submitMemory} submitLabel="Submit for review">
                <input type="hidden" name="workId" value={work.workId} />
                <input type="hidden" name="memoryId" value={memory.memoryId} />
              </ActionForm>
            </>
          )}

          {memory.status === "InReview" && (
            <>
              {user.role === "Member" ? (
                <p className="hint">
                  Only a Reviewer or the Owner may approve. Switch to Raj.
                </p>
              ) : null}
              <h3 style={{ marginTop: "1.2rem" }}>Approve</h3>
              <ActionForm action={approveMemory} submitLabel="Approve Memory">
                <input type="hidden" name="workId" value={work.workId} />
                <input type="hidden" name="memoryId" value={memory.memoryId} />
                <input type="text" name="note" placeholder="Anything to note?" />
              </ActionForm>

              <h3 style={{ marginTop: "1.2rem" }}>Reject</h3>
              <ActionForm action={rejectMemory} submitLabel="Reject" variant="danger">
                <input type="hidden" name="workId" value={work.workId} />
                <input type="hidden" name="memoryId" value={memory.memoryId} />
                <input type="text" name="note" placeholder="What is missing?" />
              </ActionForm>
            </>
          )}

          {memory.status === "Rejected" && (
            <>
              <h3 style={{ marginTop: "1.2rem" }}>Reopen for revision</h3>
              <p className="hint">
                Reopening creates a new revision. The rejected one stays as review
                evidence. Only the Owner may reopen.
              </p>
              <ActionForm action={reopenMemory} submitLabel="Reopen" variant="secondary">
                <input type="hidden" name="workId" value={work.workId} />
                <input type="hidden" name="memoryId" value={memory.memoryId} />
              </ActionForm>
            </>
          )}

          {memory.status === "Approved" && (
            <p className="hint">
              This Memory is the organization&apos;s record of the Work. It is
              immutable — and it is not Knowledge.
            </p>
          )}

          {memory.reviewHistory.length > 0 && (
            <>
              <h3 style={{ marginTop: "1.2rem" }}>Review history</h3>
              <ul className="list small muted">
                {memory.reviewHistory.map((r) => (
                  <li key={r.revisionNumber}>
                    rev {r.revisionNumber}: {r.outcome}
                    {r.note ? ` — ${r.note}` : ""}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {decisions.length > 0 && (
        <div className="card">
          <h2>Decision history</h2>
          <ul className="list">
            {decisions.map((decision) => (
              <li key={decision.decisionId}>
                <div className="row">
                  <strong>{decision.question}</strong>
                  <span className="badge">{decision.status}</span>
                  <span className="badge">rev {decision.revisionNumber}</span>
                </div>
                {decision.reviewHistory.length > 0 && (
                  <ul className="list small muted" style={{ marginTop: ".4rem" }}>
                    {decision.reviewHistory.map((review) => (
                      <li key={`${decision.decisionId}-${review.revisionNumber}`}>
                        rev {review.revisionNumber}: {review.outcome} — {review.rationale}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

import { ApiError, api, currentUser } from "../../lib/api";

/**
 * The Personal Workspace.
 *
 * `mvp.md` describes it as "a personalized view for a human Member" and is
 * explicit that it "is not a separate domain or ownership boundary" — so every
 * section below is a filter over Organization-owned data the caller can already
 * read, not a private store.
 */
export default async function PersonalWorkspace() {
  const user = await currentUser();

  let loadError: string | null = null;
  let membershipId = "";
  let roles: string[] = [];
  let work: Awaited<ReturnType<typeof api.listWork>>["items"] = [];
  let memories: Awaited<ReturnType<typeof api.listMemories>>["items"] = [];
  let notifications = 0;

  try {
    const [me, workList, memoryList, notificationList] = await Promise.all([
      api.me(user.subject),
      api.listWork(user.subject),
      api.listMemories(user.subject),
      api.listNotifications(user.subject),
    ]);
    membershipId = me.membershipId;
    roles = me.roles;
    work = workList.items;
    memories = memoryList.items;
    notifications = notificationList.unacknowledged;
  } catch (error) {
    loadError =
      error instanceof ApiError
        ? `${error.code} — ${error.message}`
        : "The API is not reachable.";
  }

  const assigned = work.filter((w) => w.assigneeMembershipId === membershipId);
  // Work that cannot progress until a human resolves its Decision. The gate is
  // the Work's own record of that, so no Decision query is needed.
  const blocked = work.filter((w) => w.blockedBy !== null);
  // Only a Reviewer can act on these, so the section is shown to whoever holds
  // the role rather than to everyone.
  const canReview = roles.includes("Reviewer") || roles.includes("OrganizationOwner");
  const awaitingMemoryReview = memories.filter((m) => m.status === "InReview");

  const section = (
    title: string,
    empty: string,
    rows: { key: string; href: string; label: string; badge: string }[],
  ) => (
    <div className="card">
      <h2>{title}</h2>
      {rows.length === 0 ? (
        <p className="muted small">{empty}</p>
      ) : (
        <ul className="list">
          {rows.map((row) => (
            <li key={row.key}>
              <div className="row">
                <a href={row.href}>{row.label}</a>
                <span className="badge">{row.badge}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <>
      <h1>My workspace</h1>
      <p className="muted small">
        A filtered view of Organization-owned data, not a private store. Items
        here remain owned by the Organization.
      </p>

      {loadError !== null && (
        <div className="card">
          <p className="error">{loadError}</p>
        </div>
      )}

      <div className="card">
        <h2>Needs your attention</h2>
        <p className="small">
          {notifications === 0 ? (
            "No unread notifications."
          ) : (
            <a href="/notifications">
              {notifications} unread notification{notifications === 1 ? "" : "s"}
            </a>
          )}
        </p>
      </div>

      {section(
        "Assigned to you",
        "Nothing is assigned to you.",
        assigned.map((w) => ({
          key: w.workId,
          href: `/works/${w.workId}`,
          label: w.title,
          badge: w.status,
        })),
      )}

      {section(
        "Waiting on a Decision",
        "No Work is blocked.",
        blocked.map((w) => ({
          key: w.workId,
          href: `/works/${w.workId}`,
          label: w.title,
          badge: `gate: ${w.completionGate}`,
        })),
      )}

      {canReview &&
        section(
          "Memory awaiting your review",
          "Nothing is waiting for review.",
          awaitingMemoryReview.map((m) => ({
            key: m.memoryId,
            href: `/works/${m.sourceWorkId}`,
            label: m.title,
            badge: m.status,
          })),
        )}
    </>
  );
}

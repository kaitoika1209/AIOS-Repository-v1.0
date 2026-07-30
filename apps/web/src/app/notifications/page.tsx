import { ApiError, api, currentUser } from "../../lib/api";
import { acknowledgeNotification } from "../actions";
import { ActionForm } from "../ui";

/** Where the notification points. There is no notification body to render. */
const linkFor = (subjectType: string, subjectId: string): string | null =>
  subjectType === "Work" ? `/works/${subjectId}` : null;

export default async function Notifications() {
  const user = await currentUser();

  let items: Awaited<ReturnType<typeof api.listNotifications>>["items"] = [];
  let loadError: string | null = null;

  try {
    items = (await api.listNotifications(user.subject)).items;
  } catch (error) {
    loadError =
      error instanceof ApiError
        ? error.message
        : "The API is unreachable. Is it running?";
  }

  return (
    <main>
      <h1>Notifications</h1>
      <p className="small muted">
        Projected from registered events. A notification points at the record it
        concerns rather than carrying a copy of it, so dismissing one loses
        nothing.
      </p>

      {loadError !== null && <p className="error">{loadError}</p>}

      {loadError === null && items.length === 0 && (
        <p className="small muted">
          Nothing needs your attention. Notifications appear when Work is
          assigned to you, when a Decision or Memory needs review, and when an
          outcome affects Work you took part in.
        </p>
      )}

      <ul className="list">
        {items.map((notification) => {
          const href = linkFor(notification.subjectType, notification.subjectId);
          return (
            <li key={notification.notificationId} className="row">
              <span
                className={
                  notification.acknowledgedAt === null ? "badge warn" : "badge"
                }
              >
                {notification.notificationType}
              </span>
              <span>
                {href === null ? (
                  notification.title
                ) : (
                  <a href={href}>{notification.title}</a>
                )}
              </span>
              <span className="small muted">
                {new Date(notification.occurredAt).toLocaleString()}
              </span>
              <span className="spacer" />
              {notification.acknowledgedAt === null && (
                <ActionForm
                  action={acknowledgeNotification}
                  submitLabel="Dismiss"
                  variant="secondary"
                >
                  <input
                    type="hidden"
                    name="notificationId"
                    value={notification.notificationId}
                  />
                </ActionForm>
              )}
            </li>
          );
        })}
      </ul>
    </main>
  );
}

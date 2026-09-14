import type { Notification } from './api'
import styles from './NotificationsView.module.css'

// Mobile-only for now — reached via MobileBottomBar.tsx's bell icon (see
// App.tsx's notificationsSelected). No back button here — MobileBottomBar
// now carries a persistent home button (alongside Playground/bell) as the
// one way back to the workspace from any view, so this view doesn't need
// its own return affordance. A standalone view (not a sheet), no app
// draft dependency, since notifications aren't scoped to whichever app
// happens to be selected.
//
// Backed by GET /console/notifications (see App.tsx's refreshNotifications)
// — onDismiss/onOpenAction call api.updateNotification under the hood (see
// App.tsx's dismissNotification/openNotificationAction).
//
// Both 'dismissed' and 'completed' notifications are filtered out here,
// not just 'dismissed' — completing the suggested action (e.g. actually
// sending UseCaseSheet's form, not just opening it — see App.tsx's
// completeUseCaseNotification) means the row's job is done, so it
// disappears the same way dismissing it would, rather than lingering with
// a "✓ Done" label the user then has to separately dismiss.
export function NotificationsView({
  notifications,
  onDismiss,
  onOpenAction,
}: {
  notifications: Notification[]
  onDismiss: (id: number) => void
  onOpenAction: (n: Notification) => void
}) {
  const pending = notifications.filter((n) => n.status === 'pending')

  return (
    <div className={styles.root}>
      <h1 className={styles.heading}>Notifications</h1>

      {pending.length === 0 ? (
        <p className={styles.empty}>You're all caught up.</p>
      ) : (
        <div className={styles.list}>
          {pending.map((n) => (
            <div key={n.id} className={styles.card}>
              <div className={styles.cardHeader}>
                <span className={styles.cardTitle}>{n.title}</span>
                {n.readAt === null && <span className={styles.unreadDot} title="Unread" />}
              </div>
              <p className={styles.cardBody}>{n.body}</p>
              <div className={styles.cardFooter}>
                {n.actionLabel ? (
                  <button type="button" className="text-btn" onClick={() => onOpenAction(n)}>
                    {n.actionLabel}
                  </button>
                ) : (
                  <span />
                )}
                <button
                  type="button"
                  className={styles.dismissBtn}
                  onClick={() => onDismiss(n.id)}
                  aria-label="Dismiss"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" width="14" height="14">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

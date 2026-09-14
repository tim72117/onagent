import styles from './MobileBottomBar.module.css'

// Mobile-only fixed bottom bar — three icon buttons: Home (clears
// App.tsx's view back to the workspace card stack — see onGoHome/
// selectHome), Playground (opens PlaygroundSheet.tsx, a full-screen
// sheet), and a notifications bell (switches App.tsx's view to
// 'notifications', a full view like App settings/Preview — not a sheet,
// since a notification list is content worth its own screen, not a
// transient overlay). Home exists specifically so any full-view screen
// (NotificationsView, App settings, ...) has a way back without each one
// growing its own back button — see NotificationsView.tsx's own comment.
// See MobileNav.tsx, which owns the Playground sheet's open state and
// renders this alongside it.
export function MobileBottomBar({
  onGoHome,
  onOpenPlayground,
  onOpenNotifications,
  unreadNotificationCount,
}: {
  onGoHome: () => void
  onOpenPlayground: () => void
  onOpenNotifications: () => void
  unreadNotificationCount: number
}) {
  return (
    <div className={styles.bar}>
      <button type="button" className={styles.iconBtn} onClick={onGoHome} aria-label="Home">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
          <path d="M3 11l9-8 9 8" />
          <path d="M5 10v10h14V10" />
        </svg>
      </button>

      <button type="button" className={styles.iconBtn} onClick={onOpenPlayground} aria-label="Playground">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
          <path d="M5 3l14 9-14 9V3z" />
        </svg>
      </button>

      <button
        type="button"
        className={styles.iconBtn}
        onClick={onOpenNotifications}
        aria-label={unreadNotificationCount > 0 ? `Notifications (${unreadNotificationCount} unread)` : 'Notifications'}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unreadNotificationCount > 0 && (
          <span className={styles.badge}>{unreadNotificationCount > 9 ? '9+' : unreadNotificationCount}</span>
        )}
      </button>
    </div>
  )
}

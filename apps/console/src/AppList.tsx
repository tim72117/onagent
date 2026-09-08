import type { AppSummary } from './api'
import styles from './SidebarNav.module.css'

// Shared between the desktop Sidebar and the mobile AppPickerSheet —
// the app-switching list itself is identical in both, only the surrounding
// chrome differs. Uses SidebarNav.module.css, the shared stylesheet for the
// "section heading + selectable row list" shape common to this,
// AgentNav.tsx, and ToolList.tsx.
export function AppList({
  summaries,
  activeAppId,
  onSelectApp,
  onAddApp,
}: {
  summaries: AppSummary[]
  activeAppId: string | null
  onSelectApp: (appId: string) => void
  // Omit entirely (not just hide the button) on the mobile flow — its only
  // "new app" entry point is the floating action button in MobileNav.tsx,
  // always visible regardless of whether the drawer is open.
  onAddApp?: () => void
}) {
  return (
    <div className={styles.section}>
      <div className={styles.sectionHead}>
        <span>Apps</span>
        {onAddApp && (
          <button type="button" className={styles.iconBtn} onClick={onAddApp} aria-label="New app">
            +
          </button>
        )}
      </div>
      <ul className={styles.list}>
        {summaries.map((s) => (
          <li key={s.appId}>
            <button
              type="button"
              className={`${styles.item}${s.appId === activeAppId ? ' ' + styles.active : ''}`}
              onClick={() => onSelectApp(s.appId)}
            >
              <span className={styles.itemLabel}>{s.appId}</span>
              {s.hasKey && !s.allowedOrigin && (
                <span className={`${styles.statusDot} ${styles.error}`} title="Key issued but no origin set — all connections blocked" />
              )}
              {s.hasKey && s.allowedOrigin && (
                <span className={`${styles.statusDot} ${styles.ok}`} title={`Accepting connections from ${s.allowedOrigin}`} />
              )}
            </button>
          </li>
        ))}
      </ul>
      {summaries.length === 0 && <p className="sidebar-empty">No apps yet</p>}
    </div>
  )
}

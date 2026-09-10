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
  rowClassName,
}: {
  summaries: AppSummary[]
  activeAppId: string | null
  onSelectApp: (appId: string) => void
  // Omit entirely (not just hide the button) on the mobile flow — its only
  // "new app" entry point is the floating action button in MobileNav.tsx,
  // always visible regardless of whether the drawer is open.
  onAddApp?: () => void
  // Extra class appended to each row button — AppPickerSheet.tsx passes
  // its own module's class here to size up SidebarNav.module.css's dense,
  // mouse-driven .item (padding: 6px 8px, font-size: 13px) into a real
  // touch target for its mobile-only sheet, without touching the shared
  // class other callers (desktop Sidebar) still use as-is. A `:global()`
  // rule in AppPickerSheet.module.css can't reach .item — CSS Modules
  // hashes SidebarNav.module.css's own class names, so there's no
  // unhashed `.item` selector for `:global()` to match against; passing
  // the caller's already-hashed class in is the only way to layer styles
  // from a different module onto this shared markup.
  rowClassName?: string
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
              className={`${styles.item}${rowClassName ? ' ' + rowClassName : ''}${s.appId === activeAppId ? ' ' + styles.active : ''}`}
              onClick={() => onSelectApp(s.appId)}
            >
              <span className={styles.itemLabel}>{s.appId}</span>
              {s.hasKey && s.allowedOrigins.length === 0 && (
                <span className={`${styles.statusDot} ${styles.error}`} title="Key issued but no origin set — all connections blocked" />
              )}
              {s.hasKey && s.allowedOrigins.length > 0 && (
                <span className={`${styles.statusDot} ${styles.ok}`} title={`Accepting connections from ${s.allowedOrigins.join(', ')}`} />
              )}
            </button>
          </li>
        ))}
      </ul>
      {summaries.length === 0 && <p className="sidebar-empty">No apps yet</p>}
    </div>
  )
}

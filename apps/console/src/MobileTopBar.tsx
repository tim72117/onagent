import { Avatar } from './Avatar'
import styles from './MobileTopBar.module.css'

// Mobile-only fixed top bar. Row 1: the active app name + chevron (opens
// AppPickerSheet.tsx) and the account avatar (opens AccountSheet.tsx) —
// app switching and account access, the two things a mobile visitor needs
// reachable from anywhere. There's no hamburger/drawer any more: it used
// to hold both of these (an AppList, then just the avatar once app
// switching moved to this bar's own picker), and once the avatar moved up
// here too the drawer had nothing left in it. Row 2: a settings icon on
// the right that opens App settings (AppSettingsView.tsx — key/origin for
// the active app), the mobile flow's entry point for it since the
// desktop-only Sidebar.tsx nav item isn't shown below 860px — shown only
// when at least one app exists (hasApps), same condition Sidebar.tsx uses
// for its own "App settings" nav item ((activeAppId || summaries.length >
// 0)): App settings needs SOME app to operate on (selectAppSettings picks
// a default one if none is active yet), but with zero apps at all there's
// nothing for it to default to. See MobileNav.tsx, which owns all the
// sheets this opens and renders this alongside them.
export function MobileTopBar({
  activeAppId,
  hasApps,
  userEmail,
  onOpenAppPicker,
  onOpenAccountSheet,
  onOpenAppSettings,
}: {
  activeAppId: string | null
  hasApps: boolean
  userEmail: string
  onOpenAppPicker: () => void
  onOpenAccountSheet: () => void
  onOpenAppSettings: () => void
}) {
  return (
    <div className={styles.bar}>
      <div className={styles.row}>
        <button type="button" className={styles.appPickerBtn} onClick={onOpenAppPicker}>
          <span className={`${styles.appPickerLabel}${activeAppId ? '' : ' ' + styles.placeholder}`}>
            {activeAppId ?? 'Select app'}
          </span>
          <svg
            className={styles.chevron}
            viewBox="0 0 24 24"
            fill="none"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            width="14"
            height="14"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>

        <button type="button" className={styles.avatarBtn} onClick={onOpenAccountSheet} aria-label="Account">
          <Avatar email={userEmail} size={32} />
        </button>
      </div>

      {/* This row always renders at its full height, even with hasApps
          false — only the button inside is conditional. App.module.css's
          .workspace has the bar's total height (80px = this row's 44px +
          the row above's 36px) baked into a margin-top/height calc();
          collapsing this row when there are no apps would leave that calc
          stale without a matching resync, for a state (zero apps at all)
          that's rare and transient. */}
      <div className={`${styles.row} ${styles.rowSecondary}`}>
        {hasApps && (
          <button
            type="button"
            className={styles.appSettingsBtn}
            onClick={onOpenAppSettings}
            aria-label="App settings"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        )}
      </div>
    </div>
  )
}

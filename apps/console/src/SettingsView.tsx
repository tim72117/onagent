import type { Quota } from './api'
import styles from './SettingsView.module.css'

// Account settings — desktop-only, reached by clicking the avatar/email in
// SidebarFooter.tsx (see App.tsx's settingsSelected), the same interaction
// as the mobile flow's avatar tap → AccountSheet.tsx. Sign-out lives here
// too — this is the sole surface for both plan/usage and sign-out, not
// just the former (mirroring AccountSheet.tsx keeping sign-out inside
// itself rather than as a separate button elsewhere). Account-level, not
// tied to any app draft — deliberately doesn't include the per-app key/
// origin controls (see AppSettingsView.tsx for those, a separate sidebar
// nav item): "App settings" and "Settings" (account) are two distinct
// concepts here, not one screen with two sections.
export function SettingsView({ quota, onLogout }: { quota: Quota | null; onLogout: () => void }) {
  return (
    <div className={styles.root}>
      <h1 className={styles.heading}>Settings</h1>

      {quota?.enabled ? (
        <div className={styles.planCard}>
          <div className={styles.planName}>{quota.planName} plan</div>
          <div className={styles.planUsage}>
            {quota.used} / {quota.limit} requests used this month
          </div>
          <div className={styles.planReset}>Resets {new Date(quota.periodEnd!).toLocaleDateString()}</div>
        </div>
      ) : (
        <p className={styles.empty}>No plan information available.</p>
      )}

      <button type="button" className={`text-btn danger ${styles.signOut}`} onClick={onLogout}>
        Sign out
      </button>
    </div>
  )
}

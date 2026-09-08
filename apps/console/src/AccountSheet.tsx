import type { Quota } from './api'
import { Avatar } from './Avatar'
import { BottomSheet } from './BottomSheet'
import styles from './AccountSheet.module.css'

// Mobile-only — reached by tapping the avatar in MobileTopBar.tsx. This
// IS the mobile flow's Settings surface (plan/usage + sign-out) — there's
// no separate mobile Settings nav item the way desktop has one (see
// App.tsx's settingsSelected / SettingsView.tsx); tapping the avatar is
// the sole entry point. Deliberately doesn't include "Delete app" (that
// stays desktop-only, in SidebarFooter.tsx) — a destructive action like
// that shouldn't be one tap away from an avatar icon on a touch device.
export function AccountSheet({
  open,
  onClose,
  quota,
  userEmail,
  onLogout,
}: {
  open: boolean
  onClose: () => void
  quota: Quota | null
  userEmail: string
  onLogout: () => void
}) {
  return (
    <BottomSheet open={open} onClose={onClose}>
      <div className={styles.header}>
        <Avatar email={userEmail} size={36} />
        <span className={styles.email}>{userEmail}</span>
      </div>

      {quota?.enabled && (
        <div className={styles.planRow}>
          <span className={styles.planName}>{quota.planName} plan</span>
          <span className={styles.planUsage}>
            {quota.used} / {quota.limit} requests used this month
          </span>
        </div>
      )}

      <button
        type="button"
        className={`${styles.actionRow} ${styles.danger}`}
        onClick={() => {
          onClose()
          onLogout()
        }}
      >
        Sign out
      </button>
    </BottomSheet>
  )
}

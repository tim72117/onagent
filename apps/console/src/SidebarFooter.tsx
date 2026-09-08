import { Avatar } from './Avatar'
import styles from './SidebarFooter.module.css'

// Desktop-only bottom account area — an avatar/email button that opens
// Settings (plan/usage + sign-out both live there now — see App.tsx's
// settingsSelected / SettingsView.tsx). Mirrors the mobile flow exactly:
// tapping the avatar is the sole way into Settings there too (see
// MobileTopBar.tsx's avatar button → AccountSheet.tsx, which likewise
// keeps sign-out inside itself rather than as a separate button), just
// without a bottom sheet — desktop swaps the workspace's main content
// instead. Delete app used to live here too — it's moved to
// the bottom of App settings instead (AppSettingsView.tsx /
// AppSettingsList.tsx), grouped with the app it acts on rather than
// alongside unrelated account controls.
export function SidebarFooter({
  userEmail,
  settingsSelected,
  onSelectSettings,
}: {
  userEmail: string
  settingsSelected: boolean
  onSelectSettings: () => void
}) {
  return (
    <div className={styles.footer}>
      <button
        type="button"
        className={`${styles.accountBtn}${settingsSelected ? ' ' + styles.active : ''}`}
        onClick={onSelectSettings}
      >
        <Avatar email={userEmail} size={24} />
        <span className={styles.accountEmail}>{userEmail}</span>
      </button>
    </div>
  )
}

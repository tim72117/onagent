import styles from './AppSettingsView.module.css'

// Per-app connection settings — key issuance and allowed origin. Reached
// via its own sidebar nav item (see Sidebar.tsx's App settings entry /
// App.tsx's appSettingsSelected), separate from the account-level
// SettingsView.tsx (plan/usage/sign-out) reached by clicking the avatar —
// "App settings" and "Settings" (account) are two distinct concepts, not
// one screen with two sections. Requires an app to be selected: unlike
// account Settings, there's nothing meaningful to show without one (see
// App.tsx's selectAppSettings, which no-ops if there's no draft and no
// apps to default to). Delete app lives at the bottom here (and in
// AppSettingsList.tsx's mobile equivalent) rather than in SidebarFooter.tsx
// — grouped with the app it acts on instead of alongside unrelated account
// controls.
export function AppSettingsView({
  appId,
  hasKey,
  onIssueKey,
  onRevokeKey,
  allowedOrigin,
  originDraft,
  onOriginDraftChange,
  originBusy,
  onSaveOrigin,
  onDeleteApp,
}: {
  appId: string
  hasKey: boolean
  onIssueKey: () => void
  onRevokeKey: () => void
  allowedOrigin: string | null
  originDraft: string
  onOriginDraftChange: (value: string) => void
  originBusy: boolean
  onSaveOrigin: (e: React.FormEvent) => void
  onDeleteApp: () => void
}) {
  return (
    <div className={styles.root}>
      <h1 className={styles.heading}>"{appId}" settings</h1>

      <div className={styles.keyRow}>
        <span className={styles.keyLabel}>{hasKey ? 'Key issued' : 'No key issued'}</span>
        <button type="button" className="text-btn" onClick={onIssueKey}>
          {hasKey ? 'Rotate key' : 'Issue key'}
        </button>
        {hasKey && (
          <button type="button" className="text-btn danger" onClick={onRevokeKey}>
            Revoke key
          </button>
        )}
      </div>

      <form className={styles.originRow} onSubmit={onSaveOrigin}>
        <span className="micro-label">Allowed origin</span>
        <input
          className={styles.originInput}
          placeholder="https://your-site.example.com"
          value={originDraft}
          onChange={(e) => onOriginDraftChange(e.target.value)}
        />
        <button
          type="submit"
          className="text-btn"
          disabled={originBusy || originDraft.trim() === (allowedOrigin ?? '')}
        >
          {originBusy ? 'Saving…' : 'Save origin'}
        </button>
        {!allowedOrigin && (
          <span className={styles.originWarning}>
            No origin set — every connection for this app is blocked until one is saved.
          </span>
        )}
      </form>

      <div className={styles.dangerZone}>
        <button type="button" className="text-btn danger" onClick={onDeleteApp}>
          Delete "{appId}"
        </button>
      </div>
    </div>
  )
}

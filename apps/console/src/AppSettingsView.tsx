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
  allowedOrigins,
  originDrafts,
  onOriginDraftsChange,
  newOriginDraft,
  onNewOriginDraftChange,
  originBusy,
  onSaveOrigins,
  maxPromptLengthDraft,
  onMaxPromptLengthDraftChange,
  maxPromptLengthBusy,
  onSaveMaxPromptLength,
  systemMaxPromptLength,
  onDeleteApp,
}: {
  appId: string
  hasKey: boolean
  onIssueKey: () => void
  onRevokeKey: () => void
  allowedOrigins: string[]
  originDrafts: string[]
  onOriginDraftsChange: (next: string[]) => void
  newOriginDraft: string
  onNewOriginDraftChange: (value: string) => void
  originBusy: boolean
  onSaveOrigins: (e: React.FormEvent) => void
  maxPromptLengthDraft: string
  onMaxPromptLengthDraftChange: (value: string) => void
  maxPromptLengthBusy: boolean
  onSaveMaxPromptLength: (e: React.FormEvent) => Promise<boolean>
  systemMaxPromptLength: number | null
  onDeleteApp: () => void
}) {
  function addDraft() {
    const trimmed = newOriginDraft.trim()
    if (!trimmed || originDrafts.includes(trimmed)) return
    onOriginDraftsChange([...originDrafts, trimmed])
    onNewOriginDraftChange('')
  }

  const dirty =
    originDrafts.length !== allowedOrigins.length || originDrafts.some((o, i) => o !== allowedOrigins[i])
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

      <form
        className={styles.originForm}
        onSubmit={(e) => {
          // A pending, not-yet-added value in the text field shouldn't be
          // silently dropped on Save — fold it in first.
          const trimmed = newOriginDraft.trim()
          if (trimmed && !originDrafts.includes(trimmed)) {
            onOriginDraftsChange([...originDrafts, trimmed])
            onNewOriginDraftChange('')
          }
          onSaveOrigins(e)
        }}
      >
        <span className="micro-label">Allowed origins</span>
        {originDrafts.length > 0 && (
          <ul className={styles.originList}>
            {originDrafts.map((origin) => (
              <li key={origin} className={styles.originListItem}>
                <span className={styles.originListItemText}>{origin}</span>
                <button
                  type="button"
                  className={styles.originRemoveBtn}
                  aria-label={`Remove ${origin}`}
                  onClick={() => onOriginDraftsChange(originDrafts.filter((o) => o !== origin))}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" width="12" height="12">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className={styles.originRow}>
          <input
            className={styles.originInput}
            placeholder="https://your-site.example.com"
            value={newOriginDraft}
            onChange={(e) => onNewOriginDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addDraft()
              }
            }}
          />
          <button type="button" className="text-btn" onClick={addDraft} disabled={!newOriginDraft.trim()}>
            Add
          </button>
          <button
            type="submit"
            className="text-btn"
            disabled={originBusy || (!dirty && !newOriginDraft.trim())}
          >
            {originBusy ? 'Saving…' : 'Save origins'}
          </button>
        </div>
        {allowedOrigins.length === 0 && (
          <span className={styles.originWarning}>
            No origin set — every connection for this app is blocked until one is saved.
          </span>
        )}
      </form>

      <form className={styles.originForm} onSubmit={onSaveMaxPromptLength}>
        <span className="micro-label">Max prompt length</span>
        <div className={styles.originRow}>
          <input
            className={styles.originInput}
            type="number"
            min={1}
            step={1}
            placeholder={systemMaxPromptLength != null ? String(systemMaxPromptLength) : undefined}
            value={maxPromptLengthDraft}
            onChange={(e) => onMaxPromptLengthDraftChange(e.target.value)}
          />
          <button type="submit" className="text-btn" disabled={maxPromptLengthBusy}>
            {maxPromptLengthBusy ? 'Saving…' : 'Save'}
          </button>
        </div>
        <span className={styles.originWarning} style={{ color: 'inherit', opacity: 0.7 }}>
          Max characters an end user's single prompt may contain. Can only tighten the
          system-wide limit, never loosen it.
        </span>
      </form>

      <div className={styles.dangerZone}>
        <button type="button" className="text-btn danger" onClick={onDeleteApp}>
          Delete "{appId}"
        </button>
      </div>
    </div>
  )
}

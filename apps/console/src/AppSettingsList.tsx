import { KeyEditSheet } from './KeyEditSheet'
import { OriginEditSheet } from './OriginEditSheet'
import { MaxPromptLengthEditSheet } from './MaxPromptLengthEditSheet'
import { useSheet } from './useSheet'
import styles from './AppSettingsList.module.css'

// Mobile-only — the App settings view for phones, styled after a native
// settings screen (back arrow + title, then a list of rows that each open
// their own edit sheet) rather than the desktop AppSettingsView.tsx's flat
// form. Reached via MobileTopBar.tsx's gear icon (see App.tsx's
// appSettingsSelected / selectAppSettings) — desktop keeps its existing
// flat-form AppSettingsView.tsx unchanged; this is a separate component,
// not a shared one with a mobile/desktop branch inside it.
export function AppSettingsList({
  appId,
  onBack,
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
  onBack: () => void
  hasKey: boolean
  onIssueKey: () => void
  onRevokeKey: () => void
  allowedOrigins: string[]
  originDrafts: string[]
  onOriginDraftsChange: (next: string[]) => void
  newOriginDraft: string
  onNewOriginDraftChange: (value: string) => void
  originBusy: boolean
  onSaveOrigins: (e: React.FormEvent) => Promise<boolean>
  maxPromptLengthDraft: string
  onMaxPromptLengthDraftChange: (value: string) => void
  maxPromptLengthBusy: boolean
  onSaveMaxPromptLength: (e: React.FormEvent) => Promise<boolean>
  systemMaxPromptLength: number | null
  onDeleteApp: () => void
}) {
  const keySheet = useSheet()
  const originSheet = useSheet()
  const maxPromptLengthSheet = useSheet()

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <button type="button" className={styles.backBtn} onClick={onBack} aria-label="Back">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="20" height="20">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <span className={styles.title}>App settings</span>
      </div>

      <div className={styles.list}>
        <button type="button" className={styles.row} onClick={keySheet.onOpen}>
          <div className={styles.rowInfo}>
            <div className={styles.rowLabel}>Key</div>
            <div className={styles.rowValue}>{hasKey ? 'Issued' : 'Not issued'}</div>
          </div>
          <svg className={styles.chevron} viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>

        <button type="button" className={styles.row} onClick={originSheet.onOpen}>
          <div className={styles.rowInfo}>
            <div className={styles.rowLabel}>Allowed origins</div>
            <div className={styles.rowValue}>
              {allowedOrigins.length > 0 ? allowedOrigins.join(', ') : 'Not set'}
            </div>
            {allowedOrigins.length === 0 && (
              <div className={styles.rowWarning}>
                No origin set — every connection for this app is blocked until one is saved.
              </div>
            )}
          </div>
          <svg className={styles.chevron} viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>

        <button type="button" className={styles.row} onClick={maxPromptLengthSheet.onOpen}>
          <div className={styles.rowInfo}>
            <div className={styles.rowLabel}>Max prompt length</div>
            <div className={styles.rowValue}>
              {maxPromptLengthDraft.trim() !== ''
                ? `${maxPromptLengthDraft.trim()} characters`
                : systemMaxPromptLength != null
                  ? `${systemMaxPromptLength} characters`
                  : ''}
            </div>
          </div>
          <svg className={styles.chevron} viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>
      </div>

      <div className={styles.dangerZone}>
        <button type="button" className="text-btn danger" onClick={onDeleteApp}>
          Delete "{appId}"
        </button>
      </div>

      <KeyEditSheet open={keySheet.open} onClose={keySheet.onClose} hasKey={hasKey} onIssueKey={onIssueKey} onRevokeKey={onRevokeKey} />

      <OriginEditSheet
        open={originSheet.open}
        onClose={originSheet.onClose}
        allowedOrigins={allowedOrigins}
        originDrafts={originDrafts}
        onOriginDraftsChange={onOriginDraftsChange}
        newOriginDraft={newOriginDraft}
        onNewOriginDraftChange={onNewOriginDraftChange}
        originBusy={originBusy}
        onSaveOrigins={async (e) => {
          // Only close on a confirmed save — closing unconditionally right
          // after firing the (async) request meant a failed save looked
          // identical to a successful one: the sheet slid away either way,
          // taking the input and any error context with it.
          const ok = await onSaveOrigins(e)
          if (ok) originSheet.onClose()
          return ok
        }}
      />

      <MaxPromptLengthEditSheet
        open={maxPromptLengthSheet.open}
        onClose={maxPromptLengthSheet.onClose}
        draft={maxPromptLengthDraft}
        onDraftChange={onMaxPromptLengthDraftChange}
        busy={maxPromptLengthBusy}
        onSave={onSaveMaxPromptLength}
        systemMaxPromptLength={systemMaxPromptLength}
      />
    </div>
  )
}

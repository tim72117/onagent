import { BottomSheet } from './BottomSheet'
import { SheetHeader } from './SheetHeader'
import styles from './KeyEditSheet.module.css'

// Mobile-only edit sheet for a single app's API key — opened by tapping
// the "Key" row in AppSettingsList.tsx. No Save action here (unlike
// OriginEditSheet.tsx) — issuing/rotating/revoking all take effect
// immediately, there's no draft value to submit, so SheetHeader renders
// with just the close button.
export function KeyEditSheet({
  open,
  onClose,
  hasKey,
  onIssueKey,
  onRevokeKey,
}: {
  open: boolean
  onClose: () => void
  hasKey: boolean
  onIssueKey: () => void
  onRevokeKey: () => void
}) {
  return (
    <BottomSheet open={open} onClose={onClose} disableBackdropClose>
      <SheetHeader title="Key" onClose={onClose} />
      <div className={styles.body}>
        <p className={styles.status}>{hasKey ? 'Key issued' : 'No key issued'}</p>
        <div className={styles.actions}>
          <button
            type="button"
            className="primary"
            onClick={() => {
              onIssueKey()
              onClose()
            }}
          >
            {hasKey ? 'Rotate key' : 'Issue key'}
          </button>
          {hasKey && (
            <button
              type="button"
              className="text-btn danger"
              onClick={() => {
                onRevokeKey()
                onClose()
              }}
            >
              Revoke key
            </button>
          )}
        </div>
      </div>
    </BottomSheet>
  )
}

import { useEffect } from 'react'
import styles from './BottomSheet.module.css'

// Small, purpose-built bottom sheet — no drag gestures, no multi-step snap
// points, no stacking support (see /Users/caitingyu/Documents/tripace/web/src/
// components/PhoneBottomSheet.tsx for a much heavier version built for a
// touch-heavy mobile app; this console is desktop-first with a single sheet
// open at a time, so that complexity isn't needed here). Always mounted
// (not conditionally rendered) so open/close both animate via CSS
// transition instead of the close transition being skipped by unmounting.
export function BottomSheet({
  open,
  onClose,
  children,
  fullscreen,
  disableBackdropClose,
}: {
  open: boolean
  onClose: () => void
  children: React.ReactNode
  // See PlaygroundSheet.tsx — a sheet whose content needs the full
  // viewport instead of the partial-height treatment every other sheet
  // uses.
  fullscreen?: boolean
  // Set on every sheet with actual editable fields (KeyEditSheet,
  // OriginEditSheet, ThoughtEditSheet, ToolNameSheet, ToolDescriptionSheet,
  // ToolParametersSheet, ToolReturnsSheet, ToolEditSheet) — a stray tap
  // just outside the sheet while mid-edit (easy to do one-handed on a
  // phone) silently discarding whatever was being typed is worse than
  // requiring the explicit close (X) button. Left enabled (the default)
  // on sheets with no editable state to lose — AppPickerSheet/AccountSheet
  // (pick-and-go, or read-only) and PlaygroundSheet (a live chat, not a
  // form — nothing to accidentally discard).
  disableBackdropClose?: boolean
}) {
  useEffect(() => {
    if (!open) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  return (
    <>
      <div
        className={`${styles.backdrop} ${open ? styles.open : ''}`}
        onClick={disableBackdropClose ? undefined : onClose}
        aria-hidden="true"
      />
      <div
        className={`${styles.panel} ${open ? styles.open : ''}${fullscreen ? ' ' + styles.fullscreen : ''}`}
        role="dialog"
        aria-modal="true"
      >
        {children}
      </div>
    </>
  )
}

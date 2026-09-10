import { useEffect, useRef } from 'react'
import { BottomSheet } from './BottomSheet'
import { SheetHeader } from './SheetHeader'
import { focusAndReveal } from './focusField'
import styles from './OriginEditSheet.module.css'

// Mobile-only edit sheet for an app's allowed origins — opened by tapping
// the "Allowed origins" row in AppSettingsList.tsx, which already shows the
// "no origin set" warning inline in the row itself — not repeated here.
// Mirrors the reference design: close/title/save header, editable list
// below. The header and body both live inside one <form> so SheetHeader's
// Save button (type="submit" by default) reuses onSaveOrigins' signature
// unchanged.
//
// A connection is accepted from ANY one of these origins (see backend's
// ws.APIKeyResolver.ResolveApp) — this is not a single value any more, so
// the sheet is a list (add one at a time via the text field + "Add",
// remove any existing entry) rather than a single input.
//
// onSaveOrigins returns Promise<boolean> (not void, unlike the desktop
// AppSettingsView.tsx form's handler) because AppSettingsList.tsx awaits it
// to decide whether the save actually succeeded before closing this sheet
// — closing unconditionally right after firing the request meant a failed
// save looked identical to a successful one.
export function OriginEditSheet({
  open,
  onClose,
  allowedOrigins,
  originDrafts,
  onOriginDraftsChange,
  newOriginDraft,
  onNewOriginDraftChange,
  originBusy,
  onSaveOrigins,
}: {
  open: boolean
  onClose: () => void
  allowedOrigins: string[]
  originDrafts: string[]
  onOriginDraftsChange: (next: string[]) => void
  newOriginDraft: string
  onNewOriginDraftChange: (value: string) => void
  originBusy: boolean
  onSaveOrigins: (e: React.FormEvent) => Promise<boolean>
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  // See ToolNameSheet.tsx's own comment on why this focuses via ref+effect
  // gated on `open` instead of the input's own autoFocus prop — BottomSheet
  // keeps this sheet always mounted (for its close transition), so
  // autoFocus would fire the moment its parent (AppSettingsList.tsx) mounts,
  // popping the keyboard before the user ever taps "Allowed origins".
  useEffect(() => {
    if (open) focusAndReveal(inputRef.current)
  }, [open])

  function addDraft() {
    const trimmed = newOriginDraft.trim()
    if (!trimmed || originDrafts.includes(trimmed)) return
    onOriginDraftsChange([...originDrafts, trimmed])
    onNewOriginDraftChange('')
  }

  const dirty =
    originDrafts.length !== allowedOrigins.length || originDrafts.some((o, i) => o !== allowedOrigins[i])

  return (
    <BottomSheet open={open} onClose={onClose} disableBackdropClose>
      <form
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
        <SheetHeader
          title="Allowed origins"
          onClose={onClose}
          saveLabel={originBusy ? 'Saving…' : 'Save'}
          saveDisabled={originBusy || (!dirty && !newOriginDraft.trim())}
        />
        <div className={styles.body}>
          {originDrafts.length > 0 && (
            <ul className={styles.list}>
              {originDrafts.map((origin) => (
                <li key={origin} className={styles.listItem}>
                  <span className={styles.listItemText}>{origin}</span>
                  <button
                    type="button"
                    className={styles.removeBtn}
                    aria-label={`Remove ${origin}`}
                    onClick={() => onOriginDraftsChange(originDrafts.filter((o) => o !== origin))}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" width="14" height="14">
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className={styles.addRow}>
            <input
              ref={inputRef}
              className={styles.input}
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
          </div>
        </div>
      </form>
    </BottomSheet>
  )
}

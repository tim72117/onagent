import { useEffect, useRef } from 'react'
import { BottomSheet } from './BottomSheet'
import { SheetHeader } from './SheetHeader'
import { focusAndReveal } from './focusField'
import styles from './OriginEditSheet.module.css'

// Mobile-only edit sheet for a single app's allowed origin — opened by
// tapping the "Allowed origin" row in AppSettingsList.tsx, which already
// shows the "no origin set" warning inline in the row itself — not
// repeated here. Mirrors the reference design: close/title/save header,
// editable field below. The header and body both live inside one <form>
// so SheetHeader's Save button (type="submit" by default) reuses
// onSaveOrigin's signature unchanged.
//
// onSaveOrigin returns Promise<boolean> (not void, unlike the desktop
// AppSettingsView.tsx form's handler) because AppSettingsList.tsx awaits it
// to decide whether the save actually succeeded before closing this sheet
// — closing unconditionally right after firing the request meant a failed
// save looked identical to a successful one.
export function OriginEditSheet({
  open,
  onClose,
  allowedOrigin,
  originDraft,
  onOriginDraftChange,
  originBusy,
  onSaveOrigin,
}: {
  open: boolean
  onClose: () => void
  allowedOrigin: string | null
  originDraft: string
  onOriginDraftChange: (value: string) => void
  originBusy: boolean
  onSaveOrigin: (e: React.FormEvent) => Promise<boolean>
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  // See ToolNameSheet.tsx's own comment on why this focuses via ref+effect
  // gated on `open` instead of the input's own autoFocus prop — BottomSheet
  // keeps this sheet always mounted (for its close transition), so
  // autoFocus would fire the moment its parent (AppSettingsList.tsx) mounts,
  // popping the keyboard before the user ever taps "Allowed origin".
  useEffect(() => {
    if (open) focusAndReveal(inputRef.current)
  }, [open])

  return (
    <BottomSheet open={open} onClose={onClose} disableBackdropClose>
      <form onSubmit={onSaveOrigin}>
        <SheetHeader
          title="Allowed origin"
          onClose={onClose}
          saveLabel={originBusy ? 'Saving…' : 'Save'}
          saveDisabled={originBusy || originDraft.trim() === (allowedOrigin ?? '')}
        />
        <div className={styles.body}>
          <input
            ref={inputRef}
            className={styles.input}
            placeholder="https://your-site.example.com"
            value={originDraft}
            onChange={(e) => onOriginDraftChange(e.target.value)}
          />
        </div>
      </form>
    </BottomSheet>
  )
}

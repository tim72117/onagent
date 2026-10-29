import { useEffect, useRef } from 'react'
import { BottomSheet } from './BottomSheet'
import { SheetHeader } from './SheetHeader'
import { focusAndReveal } from './focusField'
import styles from './MaxPromptLengthEditSheet.module.css'

// Mobile-only edit sheet for how many images an end user may attach to one
// prompt — opened from the "Images per prompt" row in AppSettingsList.tsx.
// Same shape and save contract as MaxPromptLengthEditSheet.tsx (see its doc
// comment); the difference is what an empty field means: here it turns
// images off, which is also every app's default.
export function MaxPromptImagesEditSheet({
  open,
  onClose,
  draft,
  onDraftChange,
  busy,
  onSave,
  systemMaxPromptImages,
}: {
  open: boolean
  onClose: () => void
  draft: string
  onDraftChange: (value: string) => void
  busy: boolean
  onSave: (e: React.FormEvent) => Promise<boolean>
  systemMaxPromptImages: number | null
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) focusAndReveal(inputRef.current)
  }, [open])

  return (
    <BottomSheet open={open} onClose={onClose} disableBackdropClose>
      <form
        onSubmit={async (e) => {
          const ok = await onSave(e)
          if (ok) onClose()
        }}
      >
        <SheetHeader title="Images per prompt" onClose={onClose} saveLabel={busy ? 'Saving…' : 'Save'} saveDisabled={busy} />
        <div className={styles.body}>
          <p className={styles.hint}>{maxPromptImagesHint(systemMaxPromptImages)}</p>
          <input
            ref={inputRef}
            className={styles.input}
            type="number"
            min={1}
            max={systemMaxPromptImages ?? undefined}
            step={1}
            placeholder="Off"
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
          />
        </div>
      </form>
    </BottomSheet>
  )
}

/** Shared by this sheet and AppSettingsView.tsx's desktop form. */
export function maxPromptImagesHint(systemMaxPromptImages: number | null): string {
  const cap = systemMaxPromptImages != null ? ` (at most ${systemMaxPromptImages})` : ''
  return (
    `How many images an end user may attach to one prompt${cap}. ` +
    'Leave empty to turn images off. Images use far more tokens than text, and count toward your plan.'
  )
}

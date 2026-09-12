import { useEffect, useRef } from 'react'
import { BottomSheet } from './BottomSheet'
import { SheetHeader } from './SheetHeader'
import { focusAndReveal } from './focusField'
import styles from './MaxPromptLengthEditSheet.module.css'

// Mobile-only edit sheet for an app's max prompt length — opened by tapping
// the "Max prompt length" row in AppSettingsList.tsx. Mirrors
// OriginEditSheet.tsx's close/title/save header + form body shape, but the
// body is a single numeric field rather than a list.
//
// draft is kept as text (not number) so an empty field can mean "clear the
// app-specific limit and fall back to the platform-wide default" without
// fighting a numeric input's own coercion of "" to 0 — see App.tsx's
// maxPromptLengthDraft state and saveMaxPromptLength handler, which is
// where the text is parsed and validated.
//
// onSave returns Promise<boolean> (not void) for the same reason
// OriginEditSheet.tsx's onSaveOrigins does — see that component's own
// doc comment: this sheet only closes on a confirmed save, so a
// validation failure or a rejected API call doesn't get masked by the
// sheet sliding away as if it had saved.
export function MaxPromptLengthEditSheet({
  open,
  onClose,
  draft,
  onDraftChange,
  busy,
  onSave,
  systemMaxPromptLength,
}: {
  open: boolean
  onClose: () => void
  draft: string
  onDraftChange: (value: string) => void
  busy: boolean
  onSave: (e: React.FormEvent) => Promise<boolean>
  systemMaxPromptLength: number | null
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
        <SheetHeader title="Max prompt length" onClose={onClose} saveLabel={busy ? 'Saving…' : 'Save'} saveDisabled={busy} />
        <div className={styles.body}>
          <p className={styles.hint}>
            Max characters an end user's single prompt may contain. Can only tighten the
            system-wide limit, never loosen it.
          </p>
          <input
            ref={inputRef}
            className={styles.input}
            type="number"
            min={1}
            step={1}
            placeholder={systemMaxPromptLength != null ? String(systemMaxPromptLength) : undefined}
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
          />
        </div>
      </form>
    </BottomSheet>
  )
}

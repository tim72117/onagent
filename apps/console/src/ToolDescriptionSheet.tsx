import { useEffect, useRef, useState } from 'react'
import { BottomSheet } from './BottomSheet'
import { SheetHeader } from './SheetHeader'
import { focusAndReveal } from './focusField'
import styles from './ToolFieldSheet.module.css'

// See ToolNameSheet.tsx's own comment — same local-draft-then-Save shape,
// one row of ToolEditSheet.tsx's list.
export function ToolDescriptionSheet({
  open,
  onClose,
  description,
  onSave,
}: {
  open: boolean
  onClose: () => void
  description: string
  onSave: (next: string) => void
}) {
  const [draft, setDraft] = useState(description)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // See ToolNameSheet.tsx's own comment on why this focuses via ref+effect
  // gated on `open` instead of the textarea's own autoFocus prop.
  useEffect(() => {
    if (open) {
      setDraft(description)
      focusAndReveal(textareaRef.current)
    }
  }, [open, description])

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    // Trimmed to match saveDisabled's own draft.trim() === description
    // check below — see ToolNameSheet.tsx's own comment on why sending
    // the untrimmed draft is a bug, not just a style nit.
    onSave(draft.trim())
    onClose()
  }

  return (
    <BottomSheet open={open} onClose={onClose} fullscreen disableBackdropClose>
      <form className={styles.form} onSubmit={handleSubmit}>
        <div className={styles.header}>
          <SheetHeader title="Description" onClose={onClose} saveLabel="Save" saveDisabled={draft.trim() === description} />
        </div>
        <div className={styles.body}>
          <textarea
            ref={textareaRef}
            className={styles.descriptionInput}
            placeholder="What does this tool do, and when should the model call it?"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
        </div>
      </form>
    </BottomSheet>
  )
}

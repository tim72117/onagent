import { useEffect, useState } from 'react'
import { BottomSheet } from './BottomSheet'
import { SheetHeader } from './SheetHeader'
import styles from './ToolFieldSheet.module.css'

// One row of ToolEditSheet.tsx's list — editing a tool's name in
// isolation, same local-draft-then-Save pattern as its siblings
// (ToolDescriptionSheet/ToolParametersSheet/ToolReturnsSheet). See
// ToolEditSheet.tsx's own comment for why this list-of-rows shape
// replaced a single flat ToolForm sheet.
export function ToolNameSheet({
  open,
  onClose,
  name,
  onSave,
}: {
  open: boolean
  onClose: () => void
  name: string
  onSave: (next: string) => void
}) {
  const [draft, setDraft] = useState(name)

  useEffect(() => {
    if (open) setDraft(name)
  }, [open, name])

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    // Trimmed to match saveDisabled's own draft.trim() === name check below
    // — sending the untrimmed draft let a trailing space slip through as
    // a "real" edit (Save enabled) that then failed toolschema's name
    // validation right after saving, reading as "Save just... didn't work".
    onSave(draft.trim())
    onClose()
  }

  return (
    <BottomSheet open={open} onClose={onClose} fullscreen disableBackdropClose>
      <form className={styles.form} onSubmit={handleSubmit}>
        <div className={styles.header}>
          <SheetHeader title="Name" onClose={onClose} saveLabel="Save" saveDisabled={draft.trim() === name} />
        </div>
        <div className={styles.body}>
          <input
            className={styles.nameInput}
            placeholder="tool_name"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
          />
        </div>
      </form>
    </BottomSheet>
  )
}

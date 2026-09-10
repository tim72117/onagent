import { useEffect, useState } from 'react'
import type { ParameterSchema } from './schema'
import { emptyObjectSchema } from './schema'
import { SchemaEditor } from './SchemaEditor'
import { BottomSheet } from './BottomSheet'
import { SheetHeader } from './SheetHeader'
import styles from './ToolFieldSheet.module.css'

// See ToolNameSheet.tsx's own comment — same local-draft-then-Save shape.
// `returns` is optional at the schema level (undefined means "no shape
// declared"), so the local draft mirrors that instead of always holding a
// ParameterSchema — same checkbox-gates-the-editor pattern ToolForm.tsx
// used before this field was pulled out into its own sheet.
export function ToolReturnsSheet({
  open,
  onClose,
  returns,
  onSave,
}: {
  open: boolean
  onClose: () => void
  returns: ParameterSchema | undefined
  onSave: (next: ParameterSchema | undefined) => void
}) {
  const [draft, setDraft] = useState(returns)

  useEffect(() => {
    if (open) setDraft(returns)
  }, [open, returns])

  function handleSave() {
    onSave(draft)
    onClose()
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(returns)

  return (
    <BottomSheet open={open} onClose={onClose} fullscreen disableBackdropClose>
      <div className={styles.header}>
        <SheetHeader title="Returns" onClose={onClose} saveType="button" saveLabel="Done" saveDisabled={!dirty} onSave={handleSave} />
      </div>
      <div className={styles.body}>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={!!draft}
            onChange={(e) => setDraft(e.target.checked ? emptyObjectSchema() : undefined)}
          />
          Declare a returns shape
        </label>
        {draft && <SchemaEditor schema={draft} onChange={setDraft} />}
      </div>
    </BottomSheet>
  )
}

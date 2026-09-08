import { useEffect, useState } from 'react'
import type { ParameterSchema } from './schema'
import { SchemaEditor } from './SchemaEditor'
import { BottomSheet } from './BottomSheet'
import { SheetHeader } from './SheetHeader'
import styles from './ToolFieldSheet.module.css'

// See ToolNameSheet.tsx's own comment — same local-draft-then-Save shape.
// lockedPropertyNames is passed straight through to SchemaEditor, same as
// ToolForm.tsx's own usage (a template-built tool's mock-required
// parameter names can't be renamed/removed here either).
export function ToolParametersSheet({
  open,
  onClose,
  parameters,
  lockedPropertyNames,
  onSave,
}: {
  open: boolean
  onClose: () => void
  parameters: ParameterSchema
  lockedPropertyNames: string[]
  onSave: (next: ParameterSchema) => void
}) {
  const [draft, setDraft] = useState(parameters)

  useEffect(() => {
    if (open) setDraft(parameters)
  }, [open, parameters])

  function handleSave() {
    onSave(draft)
    onClose()
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(parameters)

  return (
    <BottomSheet open={open} onClose={onClose} fullscreen disableBackdropClose>
      <div className={styles.header}>
        <SheetHeader title="Parameters" onClose={onClose} saveType="button" saveLabel="Save" saveDisabled={!dirty} onSave={handleSave} />
      </div>
      <div className={styles.body}>
        <SchemaEditor schema={draft} onChange={setDraft} hideRootHeader lockedPropertyNames={lockedPropertyNames} />
      </div>
    </BottomSheet>
  )
}

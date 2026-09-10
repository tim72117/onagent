import styles from './SheetHeader.module.css'

// Shared header row for edit-style bottom sheets (OriginEditSheet.tsx): an
// X to close on the left, the field name in the middle, a "Save" action on
// the right — mirrors the reference pattern the user provided (a native-
// app-style field editor: close/title/save in one row, the editable
// content below it). The save button defaults to type="submit" so
// rendering this inside a <form> (see OriginEditSheet.tsx) wires it to
// that form's onSubmit for free — pass saveType="button" + onSave for a
// sheet with no form (e.g. one whose actions fire immediately, no draft
// value to submit). Omit both onSave and saveLabel entirely for a sheet
// with no save action (just close), like KeyEditSheet.tsx.
export function SheetHeader({
  title,
  onClose,
  saveLabel,
  saveDisabled,
  saveType = 'submit',
  onSave,
  trailing,
}: {
  title: string
  onClose: () => void
  saveLabel?: string
  saveDisabled?: boolean
  saveType?: 'submit' | 'button'
  onSave?: () => void
  // Extra content between the title and the save button (or, with no
  // saveLabel, at the row's trailing edge) — e.g. PlaygroundSheet.tsx's
  // connection-status pill. A plain sibling span placed outside this
  // component used to fight this row's own -16px negative margin (see
  // .header below): align-items:center centers flex items by their own
  // box, and that margin shifts where this row's visible content actually
  // sits without changing the box height layout measures — so a sibling
  // centered against the row read as vertically offset from the title/close
  // button. Rendering trailing INSIDE this row's own flex context avoids
  // that entirely, the same way saveLabel already does.
  trailing?: React.ReactNode
}) {
  return (
    <div className={styles.header}>
      <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" width="18" height="18">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
      <span className={styles.title}>{title}</span>
      {trailing}
      {saveLabel && (
        <button type={saveType} className={styles.saveBtn} onClick={onSave} disabled={saveDisabled}>
          {saveLabel}
        </button>
      )}
    </div>
  )
}

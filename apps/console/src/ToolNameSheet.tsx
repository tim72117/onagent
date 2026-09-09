import { useEffect, useRef, useState } from 'react'
import { BottomSheet } from './BottomSheet'
import { SheetHeader } from './SheetHeader'
import { TOOL_NAME_RE } from './schema'
import { focusAndReveal } from './focusField'
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
  const inputRef = useRef<HTMLInputElement>(null)

  // Focusing via a ref+effect gated on `open`, not the input's own
  // autoFocus prop — BottomSheet keeps every sheet (including this one)
  // always mounted so its close transition can animate instead of being
  // skipped by unmounting (see BottomSheet.tsx's own comment), which means
  // autoFocus would fire the moment ToolEditSheet itself mounts, well
  // before the user actually taps into this specific row — silently
  // popping the mobile keyboard while the visible screen is still
  // ToolEditSheet's row list, not this sheet.
  useEffect(() => {
    if (open) {
      setDraft(name)
      focusAndReveal(inputRef.current)
    }
  }, [open, name])

  const trimmed = draft.trim()
  // name is the tool's actual identifier — the LLM calls it by this string
  // (see toolschema.Tool.Name's own doc comment), and it's half of the
  // backend's app_id+name primary key, not just a display label. Blocking
  // Save on an invalid/empty name here (not just "unchanged from the
  // original") matters because App.tsx's autosave effect separately
  // refuses to persist the draft at all while any tool fails this same
  // TOOL_NAME_RE check (see validate.ts) — without this, tapping Save with
  // an empty/invalid name still closed this sheet and looked like it
  // "worked", leaving the edit silently stuck dirty and never saved, with
  // nothing here explaining why.
  const isValidName = TOOL_NAME_RE.test(trimmed)
  const saveDisabled = trimmed === name || !isValidName

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!isValidName) return
    // Trimmed to match saveDisabled's own check above — sending the
    // untrimmed draft let a trailing space slip through as a "real" edit
    // (Save enabled) that then failed toolschema's name validation right
    // after saving, reading as "Save just... didn't work".
    onSave(trimmed)
    onClose()
  }

  return (
    <BottomSheet open={open} onClose={onClose} fullscreen disableBackdropClose>
      <form className={styles.form} onSubmit={handleSubmit}>
        <div className={styles.header}>
          <SheetHeader title="Name" onClose={onClose} saveLabel="Save" saveDisabled={saveDisabled} />
        </div>
        <div className={styles.body}>
          <input
            ref={inputRef}
            className={styles.nameInput}
            placeholder="tool_name"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          {draft !== '' && !isValidName && (
            <p className={styles.nameError}>Must match {TOOL_NAME_RE.source} — e.g. letters, digits, underscores, not starting with a digit.</p>
          )}
        </div>
      </form>
    </BottomSheet>
  )
}

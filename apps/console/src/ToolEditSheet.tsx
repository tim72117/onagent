import { useEffect, useState } from 'react'
import type { Tool } from './schema'
import { TOOL_NAME_RE } from './schema'
import { TEMPLATES } from './ToolWizard'
import { MOCK_LOCKED_PARAM_NAMES } from './playgroundMocks'
import { BottomSheet } from './BottomSheet'
import { SheetHeader } from './SheetHeader'
import { ToolNameSheet } from './ToolNameSheet'
import { ToolDescriptionSheet } from './ToolDescriptionSheet'
import { ToolParametersSheet } from './ToolParametersSheet'
import { ToolReturnsSheet } from './ToolReturnsSheet'
import { useSheet } from './useSheet'
import styles from './ToolEditSheet.module.css'

function paramCount(schema: Tool['parameters']): number {
  return Object.keys(schema.properties ?? {}).length
}

// One-line preview of the Parameters row's value — each parameter's own
// name and description, not just a bare count, so a developer (or someone
// reviewing an AI-generated tool, see aiToolGenerator.ts) can tell at a
// glance whether the parameters actually look right without opening
// ToolParametersSheet. .rowValue already truncates with an ellipsis
// (ToolEditSheet.module.css), so this can run long without breaking layout.
function paramSummary(schema: Tool['parameters']): string {
  const props = schema.properties ?? {}
  const names = Object.keys(props)
  if (names.length === 0) return 'None'
  return names.map((name) => `${name}: ${props[name]?.description || 'no description'}`).join(' · ')
}

// Mobile-only, full-screen (see BottomSheet.tsx's fullscreen prop) —
// same native-settings-style list-of-rows pattern as AppSettingsList.tsx
// (tap a row, get a dedicated edit sheet for just that field), not a
// single flat ToolForm sheet the way an earlier version of this worked.
//
// Each row's own sheet (ToolNameSheet/ToolDescriptionSheet/
// ToolParametersSheet/ToolReturnsSheet) still holds its own local draft
// and its own Save button (so its own validity check — e.g.
// ToolNameSheet's TOOL_NAME_RE gate — still blocks committing a bad value
// for that one field), but "Save" there now only writes into this sheet's
// own `draft` (via setDraft below), not all the way out to `onChange`.
// This sheet's own header Save is what finally calls `onChange`, once,
// for every field edited across however many of those row-sheets were
// visited in this session — editing Name then Description then coming
// back here used to autosave twice (once per field's own Save), each
// hitting App.tsx's 1.2s-debounced saveDraft independently; now it's one
// deliberate Save the user can also just back out of (via the outer ✕)
// without any of the in-between edits having reached draft.tools at all.
export function ToolEditSheet({
  open,
  onClose,
  tool,
  onChange,
  onRemove,
  isNew,
  onConfirmDiscard,
}: {
  open: boolean
  onClose: () => void
  tool: Tool | null
  onChange: (next: Tool) => void
  // Only meaningful (and only ever called) for an existing tool — the
  // isNew instance below hides Delete entirely, since there's nothing in
  // draft.tools yet to remove.
  onRemove?: () => void
  // Set by MobileWorkspaceCards.tsx's dedicated "creating a new tool"
  // instance — its `tool` is a local, not-yet-saved draft that never
  // touched draft.tools, so Delete makes no sense here and closing with
  // unsaved edits needs its own discard confirmation (onConfirmDiscard)
  // instead of just silently vanishing. Not set (falsy) for the normal
  // existing-tool instance, which has no such confirmation today.
  isNew?: boolean
  onConfirmDiscard?: (message: string, onConfirm: () => void) => void
}) {
  const nameSheet = useSheet()
  const descriptionSheet = useSheet()
  const parametersSheet = useSheet()
  const returnsSheet = useSheet()

  const [draft, setDraft] = useState(tool)

  // Resyncs whenever this sheet opens (same "start fresh from the true
  // current value" pattern every row-sheet above already uses) — covers
  // both switching to a different tool and reopening this same tool right
  // after this sheet's own Save updated it.
  useEffect(() => {
    if (open) setDraft(tool)
  }, [open, tool])

  if (!tool || !draft) return null

  const templateLabel = draft.sourceTemplate
    ? (TEMPLATES.find((t) => t.key === draft.sourceTemplate)?.label ?? draft.sourceTemplate)
    : null
  const lockedParamNames = draft.sourceTemplate ? (MOCK_LOCKED_PARAM_NAMES[draft.sourceTemplate] ?? []) : []

  const trimmedName = draft.name.trim()
  const isValidName = TOOL_NAME_RE.test(trimmedName)
  const dirty = JSON.stringify(draft) !== JSON.stringify(tool)
  // For an existing tool, "unchanged from tool" (dirty) is the right gate —
  // no point saving if nothing was edited. For isNew, that same check is
  // wrong: draft starts out identical to tool (the AI generator's proposed
  // tool, or emptyTool()), so dirty is false the instant the sheet opens,
  // even when the AI already produced a complete, valid tool needing zero
  // further edits — the correct gate there is just "is draft valid", not
  // "did it change from its own starting point."
  const saveDisabled = isNew ? !isValidName : !dirty || !isValidName

  function handleSave() {
    if (!draft || !isValidName) return
    onChange({ ...draft, name: trimmedName })
    onClose()
  }

  // Discard-confirm only applies to the isNew instance — an in-progress
  // "+ New tool" draft that's never touched draft.tools has real, easy-to-
  // lose typing behind it (name, description, a parameter or two) with no
  // autosave net underneath, unlike the existing-tool instance, which
  // edits something already safely sitting in draft.tools. Routes every
  // close path (✕, BottomSheet's own Escape-key handler) through the same
  // check, not just the ✕ button, since BottomSheet forwards its onClose
  // prop to both.
  function handleClose() {
    if (isNew && dirty && onConfirmDiscard) {
      onConfirmDiscard('Discard this new tool?', onClose)
    } else {
      onClose()
    }
  }

  return (
    <BottomSheet open={open} onClose={handleClose} fullscreen disableBackdropClose>
      <div className={styles.header}>
        <SheetHeader
          title={draft.name || (isNew ? 'New tool' : 'Tool')}
          onClose={handleClose}
          saveType="button"
          saveLabel="Save"
          saveDisabled={saveDisabled}
          onSave={handleSave}
        />
      </div>
      <div className={styles.body}>
        {templateLabel && (
          <p className={styles.templateNote} title="Built from this template in the guided wizard">
            From template: {templateLabel}
          </p>
        )}

        <div className={styles.list}>
          <button type="button" className={styles.row} onClick={nameSheet.onOpen}>
            <div className={styles.rowInfo}>
              <div className={styles.rowLabel}>Name</div>
              <div className={styles.rowValue}>{draft.name || 'unnamed_tool'}</div>
            </div>
            <svg className={styles.chevron} viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
              <path d="M9 18l6-6-6-6" />
            </svg>
          </button>

          <button type="button" className={styles.row} onClick={descriptionSheet.onOpen}>
            <div className={styles.rowInfo}>
              <div className={styles.rowLabel}>Description</div>
              <div className={styles.rowValue}>{draft.description || 'Not set'}</div>
            </div>
            <svg className={styles.chevron} viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
              <path d="M9 18l6-6-6-6" />
            </svg>
          </button>

          <button type="button" className={styles.row} onClick={parametersSheet.onOpen}>
            <div className={styles.rowInfo}>
              <div className={styles.rowLabel}>
                Parameters{paramCount(draft.parameters) > 0 && ` (${paramCount(draft.parameters)})`}
              </div>
              <div className={styles.rowValue}>{paramSummary(draft.parameters)}</div>
            </div>
            <svg className={styles.chevron} viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
              <path d="M9 18l6-6-6-6" />
            </svg>
          </button>

          <button type="button" className={styles.row} onClick={returnsSheet.onOpen}>
            <div className={styles.rowInfo}>
              <div className={styles.rowLabel}>Returns</div>
              <div className={styles.rowValue}>{draft.returns ? 'Declared' : 'Not declared'}</div>
            </div>
            <svg className={styles.chevron} viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
              <path d="M9 18l6-6-6-6" />
            </svg>
          </button>
        </div>

        {/* Omitted for the isNew instance — this tool was never added to
            draft.tools, so there's nothing there yet to remove; "Discard
            this new tool?" (handleClose, above) already covers backing out
            of it entirely. */}
        {!isNew && (
          <div className={styles.dangerZone}>
            <button
              type="button"
              className="text-btn danger"
              onClick={() => {
                onRemove?.()
                onClose()
              }}
            >
              Delete tool
            </button>
          </div>
        )}
      </div>

      <ToolNameSheet
        open={nameSheet.open}
        onClose={nameSheet.onClose}
        name={draft.name}
        onSave={(name) => setDraft((d) => d && { ...d, name })}
      />

      <ToolDescriptionSheet
        open={descriptionSheet.open}
        onClose={descriptionSheet.onClose}
        description={draft.description}
        onSave={(description) => setDraft((d) => d && { ...d, description })}
      />

      <ToolParametersSheet
        open={parametersSheet.open}
        onClose={parametersSheet.onClose}
        parameters={draft.parameters}
        lockedPropertyNames={lockedParamNames}
        onSave={(parameters) => setDraft((d) => d && { ...d, parameters })}
      />

      <ToolReturnsSheet
        open={returnsSheet.open}
        onClose={returnsSheet.onClose}
        returns={draft.returns}
        onSave={(returns) => setDraft((d) => d && { ...d, returns })}
      />
    </BottomSheet>
  )
}

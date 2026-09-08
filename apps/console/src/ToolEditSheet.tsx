import type { Tool } from './schema'
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

// Mobile-only, full-screen (see BottomSheet.tsx's fullscreen prop) —
// same native-settings-style list-of-rows pattern as AppSettingsList.tsx
// (tap a row, get a dedicated edit sheet for just that field), not a
// single flat ToolForm sheet the way an earlier version of this worked.
// Each row's own sheet (ToolNameSheet/ToolDescriptionSheet/
// ToolParametersSheet/ToolReturnsSheet) holds a local draft and only
// calls back into onChange (which writes into App.tsx's draft/dirty and
// autosaves) when its own Save is pressed — this outer sheet has nothing
// to save itself, just navigation and Delete.
export function ToolEditSheet({
  open,
  onClose,
  tool,
  onChange,
  onRemove,
}: {
  open: boolean
  onClose: () => void
  tool: Tool | null
  onChange: (next: Tool) => void
  onRemove: () => void
}) {
  const nameSheet = useSheet()
  const descriptionSheet = useSheet()
  const parametersSheet = useSheet()
  const returnsSheet = useSheet()

  if (!tool) return null

  const templateLabel = tool.sourceTemplate
    ? (TEMPLATES.find((t) => t.key === tool.sourceTemplate)?.label ?? tool.sourceTemplate)
    : null
  const lockedParamNames = tool.sourceTemplate ? (MOCK_LOCKED_PARAM_NAMES[tool.sourceTemplate] ?? []) : []

  return (
    <BottomSheet open={open} onClose={onClose} fullscreen disableBackdropClose>
      <div className={styles.header}>
        <SheetHeader title={tool.name || 'Tool'} onClose={onClose} />
      </div>
      <div className={styles.body}>
        {templateLabel && (
          <p className={styles.templateNote} title="Built from this template in the guided wizard">
            From template: {templateLabel}
          </p>
        )}

        <div className={styles.list}>
          <button type="button" className={styles.row} onClick={nameSheet.onOpen}>
            <div>
              <div className={styles.rowLabel}>Name</div>
              <div className={styles.rowValue}>{tool.name || 'unnamed_tool'}</div>
            </div>
            <svg className={styles.chevron} viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
              <path d="M9 18l6-6-6-6" />
            </svg>
          </button>

          <button type="button" className={styles.row} onClick={descriptionSheet.onOpen}>
            <div>
              <div className={styles.rowLabel}>Description</div>
              <div className={styles.rowValue}>{tool.description || 'Not set'}</div>
            </div>
            <svg className={styles.chevron} viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
              <path d="M9 18l6-6-6-6" />
            </svg>
          </button>

          <button type="button" className={styles.row} onClick={parametersSheet.onOpen}>
            <div>
              <div className={styles.rowLabel}>Parameters</div>
              <div className={styles.rowValue}>
                {paramCount(tool.parameters) === 0 ? 'None' : `${paramCount(tool.parameters)} parameter(s)`}
              </div>
            </div>
            <svg className={styles.chevron} viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
              <path d="M9 18l6-6-6-6" />
            </svg>
          </button>

          <button type="button" className={styles.row} onClick={returnsSheet.onOpen}>
            <div>
              <div className={styles.rowLabel}>Returns</div>
              <div className={styles.rowValue}>{tool.returns ? 'Declared' : 'Not declared'}</div>
            </div>
            <svg className={styles.chevron} viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
              <path d="M9 18l6-6-6-6" />
            </svg>
          </button>
        </div>

        <div className={styles.dangerZone}>
          <button
            type="button"
            className="text-btn danger"
            onClick={() => {
              onRemove()
              onClose()
            }}
          >
            Delete tool
          </button>
        </div>
      </div>

      <ToolNameSheet open={nameSheet.open} onClose={nameSheet.onClose} name={tool.name} onSave={(name) => onChange({ ...tool, name })} />

      <ToolDescriptionSheet
        open={descriptionSheet.open}
        onClose={descriptionSheet.onClose}
        description={tool.description}
        onSave={(description) => onChange({ ...tool, description })}
      />

      <ToolParametersSheet
        open={parametersSheet.open}
        onClose={parametersSheet.onClose}
        parameters={tool.parameters}
        lockedPropertyNames={lockedParamNames}
        onSave={(parameters) => onChange({ ...tool, parameters })}
      />

      <ToolReturnsSheet
        open={returnsSheet.open}
        onClose={returnsSheet.onClose}
        returns={tool.returns}
        onSave={(returns) => onChange({ ...tool, returns })}
      />
    </BottomSheet>
  )
}

import type { Tool } from './schema'
import { emptyObjectSchema } from './schema'
import { SchemaEditor } from './SchemaEditor'
import { TEMPLATES } from './ToolWizard'
import { MOCK_LOCKED_PARAM_NAMES } from './playgroundMocks'
import type { ValidationIssue } from './validate'
import styles from './ToolForm.module.css'

export function ToolForm({
  tool,
  issues,
  busy,
  saveError,
  onChange,
  onRemove,
}: {
  tool: Tool
  issues: ValidationIssue[]
  // Reflects App.tsx's per-tool debounced autosave (persistTool) — there's
  // no manual Save button here, edits save on their own shortly after the
  // user stops typing, so this is the only UI signal that a save is
  // actually in flight or failed.
  busy?: boolean
  saveError?: string | null
  onChange: (next: Tool) => void
  onRemove: () => void
}) {
  const templateLabel = tool.sourceTemplate
    ? (TEMPLATES.find((t) => t.key === tool.sourceTemplate)?.label ?? tool.sourceTemplate)
    : null
  const lockedParamNames = tool.sourceTemplate ? (MOCK_LOCKED_PARAM_NAMES[tool.sourceTemplate] ?? []) : []

  return (
    <div className={styles.toolForm}>
      <div className={styles.toolFormHeader}>
        <div className={styles.toolNameField}>
          <label className="micro-label" htmlFor="tool-name">
            Name
          </label>
          <input
            id="tool-name"
            className={styles.toolNameInput}
            placeholder="tool_name"
            value={tool.name}
            onChange={(e) => onChange({ ...tool, name: e.target.value })}
          />
          {templateLabel && (
            <span className={styles.sourceTemplate} title="Built from this template in the guided wizard">
              From template: {templateLabel}
            </span>
          )}
        </div>
        {busy && (
          <span className={styles.sourceTemplate} aria-live="polite">
            Saving…
          </span>
        )}
      </div>

      {issues.length > 0 && (
        <ul className="issue-list">
          {issues.map((issue, i) => (
            <li key={i}>{issue.message}</li>
          ))}
        </ul>
      )}

      {saveError && (
        <ul className="issue-list">
          <li>Couldn't save: {saveError}</li>
        </ul>
      )}

      <label className="field">
        <span className="micro-label">Description</span>
        <textarea
          className="tool-description-input"
          rows={3}
          placeholder="What does this tool do, and when should the model call it?"
          value={tool.description}
          onChange={(e) => onChange({ ...tool, description: e.target.value })}
        />
      </label>

      <div className="field">
        <span className="micro-label">Parameters</span>
        <SchemaEditor
          schema={tool.parameters}
          onChange={(next) => onChange({ ...tool, parameters: next })}
          hideRootHeader
          lockedPropertyNames={lockedParamNames}
        />
      </div>

      <div className="field">
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={!!tool.returns}
            onChange={(e) =>
              onChange({ ...tool, returns: e.target.checked ? emptyObjectSchema() : undefined })
            }
          />
          Declare a returns shape
        </label>
        {tool.returns && (
          <SchemaEditor
            schema={tool.returns}
            onChange={(next) => onChange({ ...tool, returns: next })}
          />
        )}
      </div>

      <div className={styles.dangerZone}>
        <button type="button" className="text-btn danger" onClick={onRemove}>
          Delete tool
        </button>
      </div>
    </div>
  )
}

import type { Tool } from './schema'
import { MAX_DESCRIPTION } from './schema'
import { SchemaEditor } from './SchemaEditor'
import { TEMPLATES } from './ToolWizard'
import { MOCK_LOCKED_PARAM_NAMES } from './playgroundMocks'
import type { ValidationIssue } from './validate'
import styles from './ToolForm.module.css'

export function ToolForm({
  tool,
  issues,
  busy,
  dirty,
  saveError,
  onChange,
  onSave,
  onRemove,
}: {
  tool: Tool
  issues: ValidationIssue[]
  // Reflects App.tsx's per-tool save (persistTool) being in flight.
  busy?: boolean
  // Whether tool has local edits not yet saved — gates the Save button
  // below (nothing to send if unchanged) the same way ToolEditSheet.tsx's
  // mobile equivalent gates its own Save.
  dirty?: boolean
  saveError?: string | null
  onChange: (next: Tool) => void
  onSave: () => void
  onRemove: () => void
}) {
  const templateLabel = tool.sourceTemplate
    ? (TEMPLATES.find((t) => t.key === tool.sourceTemplate)?.label ?? tool.sourceTemplate)
    : null
  const lockedParamNames = tool.sourceTemplate ? (MOCK_LOCKED_PARAM_NAMES[tool.sourceTemplate] ?? []) : []
  // Split so the name's problems can render under its own input while
  // everything else stays in the list below. An issue with no `field` is
  // one validate.ts hasn't attributed to an input, so it belongs there too.
  const nameIssues = issues.filter((issue) => issue.field === 'name')
  const descriptionIssues = issues.filter((issue) => issue.field === 'description')
  const parameterIssues = issues.filter((issue) => issue.field === 'parameters')
  // Anything validate.ts hasn't attributed to an input still needs somewhere
  // to go, so it keeps the list — which is now empty in the common cases.
  const unattributedIssues = issues.filter((issue) => !issue.field)

  return (
    <form
      className={styles.toolForm}
      onSubmit={(e) => {
        e.preventDefault()
        onSave()
      }}
    >
      <div className={styles.toolFormHeader}>
        <div className={styles.toolNameField}>
          {/* Outlined field: the label sits on the top border rather than
              above the box (see .outlined, shared with Description). It
              stays a real <label htmlFor>, so clicking it still focuses
              the input. */}
          <div className={styles.outlined}>
            <label className={styles.outlinedLabel} htmlFor="tool-name">
              Name
            </label>
            <input
              id="tool-name"
              className={styles.toolNameInput}
              placeholder="tool_name"
              value={tool.name}
              onChange={(e) => onChange({ ...tool, name: e.target.value })}
            />
          </div>
          {/* The name's own problems sit under its box, where the fix is,
              rather than in the list below with everything else. The hint
              gives way to them so the two never stack up as two lines of
              guidance competing for the same spot. */}
          {nameIssues.length > 0 ? (
            nameIssues.map((issue, i) => (
              <p key={i} className={styles.toolNameError}>
                {issue.message}
              </p>
            ))
          ) : (
            <p className={styles.toolNameHint}>The tool's identifier as the model calls it — snake_case, unique within this app.</p>
          )}
          {templateLabel && (
            <span className={styles.sourceTemplate} title="Built from this template in the guided wizard">
              From template: {templateLabel}
            </span>
          )}
        </div>
      </div>

      {unattributedIssues.length > 0 && (
        <ul className="issue-list">
          {unattributedIssues.map((issue, i) => (
            <li key={i}>{issue.message}</li>
          ))}
        </ul>
      )}

      {saveError && (
        <ul className="issue-list">
          <li>Couldn't save: {saveError}</li>
        </ul>
      )}

      {/* Same outlined treatment as Name: label on the border, help text
          below the box. A <div> rather than a <label> wrapper now — the
          floating label owns htmlFor, and nesting it inside another label
          would give the textarea two. */}
      <div className="field">
        <div className={styles.outlined}>
          <label className={styles.outlinedLabel} htmlFor="tool-description">
            Description
          </label>
          <textarea
            id="tool-description"
            className="tool-description-input"
            rows={3}
            maxLength={MAX_DESCRIPTION}
            placeholder="What does this tool do, and when should the model call it?"
            value={tool.description}
            onChange={(e) => onChange({ ...tool, description: e.target.value })}
          />
        </div>
        {/* Guidance on the left, counter on the right — one row, so the
            counter keeps its corner whether the line beside it is the hint
            or an error. */}
        <div className={styles.fieldFooter}>
          {descriptionIssues.length > 0 ? (
            <span>
              {descriptionIssues.map((issue, i) => (
                <p key={i} className={styles.fieldError}>
                  {issue.message}
                </p>
              ))}
            </span>
          ) : (
            <p className={styles.toolNameHint}>
              Explains to the model when and why to call this tool — written for the model's benefit, not yours.
            </p>
          )}
          <span
            className={`${styles.charCount}${
              tool.description.length >= MAX_DESCRIPTION ? ' ' + styles.charCountFull : ''
            }`}
          >
            {tool.description.length} / {MAX_DESCRIPTION}
          </span>
        </div>
      </div>

      <div className="field">
        <span className="micro-label">Parameters</span>
        <p className="thought-copy">The arguments the model must fill in when it calls this tool.</p>
        <SchemaEditor
          schema={tool.parameters}
          onChange={(next) => onChange({ ...tool, parameters: next })}
          hideRootHeader
          lockedPropertyNames={lockedParamNames}
        />
        {parameterIssues.map((issue, i) => (
          <p key={i} className={styles.fieldError}>
            {issue.message}
          </p>
        ))}
      </div>

      <div className="field">
        <span className="micro-label">Kind</span>
        <p className="thought-copy">
          Unchecked (action, the default): the call is forwarded to the page and the model is told
          it succeeded, but whatever the page sends back is never seen by the model — use this for
          fire-and-forget effects like clicking a button. Checked (query): the model waits for the
          page's actual answer and reasons about it — use this whenever the model needs what the
          page sends back, like a lookup's result.
        </p>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={tool.kind === 'query'}
            onChange={(e) => onChange({ ...tool, kind: e.target.checked ? 'query' : 'action' })}
          />
          Wait for the page's answer and feed it back to the model (query)
        </label>
      </div>

      {/* Save sits at the foot of the form, after every field it commits,
          rather than in the header beside the name — you reach it by
          finishing the form, not by scrolling back up. Kept on its own row
          above the danger zone so the primary action never sits shoulder to
          shoulder with "Delete tool". */}
      <div className={styles.saveRow}>
        <button type="submit" className="primary" disabled={busy || !dirty || issues.length > 0}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>

      <div className={styles.dangerZone}>
        <button type="button" className="text-btn danger" onClick={onRemove}>
          Delete tool
        </button>
      </div>
    </form>
  )
}

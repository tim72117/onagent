import { useState } from 'react'
import type { ParameterSchema, Tool } from './schema'
import { emptyObjectSchema, emptyTool, TOOL_NAME_RE } from './schema'
import { SchemaEditor } from './SchemaEditor'
import styles from './ToolWizard.module.css'

const STEPS = ['Template', 'Name', 'Description', 'Parameters', 'Returns'] as const
type Step = (typeof STEPS)[number]

function param(type: ParameterSchema['type'], description: string): ParameterSchema {
  return { type, description }
}

function objectParams(properties: Record<string, ParameterSchema>): ParameterSchema {
  return { type: 'object', properties, required: Object.keys(properties) }
}

type IconName =
  | 'form'
  | 'click'
  | 'click-list'
  | 'navigate'
  | 'select'
  | 'value'
  | 'add'
  | 'remove'
  | 'search'

// Single-color line icons (matches the landing page's stroke="currentColor"
// style) — deliberately not colored emoji, so a template card reads as part
// of this app's own UI rather than borrowing a platform's emoji rendering.
function TemplateIcon({ name }: { name: IconName }) {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  }
  switch (name) {
    case 'form':
      return (
        <svg {...common}>
          <rect x="4" y="5" width="16" height="14" rx="2" />
          <path d="M8 10h8M8 14h5" />
        </svg>
      )
    case 'click':
      return (
        <svg {...common}>
          <path d="M9 3v4M4.5 6.5l2.8 2.8M3 12h4" />
          <path d="M12 11l8 3-3.5 1.5L15 19z" />
        </svg>
      )
    case 'click-list':
      return (
        <svg {...common}>
          <path d="M4 6h9M4 12h6M4 18h4" />
          <circle cx="18" cy="14" r="4" />
          <path d="M18 12v2l1.5 1" />
        </svg>
      )
    case 'navigate':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M15.5 8.5l-2 5-5 2 2-5z" />
        </svg>
      )
    case 'select':
      return (
        <svg {...common}>
          <rect x="4" y="4" width="16" height="16" rx="3" />
          <path d="M8 12l2.5 2.5L16 9" />
        </svg>
      )
    case 'value':
      return (
        <svg {...common}>
          <path d="M5 9h14M5 15h14M9 4L7 20M17 4l-2 16" />
        </svg>
      )
    case 'add':
      return (
        <svg {...common}>
          <rect x="4" y="4" width="16" height="16" rx="3" />
          <path d="M12 8v8M8 12h8" />
        </svg>
      )
    case 'remove':
      return (
        <svg {...common}>
          <path d="M5 7h14M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2M7 7l1 12a1 1 0 001 1h6a1 1 0 001-1l1-12" />
        </svg>
      )
    case 'search':
      return (
        <svg {...common}>
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="M20 20l-5-5" />
        </svg>
      )
  }
}

// One entry per common shape a UI-driving tool takes — covers filling
// input, triggering an action, moving between views, toggling a choice,
// setting a number, and adding/removing/searching a list, which between
// them account for most of what "AI operates your UI" actually looks like
// in practice (see the case-study examples on the landing page). Each is a
// starting point, not a final answer — every field stays editable in the
// steps that follow.
//
// customizeParams/customizeName distinguish two kinds of field in a
// template: values the model fills in at call time (a search keyword, a
// quantity, an item's own label) generalize fine as written and rarely
// need touching — but anything that names a specific piece of THIS
// developer's UI (which field, which button) is a placeholder that must be
// replaced with their app's real name before the tool means anything.
interface Template {
  key: string
  icon: IconName
  label: string
  hint: string
  tool: Tool
  customizeParams?: string[]
  // Set when the tool's own name/identity needs customizing, with the
  // reason why — the same "no parameters, so one tool per button" logic
  // doesn't apply to every case that needs a name change.
  customizeName?: string
  // Set for a template that's deliberately designed to take no parameters
  // (e.g. one fixed button) — the Parameters step is skipped entirely
  // rather than making someone click through a step with nothing to fill
  // in. Not inferred from an empty parameter list, since starting from
  // scratch also begins with none but that step is exactly where you'd add
  // some.
  noParameters?: boolean
}

// Exported so ToolForm can look up a tool's saved sourceTemplate key back
// to its human-readable label, without duplicating this list.
export const TEMPLATES: Template[] = [
  {
    key: 'fill_form',
    icon: 'form',
    label: 'Fill a form field',
    hint: 'Set a text value into a specific input.',
    tool: {
      name: 'fill_form',
      description: 'Fill a specific form field with a value.',
      parameters: objectParams({
        field: param('string', 'Which field to fill, e.g. "email" or "search"'),
        value: param('string', 'The value to enter'),
      }),
    },
    customizeParams: ['field'],
  },
  {
    key: 'click_button',
    icon: 'click',
    label: 'Click a fixed button',
    hint: 'One specific, one-off button — "Checkout", "Publish". No parameters needed.',
    tool: {
      name: 'click_button',
      description: 'Click a specific button on the page to trigger its action.',
      parameters: objectParams({}),
    },
    customizeName:
      "this tool takes no parameters, so it can only ever click one specific button — rename it to say exactly which one, e.g. click_checkout_button.",
    noParameters: true,
  },
  {
    key: 'click_list_item',
    icon: 'click-list',
    label: 'Click a button in a list',
    hint: 'Same button repeated per row — a delete/edit/select action on one specific entry.',
    tool: {
      name: 'click_list_item',
      description: 'Click a specific action button on one item in a list, identified by that item\'s id.',
      parameters: objectParams({
        itemId: param('string', 'The id of the list item to act on'),
      }),
    },
    customizeName:
      "\"click_list_item\" doesn't say what clicking does — rename it to the actual action, e.g. delete_list_item or select_list_item.",
  },
  {
    key: 'navigate_to',
    icon: 'navigate',
    label: 'Navigate to a page',
    hint: 'Move the user to a route, tab, or section.',
    tool: {
      name: 'navigate_to',
      description: 'Navigate to a specific page, tab, or section.',
      parameters: objectParams({
        path: param('string', 'The route or section to navigate to'),
      }),
    },
  },
  {
    key: 'select_option',
    icon: 'select',
    label: 'Select or toggle an option',
    hint: 'Check a box, pick from a list, turn a setting on/off.',
    tool: {
      name: 'select_option',
      description: 'Select or deselect a specific option, checkbox, or item.',
      parameters: objectParams({
        optionId: param('string', 'Which option to change'),
        selected: param('boolean', 'Whether it should be selected'),
      }),
    },
  },
  {
    key: 'set_value',
    icon: 'value',
    label: 'Set a numeric value',
    hint: 'Update a quantity, price, or other number.',
    tool: {
      name: 'set_value',
      description: 'Set a numeric field, such as a quantity or price, to a specific value.',
      parameters: objectParams({
        field: param('string', 'Which field to update'),
        value: param('number', 'The new value'),
      }),
    },
    customizeParams: ['field'],
  },
  {
    key: 'add_item',
    icon: 'add',
    label: 'Add an item to a list',
    hint: 'Add a new row, variant, or entry.',
    tool: {
      name: 'add_item',
      description: 'Add a new item to a list — a row, a variant, an entry.',
      parameters: objectParams({
        name: param('string', 'A name or label for the new item'),
      }),
    },
  },
  {
    key: 'remove_item',
    icon: 'remove',
    label: 'Remove an item',
    hint: 'Delete an existing entry by id.',
    tool: {
      name: 'remove_item',
      description: 'Remove an existing item, identified by its id.',
      parameters: objectParams({
        id: param('string', 'The identifier of the item to remove'),
      }),
    },
  },
  {
    key: 'search',
    icon: 'search',
    label: 'Search or filter',
    hint: 'Narrow the current view by a keyword.',
    tool: {
      name: 'search',
      description: 'Search or filter the current view by a keyword.',
      parameters: objectParams({
        query: param('string', 'The search or filter keyword'),
      }),
    },
  },
]

// Alternative to ToolForm's single dense form for building a brand-new tool
// — same underlying Tool shape and the same SchemaEditor for parameters/
// returns, just walked one field at a time, optionally starting from a
// template instead of a blank slate. Existing tools are still edited via
// the flat ToolForm; this only covers the creation moment, where someone
// unfamiliar with JSON Schema benefits most from being asked one thing at
// a time instead of facing the whole form at once.
export function ToolWizard({
  onCreate,
  onClose,
}: {
  onCreate: (tool: Tool) => void
  onClose: () => void
}) {
  const [stepIndex, setStepIndex] = useState(0)
  const [tool, setTool] = useState<Tool>(emptyTool())
  const [template, setTemplate] = useState<Template | null>(null)
  // Parameters is left out entirely for a template that's deliberately
  // built to take none (see Template.noParameters) — nothing to fill in
  // there, so it isn't a step to click through.
  const visibleSteps: Step[] = template?.noParameters ? STEPS.filter((s) => s !== 'Parameters') : [...STEPS]
  const step: Step = visibleSteps[stepIndex]

  const nameValid = TOOL_NAME_RE.test(tool.name.trim())
  const canAdvance =
    step === 'Name' ? nameValid : step === 'Description' ? tool.description.trim() !== '' : true

  function pickTemplate(t: Template | null) {
    setTemplate(t)
    setTool(t ? { ...t.tool } : emptyTool())
    setStepIndex(1)
  }

  function next() {
    if (stepIndex < visibleSteps.length - 1) setStepIndex(stepIndex + 1)
    else onCreate({ ...tool, name: tool.name.trim(), sourceTemplate: template?.key })
  }

  function back() {
    if (stepIndex > 0) setStepIndex(stepIndex - 1)
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="New tool (guided)">
      <div className="modal">
        <h2 className="modal-title">
          New tool — step {stepIndex + 1} of {visibleSteps.length}
        </h2>
        <div className={styles.wizardSteps} aria-hidden="true">
          {visibleSteps.map((s, i) => (
            <span
              key={s}
              className={
                i === stepIndex
                  ? `${styles.wizardStep} ${styles.wizardStepActive}`
                  : i < stepIndex
                    ? `${styles.wizardStep} ${styles.wizardStepDone}`
                    : styles.wizardStep
              }
            >
              {s}
            </span>
          ))}
        </div>

        {step === 'Template' && (
          <div className="field">
            <p className="modal-hint">
              Start from a common pattern, or build one from scratch.
            </p>
            <div className={styles.templateGrid}>
              {TEMPLATES.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  className={styles.templateCard}
                  onClick={() => pickTemplate(t)}
                >
                  <span className={styles.templateCardIcon}>
                    <TemplateIcon name={t.icon} />
                  </span>
                  <span className={styles.templateCardLabel}>{t.label}</span>
                  <span className={styles.templateCardHint}>{t.hint}</span>
                  {(t.customizeParams?.length || t.customizeName) && (
                    <span className={styles.templateCardCustomize}>
                      Customize: {t.customizeName ? 'tool name' : t.customizeParams!.join(', ')}
                    </span>
                  )}
                </button>
              ))}
            </div>
            <button type="button" className={`text-btn ${styles.templateBlankBtn}`} onClick={() => pickTemplate(null)}>
              Start from scratch instead →
            </button>
          </div>
        )}

        {step === 'Name' && (
          <label className="field">
            <span className="micro-label">Name</span>
            <input
              className="modal-input"
              autoFocus
              placeholder="tool_name"
              value={tool.name}
              onChange={(e) => setTool({ ...tool, name: e.target.value })}
            />
            <p className="modal-hint">
              What the model calls to invoke this tool — letters, digits, and underscores only.
            </p>
            {template?.customizeName && (
              <p className={`modal-hint ${styles.templateCustomizeCallout}`}>From the template: {template.customizeName}</p>
            )}
          </label>
        )}

        {step === 'Description' && (
          <label className="field">
            <span className="micro-label">Description</span>
            <textarea
              className="tool-description-input"
              autoFocus
              rows={4}
              placeholder="What does this tool do, and when should the model call it?"
              value={tool.description}
              onChange={(e) => setTool({ ...tool, description: e.target.value })}
            />
          </label>
        )}

        {step === 'Parameters' && (
          <div className="field">
            <span className="micro-label">Parameters</span>
            <p className="modal-hint">
              What information does the model need to provide when it calls this tool? Leave empty
              if it takes none.
            </p>
            {template?.customizeParams && template.customizeParams.length > 0 && (
              <p className={`modal-hint ${styles.templateCustomizeCallout}`}>
                From the template: check{' '}
                {template.customizeParams.map((p) => (
                  <code key={p}>{p}</code>
                ))}{' '}
                — that name is a placeholder, not necessarily what your app's field is actually
                called.
              </p>
            )}
            <SchemaEditor
              schema={tool.parameters}
              onChange={(next) => setTool({ ...tool, parameters: next })}
              hideRootHeader
            />
          </div>
        )}

        {step === 'Returns' && (
          <div className="field">
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={!!tool.returns}
                onChange={(e) =>
                  setTool({ ...tool, returns: e.target.checked ? emptyObjectSchema() : undefined })
                }
              />
              Declare a returns shape (for TypeScript codegen)
            </label>
            {tool.returns && (
              <SchemaEditor schema={tool.returns} onChange={(next) => setTool({ ...tool, returns: next })} />
            )}
          </div>
        )}

        <div className="modal-actions">
          <button type="button" className="text-btn" onClick={onClose}>
            Cancel
          </button>
          {stepIndex > 0 && (
            <button type="button" className="text-btn" onClick={back}>
              Back
            </button>
          )}
          {step !== 'Template' && (
            <button type="button" className="primary" disabled={!canAdvance} onClick={next}>
              {stepIndex < visibleSteps.length - 1 ? 'Next' : 'Create tool'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

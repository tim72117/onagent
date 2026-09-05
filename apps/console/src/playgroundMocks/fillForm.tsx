import { useRef, useState } from 'react'
import type { Tool } from '../schema'
import type { MockOutcome, MockRuntime } from './types'
import styles from './mocks.module.css'

// Fallback when the tool has no enum on its field parameter yet (e.g. a
// hand-written tools.yaml, or a tool saved before this default existed) —
// matches ToolWizard.tsx's TEMPLATES default for fill_form.
const DEFAULT_FORM_FIELDS = ['item', 'description']

// The "Fill a form field" wizard template is general-purpose — the model
// names which field to fill via its field argument at call time (see
// ToolWizard.tsx's TEMPLATES), not by the tool's own name. Playground has
// no way to know in advance what field name a future call will use, so it
// renders one mock input per option in the tool's own field parameter enum
// (see ToolWizard.tsx's TEMPLATES and SchemaEditor.tsx's enum editor — a
// developer can freely edit this list) rather than conjuring an input for
// whatever field name shows up. This keeps "no mock field with that name" a
// real, reachable failure — a dynamically-rendered input would make every
// call succeed, which would make the "observe, don't assume" pattern this
// file follows meaningless. The field parameter's *name* is still locked
// (see ToolForm.tsx's lockedPropertyNames) since invoke() below reads
// args.field by that literal key, but which values count as valid fields is
// entirely up to the enum's contents.
function formFields(tool: Tool | undefined): string[] {
  const enumValues = tool?.parameters.properties?.field?.enum
  return enumValues && enumValues.length > 0 ? enumValues : DEFAULT_FORM_FIELDS
}

// useFillFormMock implements MockRuntime for the "fill_form" wizard
// template. tool is this app's fill_form-template tool (undefined if none
// exists yet — see playgroundMocks/index.ts), read fresh each render so
// editing its field enum in the console updates the rendered inputs
// immediately, without needing Playground to remount. A human typing into
// one of the rendered inputs and a tool_call naming its field both funnel
// through the same setField() closure — two triggers for one real effect,
// not two independently maintained simulations (mirrors clickButton.tsx's
// click()). Unlike click_button, there's no flash timer: a filled field
// should stay filled — that's the actual meaning of "the form was filled" —
// so there's nothing here to clear on a timer or on unmount.
export function useFillFormMock(tool: Tool | undefined): MockRuntime {
  const fields = formFields(tool)
  const [values, setValues] = useState<Record<string, string>>({})
  // Mirrors `values` synchronously — see clickButton.tsx's flashedRef for
  // why invoke() needs a same-tick-readable value rather than the state
  // variable itself.
  const valuesRef = useRef<Record<string, string>>({})

  function setField(field: string, value: string) {
    const next = { ...valuesRef.current, [field]: value }
    valuesRef.current = next
    setValues(next)
  }

  function invoke(args: unknown): MockOutcome {
    const a = args as { field?: unknown; value?: unknown } | undefined
    const field = a?.field
    const value = a?.value

    if (typeof field !== 'string' || !fields.includes(field)) {
      // Honest failure — Playground only prepared mock inputs for this
      // tool's field enum; anything else has nothing real to fill.
      return {
        ok: false,
        error: `no mock form field named ${JSON.stringify(field ?? null)} in Playground (available: ${fields.join(', ')})`,
      }
    }
    if (typeof value !== 'string') {
      // Checked separately from the field check above so a non-string
      // value doesn't get misreported as "no such field" — the field name
      // may well be valid; it's the value's type that's wrong.
      return { ok: false, error: `fill_form's value must be a string; got ${typeof value}` }
    }

    setField(field, value)
    // valuesRef was just written synchronously by setField(), so this
    // reads the effect of the call just made, not a stale value.
    if (valuesRef.current[field] === value) {
      return { ok: true, result: { message: `"${field}" now contains "${value}"`, field, value } }
    }
    return { ok: false, error: `filled "${field}" but the field's value did not take effect` }
  }

  function render() {
    return (
      <div className={styles.mockGroup}>
        {fields.map((field) => (
          <label key={field} className={styles.mockFieldRow}>
            <span className={styles.mockFieldLabel}>{field}</span>
            <input
              className={styles.mockFieldInput}
              type="text"
              value={values[field] ?? ''}
              onChange={(e) => setField(field, e.target.value)}
            />
          </label>
        ))}
      </div>
    )
  }

  return { render, invoke }
}

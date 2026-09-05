import { useEffect, useRef, useState } from 'react'
import type { Tool } from '../schema'
import type { MockOutcome, MockRuntime } from './types'
import styles from './mocks.module.css'

// How long a mock button stays visibly "clicked" after a matching tool_call
// arrives — long enough to notice, short enough that a burst of tool calls
// (a real click_button tool being called repeatedly) still reads as
// distinct events rather than one stuck-on highlight.
const CLICK_FLASH_MS = 900

// Fallback when the tool has no enum on its label parameter yet (e.g. a
// hand-written tools.yaml, or a tool saved before this default existed) —
// matches ToolWizard.tsx's TEMPLATES default for click_button so a
// freshly-created-from-wizard tool and an old one behave the same.
const DEFAULT_BUTTON_LABELS = ['Confirm', 'Cancel']

// The "Click a button" wizard template is a general-purpose tool — the
// model picks which button to click via its label argument at call time
// (see ToolWizard.tsx's TEMPLATES), not by the tool's own name. Playground
// has no way to know in advance what label a future call will name, so it
// can't render "one button per click_button tool" the way a fixed-target
// template could. Instead it renders one mock button per option in the
// tool's own label parameter enum (see ToolWizard.tsx's TEMPLATES and
// SchemaEditor.tsx's enum editor — a developer can freely edit this list) —
// a call naming one of these gets a real, observed effect; anything else
// gets an honest "no mock button with that label" failure rather than a
// fabricated success. The label parameter's *name* is still locked (see
// ToolForm.tsx's lockedPropertyNames) since invoke() below reads args.label
// by that literal key, but which values count as valid buttons is entirely
// up to the enum's contents.
function buttonLabels(tool: Tool | undefined): string[] {
  const enumValues = tool?.parameters.properties?.label?.enum
  return enumValues && enumValues.length > 0 ? enumValues : DEFAULT_BUTTON_LABELS
}

// useClickButtonMock implements MockRuntime for the "click_button" wizard
// template. tool is this app's click_button-template tool (undefined if
// none exists yet — see playgroundMocks/index.ts), read fresh each render
// so editing its label enum in the console updates the rendered buttons
// immediately, without needing Playground to remount. A human clicking one
// of the rendered buttons and a tool_call naming its label both funnel
// through the same click() closure — two triggers for one real effect, not
// two independently maintained simulations (see click's call sites in
// render() and invoke() below).
export function useClickButtonMock(tool: Tool | undefined): MockRuntime {
  const labels = buttonLabels(tool)
  const [flashed, setFlashed] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Mirrors `flashed` synchronously — setFlashed's update isn't visible to
  // code running in the same tick that called it (React state updates are
  // asynchronous relative to the call site), but invoke() needs to
  // observe, immediately after calling click(), whether the clicked state
  // actually took effect, rather than assuming it did.
  const flashedRef = useRef<string | null>(null)

  // Clears any pending flash timer on unmount so it doesn't fire setState
  // after this hook's owner is gone.
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  function click(label: string) {
    if (timerRef.current) clearTimeout(timerRef.current)
    setFlashed(label)
    flashedRef.current = label
    timerRef.current = setTimeout(() => {
      setFlashed(null)
      flashedRef.current = null
    }, CLICK_FLASH_MS)
  }

  function invoke(args: unknown): MockOutcome {
    const label = (args as { label?: string } | undefined)?.label

    if (!label || !labels.includes(label)) {
      // Honest failure, not a fabricated success — Playground only
      // prepared mock buttons for this tool's label enum; a call naming
      // anything else (or omitting label entirely) has nothing real to
      // click.
      return {
        ok: false,
        error: `no mock button labeled ${JSON.stringify(label ?? null)} in Playground (available: ${labels.join(', ')})`,
      }
    }

    click(label)
    // flashedRef was just written synchronously by click(), so this reads
    // the effect of the call just made, not a stale value.
    if (flashedRef.current === label) {
      return { ok: true, result: { message: `"${label}" clicked — button now shows the clicked state` } }
    }
    return { ok: false, error: `clicked "${label}" but its clicked state did not take effect` }
  }

  function render() {
    return (
      <div className={styles.mockGroup}>
        {labels.map((label) => (
          <button
            key={label}
            type="button"
            className={label === flashed ? `${styles.mockButton} ${styles.mockButtonClicked}` : styles.mockButton}
            onClick={() => click(label)}
          >
            {label}
          </button>
        ))}
      </div>
    )
  }

  return { render, invoke }
}

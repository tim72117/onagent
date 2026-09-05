import type { Tool } from '../schema'
import { useClickButtonMock } from './clickButton'
import { useFillFormMock } from './fillForm'
import type { MockRuntime } from './types'

export type { MockOutcome, MockRuntime } from './types'

// Every ToolWizard template key with a registered Playground mock, in the
// order their UI blocks render in the left rail. Adding a new template's
// mock is: write its useXxxMock(tool) hook (see clickButton.tsx/fillForm.tsx
// for the pattern), call it below, and add its key here — nothing in
// Playground.tsx itself needs to change.
export const MOCK_TEMPLATE_KEYS = ['click_button', 'fill_form'] as const

// Top-level parameter names each registered template's mock reads by
// literal key (see clickButton.tsx/fillForm.tsx's invoke()) — renaming or
// removing one of these on a tool silently breaks its mock, since the tool
// would then call with a different key than invoke() reads. ToolForm.tsx
// passes the matching entry to SchemaEditor's lockedPropertyNames so the
// console UI prevents that at the source, rather than the mock having to
// guess at a renamed parameter's new name. Values (the enum options each
// parameter accepts) stay fully editable — see buttonLabels/formFields.
export const MOCK_LOCKED_PARAM_NAMES: Record<string, string[]> = {
  click_button: ['label'],
  fill_form: ['field', 'value'],
}

// useMockRuntimes calls every registered template's hook unconditionally,
// every render — required by the Rules of Hooks, since which templates
// are "active" (i.e. have a matching tool in this app) can change across
// renders as the developer edits their app's tools. Each hook's own state
// only actually does anything once Playground renders its UI and/or
// invokes it, which it gates on whether a matching tool exists (see
// Playground.tsx's activeTemplateKeys) — an inactive mock just sits idle.
// tools is this app's full tool list — each hook looks up its own matching
// tool (by sourceTemplate) to read config like a button's label enum or a
// form field's field enum, so editing that in the console updates the mock
// without needing Playground to remount (see clickButton.tsx/fillForm.tsx's
// buttonLabels/formFields). If more than one tool shares the same
// sourceTemplate, the first one wins — Playground only ever renders one
// mock block per template.
//
// Hooks are called explicitly here (not via MOCK_TEMPLATE_KEYS.map(...))
// so the Rules of Hooks compliance (fixed call order, fixed count) is
// visible by inspection rather than depending on MOCK_TEMPLATE_KEYS never
// changing shape at runtime.
export function useMockRuntimes(tools: Tool[]): Record<string, MockRuntime> {
  return {
    click_button: useClickButtonMock(tools.find((t) => t.sourceTemplate === 'click_button')),
    fill_form: useFillFormMock(tools.find((t) => t.sourceTemplate === 'fill_form')),
  }
}

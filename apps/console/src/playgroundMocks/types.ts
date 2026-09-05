import type { ReactNode } from 'react'

// The contract every ToolWizard-template mock implements — see
// playgroundMocks/index.ts's useMockRuntimes for how Playground.tsx
// dispatches to these without knowing any template's parameter shape or
// internal state.

// A tool_call/tool_query's outcome, ready to spread straight into
// ToolResultPayload (Playground.tsx). Deliberately a discriminated union
// (not { ok, result?, error? }) so a mock can't accidentally produce
// ok:true with a leftover error, or vice versa.
export type MockOutcome = { ok: true; result: unknown } | { ok: false; error: string }

export interface MockRuntime {
  // This mock's UI, rendered in Playground's left rail whenever any tool
  // in the app uses this template. Must be safe to call on every render —
  // it's invoked unconditionally by useMockRuntimes even when no matching
  // tool exists (see MOCK_TEMPLATE_KEYS/activeTemplateKeys for the
  // presence check Playground applies around the returned node).
  render: () => ReactNode

  // Runs this mock's effect for a tool_call's args and reports what
  // actually happened. Must be synchronous: the "observe, don't assume"
  // pattern this codebase uses throughout Playground depends on invoke
  // being able to change state and read back whether it took effect in
  // the same tick (state setters aren't visible to same-tick reads, so
  // implementations mirror their state into a ref written synchronously —
  // see clickButton.tsx/fillForm.tsx for the pattern). If a mock ever
  // needs to be genuinely asynchronous, MockOutcome would need to become
  // MockOutcome | Promise<MockOutcome> and handleToolMessage would need a
  // timeout race alongside it — deliberately not built until a real case
  // needs it.
  invoke: (args: unknown) => MockOutcome
}

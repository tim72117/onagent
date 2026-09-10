// Mirrors backend/internal/toolschema/schema.go field-for-field, so the
// YAML this editor produces round-trips through toolschema.LoadFile without
// translation. Keep the two in sync by hand — there is no shared source of
// truth between the Go and TS type definitions.

export type ParamType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object'

export interface ParameterSchema {
  type: ParamType
  description?: string
  properties?: Record<string, ParameterSchema>
  items?: ParameterSchema
  required?: string[]
  enum?: string[]
}

export type ToolKind = 'action' | 'query'

export interface Tool {
  // Database surrogate key (tools.id) — absent for a tool that has never
  // been saved yet (a brand-new tool the editor is about to create).
  // Present (and truthy) once the backend has assigned one, which is what
  // lets api.saveToolByID address this exact row for every subsequent
  // save, including a rename, as a single atomic update — see api.ts's
  // saveTool/saveToolByID split and App.tsx's persistTool for the bug this
  // replaced (rename used to be delete-old-name-then-insert-new-name, two
  // separate requests with a window where a failure between them lost the
  // tool entirely).
  id?: number
  name: string
  description: string
  parameters: ParameterSchema
  returns?: ParameterSchema
  // Mirrors toolschema.Tool.Kind. Empty/undefined means 'action' (the
  // backend's own default — see backend/internal/toolschema/registry.go's
  // saveTool, which fills an empty Kind in as ToolKindAction on write).
  // 'query' blocks the in-flight prompt until the front-end answers with
  // real data, which is then fed back to the LLM — see that Go field's own
  // doc comment for the full behavioral difference. Must round-trip
  // through every save: the backend's write is a full-column update, not a
  // partial one, so a save that omits this field silently overwrites an
  // existing 'query' tool back to 'action' with no error (see
  // docs/audit-functional.md's 2026-09-11 entry for the bug this caused).
  kind?: ToolKind
  // Which ToolWizard template (see ToolWizard.tsx's TEMPLATES) this tool
  // was built from, if any — round-trips through the backend
  // (toolschema.Tool.SourceTemplate). Shown as a display hint in ToolForm,
  // and also drives which Playground mock (if any) this tool gets — see
  // playgroundMocks/index.ts's useMockRuntimes and MOCK_LOCKED_PARAM_NAMES.
  // Never affects backend validation. Undefined for tools built from the
  // blank form, hand-written tools.yaml, or saved before this existed.
  sourceTemplate?: string
}

export interface App {
  appId: string
  tools: Tool[]
  /** Custom want agent system prompt for this app. Absent/"" means the
   * platform default applies. */
  thought?: string
}

// Same regexp as toolschema/loader.go's nameRE.
export const TOOL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/

// Mirrors backend/internal/inference/want_tools.go's defaultThought exactly
// — shown to developers as "what applies if you leave Thought empty."
// Keep in sync by hand if the backend's copy changes.
export const DEFAULT_THOUGHT =
  'You are a tool-selection assistant embedded in a web page. ' +
  'The user is talking to the page, not to you directly. When their ' +
  'message calls for an action the page can perform, call the single ' +
  'matching tool with well-formed arguments; the page executes it, ' +
  'not you. If nothing needs doing, just reply in plain text. Never ' +
  'ask the user to wait or claim you performed an action yourself — ' +
  'the tool call itself is the action.'

export function emptyObjectSchema(): ParameterSchema {
  return { type: 'object', properties: {}, required: [] }
}

export function emptyTool(): Tool {
  return {
    name: '',
    description: '',
    parameters: emptyObjectSchema(),
  }
}


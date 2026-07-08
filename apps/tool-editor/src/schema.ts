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

export interface Tool {
  name: string
  description: string
  parameters: ParameterSchema
  returns?: ParameterSchema
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


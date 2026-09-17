// Mirrors the validation in backend/internal/toolschema/loader.go's
// LoadFile, so a tool that passes here won't fail to load once pasted into
// backend/tools/*.yaml — this is meant to catch mistakes before the round
// trip through a real backend restart, not to be a superset or subset of
// the Go validation.

import type { App } from './schema'
import { TOOL_NAME_RE } from './schema'

export interface ValidationIssue {
  toolIndex: number | null // null = app-level issue (e.g. missing appId)
  message: string
  // Which input the issue belongs under, when it belongs to one — lets a
  // form show it beneath that field instead of in a list at the top.
  // Optional: the summary views (Sidebar, ToolList, MobileWorkspaceCards)
  // only read `message`/`toolIndex` and are unaffected.
  field?: 'name' | 'description' | 'parameters'
}

export function validateApp(app: App): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  if (!app.appId.trim()) {
    issues.push({ toolIndex: null, message: 'appId is required' })
  }

  const seen = new Set<string>()
  app.tools.forEach((tool, i) => {
    if (!TOOL_NAME_RE.test(tool.name)) {
      // Describes the rule in words rather than printing TOOL_NAME_RE's
      // source: the regex tells someone who already knows the answer what
      // they did wrong, and tells everyone else nothing.
      issues.push({
        toolIndex: i,
        field: 'name',
        message: tool.name.trim()
          ? 'Use letters, digits and underscores only, starting with a letter or underscore.'
          : 'Name is required.',
      })
    } else if (seen.has(tool.name)) {
      issues.push({
        toolIndex: i,
        field: 'name',
        message: `Another tool in this app is already called ${tool.name}.`,
      })
    } else {
      seen.add(tool.name)
    }

    // No "tool <name> is missing…" prefix on these: the form shows each
    // message under the input it belongs to, where naming the tool again
    // says nothing the surrounding page hasn't. The summary views pair the
    // message with the tool themselves (see Sidebar/ToolList).
    if (!tool.description.trim()) {
      issues.push({
        toolIndex: i,
        field: 'description',
        message: 'Description is required — the model relies on it to decide when to call this tool.',
      })
    }
    if (!tool.parameters.type) {
      issues.push({
        toolIndex: i,
        field: 'parameters',
        message: 'Parameters needs a type.',
      })
    }
  })

  return issues
}

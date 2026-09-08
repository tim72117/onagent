// Preview generator for the YAML shape toolschema.LoadFile expects — a
// read-only preview for the developer to copy into backend/tools/<app>.yaml;
// this package does not write to the backend. Used to mirror
// backend/internal/codegen/{llmschema,typescript}.go's JSON/TypeScript
// output too, but PreviewPanel.tsx dropped those two tabs (YAML only now),
// so toLLMTools/toLLMToolsJSON/toTypeScript and their helpers were removed
// as dead code.

import { stringify as yamlStringify } from 'yaml'
import type { App, ParameterSchema, Tool } from './schema'

// --- YAML (toolschema.LoadFile input shape) --------------------------------

export function toYAML(app: App): string {
  // yaml.stringify keeps key order as inserted; build plain objects in the
  // same field order toolschema.Tool declares so generated files read the
  // same way as the hand-written examples in backend/tools/.
  const plain = {
    appId: app.appId,
    tools: app.tools.map(toolToPlain),
  }
  return yamlStringify(plain, { indent: 2 })
}

function toolToPlain(t: Tool) {
  const out: Record<string, unknown> = {
    name: t.name,
    description: t.description,
    parameters: schemaToPlain(t.parameters),
  }
  if (t.returns) out.returns = schemaToPlain(t.returns)
  return out
}

function schemaToPlain(s: ParameterSchema): Record<string, unknown> {
  const out: Record<string, unknown> = { type: s.type }
  if (s.description) out.description = s.description
  if (s.properties && Object.keys(s.properties).length > 0) {
    out.properties = Object.fromEntries(
      Object.entries(s.properties).map(([k, v]) => [k, schemaToPlain(v)]),
    )
  }
  if (s.items) out.items = schemaToPlain(s.items)
  if (s.required && s.required.length > 0) out.required = s.required
  if (s.enum && s.enum.length > 0) out.enum = s.enum
  return out
}


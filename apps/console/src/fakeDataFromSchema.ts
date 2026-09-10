import type { ParameterSchema } from './schema'

// Generates a schema-shaped placeholder value for a tool's `returns` when
// Playground has no real mock effect to run it against (see Playground.tsx's
// handleToolMessage) — lets a query tool's caller get *something* structured
// back to reason about, instead of always failing outright. Deliberately
// synchronous and pure: same schema in, same shape out every time, so a
// developer re-running the same prompt sees consistent fake data rather than
// values that shift call to call for no reason.
//
// This is fabricated data, not an observed effect — unlike playgroundMocks/'s
// invoke() functions (which report what a real mock UI actually did), this
// has no ground truth to check itself against. Playground.tsx labels its
// use accordingly (see the "fabricated" wording in its tool_call message)
// so it's never mistaken for a real mock's honestly-observed result.
export function fakeDataFromSchema(schema: ParameterSchema): unknown {
  switch (schema.type) {
    case 'string':
      if (schema.enum && schema.enum.length > 0) return schema.enum[0]
      return schema.description ?? 'placeholder'
    case 'number':
      return 1
    case 'integer':
      return 1
    case 'boolean':
      return true
    case 'array':
      return schema.items ? [fakeDataFromSchema(schema.items)] : []
    case 'object': {
      const result: Record<string, unknown> = {}
      const properties = schema.properties ?? {}
      for (const [key, propSchema] of Object.entries(properties)) {
        result[key] = fakeDataFromSchema(propSchema)
      }
      return result
    }
  }
}

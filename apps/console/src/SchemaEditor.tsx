// Recursive editor for a ParameterSchema — handles the "object" (properties
// + required) and "array" (items) recursion toolschema.ParameterSchema
// allows. Renders one level of nesting per <fieldset>; deeper levels nest
// visually via indentation.

import type { ParamType, ParameterSchema } from './schema'
import styles from './SchemaEditor.module.css'

const PARAM_TYPES: ParamType[] = ['string', 'number', 'integer', 'boolean', 'array', 'object']

function newProperty(): ParameterSchema {
  return { type: 'string' }
}

export function SchemaEditor({
  schema,
  onChange,
  depth = 0,
  hideRootHeader = false,
}: {
  schema: ParameterSchema
  onChange: (next: ParameterSchema) => void
  depth?: number
  // A tool's top-level parameters schema must always stay type "object" —
  // OpenAI/Anthropic tool-calling conventions require it (see Tool.
  // Parameters' doc comment in toolschema/schema.go) — so the type
  // dropdown and object-level description this component otherwise always
  // renders at the top (letting you switch it to "string"/"number"/etc,
  // which would produce a broken tool) are pure noise there: for a tool
  // with no properties at all (e.g. one built from the "Click a fixed
  // button" wizard template), they're the only thing this editor renders,
  // and read as a stray, unlabeled row rather than deliberate empty
  // state. ToolForm passes this for the parameters editor only — returns
  // can legitimately be any type at its root, so it keeps the selector.
  hideRootHeader?: boolean
}) {
  const properties = schema.properties ?? {}
  const required = new Set(schema.required ?? [])
  const propNames = Object.keys(properties)

  function setType(type: ParamType) {
    const next: ParameterSchema = { type, description: schema.description }
    if (type === 'object') {
      next.properties = schema.properties ?? {}
      next.required = schema.required ?? []
    } else if (type === 'array') {
      next.items = schema.items ?? { type: 'string' }
    } else if (type === 'string') {
      next.enum = schema.enum
    }
    onChange(next)
  }

  function addProperty() {
    let name = 'field'
    let n = 1
    while (name in properties) name = `field${n++}`
    onChange({ ...schema, properties: { ...properties, [name]: newProperty() } })
  }

  function renameProperty(oldName: string, newName: string) {
    if (!newName || newName === oldName || newName in properties) return
    const nextProps = { ...properties }
    delete nextProps[oldName]
    nextProps[newName] = properties[oldName]
    const nextRequired = required.has(oldName)
      ? [...schema.required!.filter((r) => r !== oldName), newName]
      : schema.required
    onChange({ ...schema, properties: nextProps, required: nextRequired })
  }

  function updateProperty(name: string, next: ParameterSchema) {
    onChange({ ...schema, properties: { ...properties, [name]: next } })
  }

  function removeProperty(name: string) {
    const nextProps = { ...properties }
    delete nextProps[name]
    onChange({
      ...schema,
      properties: nextProps,
      required: schema.required?.filter((r) => r !== name),
    })
  }

  function toggleRequired(name: string) {
    const isRequired = required.has(name)
    const nextRequired = isRequired
      ? (schema.required ?? []).filter((r) => r !== name)
      : [...(schema.required ?? []), name]
    onChange({ ...schema, required: nextRequired })
  }

  return (
    <div className={depth > 0 ? styles.nested : undefined}>
      {!hideRootHeader && (
        <div className={styles.row}>
          <select value={schema.type} onChange={(e) => setType(e.target.value as ParamType)}>
            {PARAM_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <label className="inline-label">
            Description
            <input
              placeholder="What this field is for"
              value={schema.description ?? ''}
              onChange={(e) => onChange({ ...schema, description: e.target.value })}
            />
          </label>
        </div>
      )}

      {schema.type === 'string' && (
        <div className={`${styles.row} ${styles.sub}`}>
          <label className="inline-label">
            Enum (comma-separated, optional)
            <input
              value={(schema.enum ?? []).join(', ')}
              onChange={(e) => {
                const vals = e.target.value
                  .split(',')
                  .map((v) => v.trim())
                  .filter(Boolean)
                onChange({ ...schema, enum: vals.length ? vals : undefined })
              }}
            />
          </label>
        </div>
      )}

      {schema.type === 'array' && (
        <div className={styles.sub}>
          <div className={styles.label}>Items</div>
          <SchemaEditor
            schema={schema.items ?? { type: 'string' }}
            onChange={(next) => onChange({ ...schema, items: next })}
            depth={depth + 1}
          />
        </div>
      )}

      {schema.type === 'object' && (
        <div className={styles.sub}>
          {propNames.length === 0 && <div className={styles.empty}>No properties</div>}
          {propNames.map((name) => (
            <div key={name} className={styles.property}>
              <div className={styles.row}>
                <input
                  className={styles.propName}
                  value={name}
                  onChange={(e) => renameProperty(name, e.target.value)}
                />
                <label className={styles.required}>
                  <input
                    type="checkbox"
                    checked={required.has(name)}
                    onChange={() => toggleRequired(name)}
                  />
                  required
                </label>
                <button type="button" className="icon-btn" onClick={() => removeProperty(name)} aria-label="Remove property">
                  ×
                </button>
              </div>
              <SchemaEditor
                schema={properties[name]}
                onChange={(next) => updateProperty(name, next)}
                depth={depth + 1}
              />
            </div>
          ))}
          <button type="button" className="text-btn" onClick={addProperty}>
            + Add property
          </button>
        </div>
      )}
    </div>
  )
}

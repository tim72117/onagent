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
  lockedPropertyNames,
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
  // Top-level parameter names Playground's mock for this tool's
  // sourceTemplate reads by literal key (e.g. "label" for click_button,
  // "field"/"value" for fill_form — see playgroundMocks/*.tsx's invoke()).
  // Renaming or removing one of these silently breaks the mock: the tool
  // calls with the new key, but invoke() still reads the old one and gets
  // undefined. Only ToolForm passes this, for the root parameters editor —
  // nested levels (array items, sub-objects) and the returns editor have
  // no such dependency, so they're left fully editable.
  lockedPropertyNames?: string[]
}) {
  const properties = schema.properties ?? {}
  const required = new Set(schema.required ?? [])
  const propNames = Object.keys(properties)
  const locked = new Set(lockedPropertyNames ?? [])

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
    // Guards the rename itself, not just the input's readOnly attribute —
    // readOnly only stops keyboard input, and this is the actual gate a
    // locked name must not get past regardless of how onChange fired.
    if (locked.has(oldName)) return
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
    // Guards the removal itself, not just the button's disabled attribute
    // — same reasoning as renameProperty's locked check above.
    if (locked.has(name)) return
    const nextProps = { ...properties }
    delete nextProps[name]
    onChange({
      ...schema,
      properties: nextProps,
      required: schema.required?.filter((r) => r !== name),
    })
  }

  function toggleRequired(name: string) {
    // Guards the toggle itself, not just the checkbox's disabled attribute
    // — same reasoning as renameProperty/removeProperty's locked checks
    // above. A locked parameter's required-ness is part of what the
    // template's mock expects (e.g. click_button's label arriving on every
    // call), so it's fixed together with the name.
    if (locked.has(name)) return
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
                  className={locked.has(name) ? `${styles.propName} ${styles.propNameLocked}` : styles.propName}
                  value={name}
                  readOnly={locked.has(name)}
                  title={locked.has(name) ? 'This parameter name is used by the Playground mock for this tool’s template and can’t be renamed.' : undefined}
                  onChange={(e) => renameProperty(name, e.target.value)}
                />
                <label className={styles.required}>
                  <input
                    type="checkbox"
                    checked={required.has(name)}
                    disabled={locked.has(name)}
                    title={locked.has(name) ? 'This parameter’s required-ness is fixed by the Playground mock for this tool’s template.' : undefined}
                    onChange={() => toggleRequired(name)}
                  />
                  required
                </label>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => removeProperty(name)}
                  disabled={locked.has(name)}
                  title={locked.has(name) ? 'This parameter is used by the Playground mock for this tool’s template and can’t be removed.' : undefined}
                  aria-label="Remove property"
                >
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

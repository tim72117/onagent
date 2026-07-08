// Editor for an app's custom want agent system prompt (toolschema.App.Thought).
// Unlike tool edits, this saves immediately on submit rather than batching
// into the draft/Save cycle — it's a single field with its own PUT endpoint,
// same pattern as the origin editor in App.tsx.
export function ThoughtEditor({
  value,
  defaultPreview,
  busy,
  dirty,
  onChange,
  onSave,
}: {
  value: string
  defaultPreview: string
  busy: boolean
  dirty: boolean
  onChange: (next: string) => void
  onSave: (e: React.FormEvent) => void
}) {
  return (
    <form className="thought-editor" onSubmit={onSave}>
      <div className="thought-header">
        <span className="micro-label">Agent thought</span>
        <button type="submit" className="primary" disabled={busy || !dirty}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
      <p className="thought-copy">
        Custom system prompt for the LLM that selects this app's tools — tone, domain knowledge,
        or rules specific to this app. Leave empty to use the platform default shown below.
      </p>
      <textarea
        className="thought-textarea"
        rows={12}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={defaultPreview}
      />
      {!value && (
        <div className="thought-default">
          <span className="micro-label">Platform default (currently in effect)</span>
          <p className="thought-default-text">{defaultPreview}</p>
        </div>
      )}
    </form>
  )
}

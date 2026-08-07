import { useEffect } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import Placeholder from '@tiptap/extension-placeholder'
import { applyMarkdownEscapeFix } from './tiptapMarkdownEscapeFix'

applyMarkdownEscapeFix()

// Editor for an app's custom want agent system prompt (toolschema.App.Thought).
// Unlike tool edits, this saves immediately on submit rather than batching
// into the draft/Save cycle — it's a single field with its own PUT endpoint,
// same pattern as the origin editor in App.tsx.
//
// WYSIWYG on top of a plain Markdown string: value/onChange still carry raw
// Markdown text exactly like the <textarea> this replaced (the stored data
// format and what the LLM reads are unchanged — see
// docs/thought-markdown-editor-design.md), but editing happens on the
// rendered view (bold text looks bold as you type) instead of on raw `**`
// syntax. @tiptap/markdown's Editor.getMarkdown()/contentType: 'markdown'
// handle the two-way conversion.
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
  const editor = useEditor({
    extensions: [StarterKit, Markdown, Placeholder.configure({ placeholder: defaultPreview })],
    content: value,
    contentType: 'markdown',
    onUpdate: ({ editor }) => onChange(editor.getMarkdown()),
  })

  // Re-syncs the editor only when `value` changes for a reason other than
  // this editor's own onUpdate above (e.g. switching to a different app in
  // the sidebar swaps in that app's thought). Comparing against the
  // editor's own current markdown avoids resetting content — and the
  // cursor position — on every local keystroke, which a naive
  // `setContent` on every `value` change would do. Trimmed on both sides:
  // App.tsx persists thoughtDraft.trim() on Save, so the round-tripped
  // `value` it later passes back can differ from the editor's own live
  // getMarkdown() by trailing whitespace alone (the markdown serializer can
  // emit a trailing newline) — comparing untrimmed would treat that as an
  // external change and force an unnecessary setContent/cursor reset right
  // after every successful Save.
  useEffect(() => {
    if (!editor) return
    if (editor.getMarkdown().trim() !== value.trim()) {
      editor.commands.setContent(value, { contentType: 'markdown' })
    }
  }, [value, editor])

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
      <EditorContent editor={editor} className="thought-textarea" />
      {!value && (
        <div className="thought-default">
          <span className="micro-label">Platform default (currently in effect)</span>
          <p className="thought-default-text">{defaultPreview}</p>
        </div>
      )}
    </form>
  )
}

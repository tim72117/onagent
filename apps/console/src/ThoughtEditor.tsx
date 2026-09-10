import { useEffect, useRef, useState } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import Placeholder from '@tiptap/extension-placeholder'
import { applyMarkdownEscapeFix } from './tiptapMarkdownEscapeFix'
import { usePopoverPlacement } from './usePopoverPlacement'

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
//
// Deliberately just the editor's content (intro copy + textarea + default
// preview) — no <form>, no title, no Save button. It used to render all of
// those itself, but ThoughtEditSheet.tsx (the mobile full-screen sheet)
// needed its own <form>/SheetHeader wrapping the same editor, and nesting
// one <form> inside another is invalid HTML (the browser silently drops
// the inner tag, leaving submit behavior ambiguous) — hence pulling the
// chrome out to each caller. App.tsx's desktop branch wraps this in its
// own <form onSubmit={onSave}> with a matching header/Save button;
// ThoughtEditSheet.tsx does the same with SheetHeader.
export function ThoughtEditor({
  value,
  defaultPreview,
  onChange,
}: {
  value: string
  defaultPreview: string
  onChange: (next: string) => void
}) {
  // Whether the "what's the platform default" help popover is open — see
  // Playground.tsx's own helpOpen/helpRef for the same pattern (click the ?
  // trigger, dismiss on an outside click or Escape). This used to gate
  // showing defaultPreview on `!value` as well (only visible while the
  // field was still empty), which meant clicking ? after writing any
  // custom text did nothing visible — the popover here always shows
  // defaultPreview regardless of value, since the point is letting a
  // developer compare their own text against the default, not just
  // previewing it before they've written anything.
  const [defaultExpanded, setDefaultExpanded] = useState(false)
  const defaultRef = useRef<HTMLSpanElement>(null)
  const defaultPlacement = usePopoverPlacement(defaultExpanded, defaultRef)

  useEffect(() => {
    if (!defaultExpanded) return
    function onPointerDown(e: PointerEvent) {
      if (defaultRef.current && !defaultRef.current.contains(e.target as Node)) {
        setDefaultExpanded(false)
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setDefaultExpanded(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [defaultExpanded])
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
    // isDestroyed guards a real crash, not a defensive nicety: switching
    // apps updates `value` (via App.tsx's activeSummary-driven
    // setThoughtDraft) around the same time this component can be
    // unmounting/remounting (e.g. the mobile/desktop branch swap, or
    // ThoughtEditSheet closing) — if that `value` change's effect runs
    // after @tiptap/react's own cleanup has already called
    // editor.destroy() on this instance but before React finishes
    // tearing down, `editor` here is still a truthy, non-null reference
    // (destroy() nulls out its internal commandManager, not the object
    // itself), so the `!editor` check above doesn't catch it. Calling
    // .commands.setContent() on a destroyed editor throws (destroyed
    // Editor's commandManager is null), which — uncaught, deep inside a
    // Tiptap-internal call stack — crashes past this component's own
    // error boundary reach and unmounts the whole React tree.
    if (!editor || editor.isDestroyed) return
    if (editor.getMarkdown().trim() !== value.trim()) {
      editor.commands.setContent(value, { contentType: 'markdown' })
    }
  }, [value, editor])

  return (
    <>
      <p className="thought-copy thought-copy-heading">Custom system prompt for the LLM that selects this app's tools</p>
      <p className="thought-copy">Tone, domain knowledge, or rules specific to this app.</p>
      <EditorContent editor={editor} className="thought-textarea" />
      <p className="thought-copy thought-copy-below">
        Leave empty to use the platform default.{' '}
        <span className="thought-default-anchor" ref={defaultRef}>
          <button
            type="button"
            className="thought-default-toggle"
            onClick={() => setDefaultExpanded((v) => !v)}
            aria-expanded={defaultExpanded}
            aria-label={defaultExpanded ? 'Hide platform default text' : 'Show platform default text'}
          >
            ?
          </button>
          {defaultExpanded && (
            <div
              className="thought-default-popover"
              data-vertical={defaultPlacement.vertical}
              data-horizontal={defaultPlacement.horizontal}
              role="tooltip"
            >
              <span className="micro-label">Platform default</span>
              <p className="thought-default-text">{defaultPreview}</p>
            </div>
          )}
        </span>
      </p>
    </>
  )
}

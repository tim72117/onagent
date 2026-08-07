// Tests the actual document-state transformation ThoughtEditor.tsx relies on:
// Editor([StarterKit, Markdown]).getMarkdown() after various kinds of edits.
// The `thought` field is persisted verbatim and fed to the LLM as a raw
// system prompt (backend/internal/inference/agent_roles.go) — any silent
// content mutation here is a real correctness bug, not just a display quirk.
//
// These assert the CORRECT/target state, not the current @tiptap/markdown
// behavior — several of them are expected to FAIL until the escaping bug
// (escapeMarkdownSyntax/encodeHtmlEntities unconditionally mangling untouched
// plain text on every edit, see @tiptap/markdown/dist/index.js:1080-1093) is
// actually fixed. None of the characters exercised below need escaping to
// round-trip safely: `user_id` is intraword (CommonMark/GFM don't treat `_`
// inside a word as emphasis), `[ref]` has no matching `(url)` so it's not a
// link, `a~b` is a single `~` (strikethrough needs `~~`), and `<rules>` isn't
// a schema-recognized tag so it was always kept as literal text either way —
// escaping it into `&lt;rules&gt;` changes the stored string for no
// round-trip-safety reason.
//
// These tests exercise the editor engine directly (not the React component)
// since the question is "what does getMarkdown() return after this edit",
// which is a property of @tiptap/markdown's serializer, not of React state
// management.
import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'

function editorWith(markdown: string): Editor {
  return new Editor({
    extensions: [StarterKit, Markdown],
    content: markdown,
    contentType: 'markdown',
  })
}

describe('ThoughtEditor document state after various edits', () => {
  it('round-trips plain prose with no markdown syntax unchanged', () => {
    const editor = editorWith('You are a helpful assistant for analysis tasks.')
    expect(editor.getMarkdown()).toBe('You are a helpful assistant for analysis tasks.')
    editor.destroy()
  })

  it('underscores in plain prose (e.g. identifiers) survive an unrelated edit unescaped', () => {
    const editor = editorWith('Match on user_id, not order_id.')
    // Simulate the user editing something elsewhere in the document,
    // forcing onUpdate to fire and getMarkdown() to be called on the whole
    // document — the same trigger App.tsx's onChange={setThoughtDraft} sees
    // on every keystroke.
    editor.commands.focus('end')
    editor.commands.insertContent(' ')

    const result = editor.getMarkdown()
    expect(result.trim()).toBe('Match on user_id, not order_id.')
    editor.destroy()
  })

  it('pseudo-XML tags in plain prose survive an unrelated edit as literal text, not HTML-entity-encoded', () => {
    const editor = editorWith('<rules>Always answer in French.</rules>')
    editor.commands.focus('end')
    editor.commands.insertContent(' ')

    const result = editor.getMarkdown()
    expect(result.trim()).toBe('<rules>Always answer in French.</rules>')
    editor.destroy()
  })

  it('markdown-syntax-shaped characters that are not actually ambiguous survive an edit unescaped', () => {
    const editor = editorWith('See [ref] and a~b.')
    editor.commands.focus('end')
    editor.commands.insertContent(' ')
    const result = editor.getMarkdown()
    expect(result.trim()).toBe('See [ref] and a~b.')
    editor.destroy()
  })

  it('repeated open/edit/save cycles never introduce escaping into clean content', () => {
    const once = editorWith('Match on user_id, not order_id.')
    once.commands.focus('end')
    once.commands.insertContent(' ')
    const firstPass = once.getMarkdown().trim()
    once.destroy()

    // Simulate reopening the ThoughtEditor for this app on a later visit.
    const again = editorWith(firstPass)
    again.commands.focus('end')
    again.commands.insertContent(' ')
    const secondPass = again.getMarkdown().trim()
    again.destroy()

    expect(firstPass).toBe('Match on user_id, not order_id.')
    expect(secondPass).toBe('Match on user_id, not order_id.')
  })

  it('typing then reverting a paragraph back to its exact original text leaves the document state unchanged', () => {
    const original = 'Match on user_id, not order_id.'
    const editor = editorWith(original)

    // Insert text, then delete exactly what was inserted -- the resulting
    // ProseMirror document is textually identical to the starting state,
    // not just "close to it." If escaping only fired on genuinely new
    // content this would round-trip cleanly; if it fires on the whole
    // document regardless of what actually changed (the real
    // implementation), the untouched original text still comes back
    // corrupted even though nothing about it is different from before.
    editor.commands.focus('end')
    editor.commands.insertContent(' TEMP')

    editor.commands.deleteRange({
      from: editor.state.doc.content.size - 5,
      to: editor.state.doc.content.size,
    })

    const result = editor.getMarkdown().trim()
    expect(result).toBe(original)
    editor.destroy()
  })

  it('multi-paragraph: a real, permanent edit to ONE paragraph must not corrupt untouched sibling paragraphs', () => {
    const original =
      '# Role\n\nOnly call tools whose name matches app_[0-9]+.\n\nBe concise, use `snake_case`.'
    const editor = editorWith(original)

    // A genuine, lasting edit inside the FIRST paragraph (the heading) --
    // not the paragraph containing the special characters, and never
    // reverted. The middle paragraph (app_[0-9]+.) and last paragraph
    // (`snake_case`) are never touched at all.
    editor.commands.focus('start')
    editor.commands.insertContent('New ')

    const result = editor.getMarkdown().trim()
    expect(result).toContain('# New Role')
    expect(result).toContain('app_[0-9]+')
    expect(result).toContain('`snake_case`')
    editor.destroy()
  })

  it('multi-paragraph: inserting a whole new paragraph then deleting it again leaves the original paragraphs unchanged', () => {
    const original =
      '# Role\n\nOnly call tools whose name matches app_[0-9]+.\n\nBe concise, use `snake_case`.'
    const editor = editorWith(original)

    // Insert an entire new paragraph node right after the heading, then
    // delete that whole paragraph -- a block-level insert+delete, not a
    // character-level edit inside an existing paragraph.
    let afterHeadingPos = -1
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'heading' && afterHeadingPos === -1) {
        afterHeadingPos = pos + node.nodeSize
      }
    })
    expect(afterHeadingPos).toBeGreaterThan(-1)

    editor.commands.insertContentAt(afterHeadingPos, { type: 'paragraph', content: [{ type: 'text', text: 'TEMPORARY PARAGRAPH' }] })
    expect(editor.getMarkdown()).toContain('TEMPORARY PARAGRAPH')

    // Find and delete the paragraph node we just inserted, as a single
    // block-level delete (not a character-range delete).
    let tempFrom = -1
    let tempTo = -1
    editor.state.doc.descendants((node, pos) => {
      if (node.isTextblock && node.textContent === 'TEMPORARY PARAGRAPH') {
        tempFrom = pos
        tempTo = pos + node.nodeSize
      }
    })
    expect(tempFrom).toBeGreaterThan(-1)
    editor.commands.deleteRange({ from: tempFrom, to: tempTo })

    const result = editor.getMarkdown().trim()
    expect(result).not.toContain('TEMPORARY PARAGRAPH')
    expect(result).toBe(original)
    editor.destroy()
  })

  it('WYSIWYG bold command produces real markdown bold syntax', () => {
    const editor = editorWith('')
    editor.commands.insertContent('Plain text then ')
    editor.chain().toggleBold().insertContent('bold via toolbar').toggleBold().run()
    editor.commands.insertContent(' and back to plain.')

    const result = editor.getMarkdown()
    expect(result).toBe('Plain text then **bold via toolbar** and back to plain.')
    editor.destroy()
  })

  it('WYSIWYG heading command produces real markdown heading syntax', () => {
    const editor = editorWith('')
    editor.commands.setNode('heading', { level: 2 })
    editor.commands.insertContent('Role')
    expect(editor.getMarkdown().trim()).toBe('## Role')
    editor.destroy()
  })

  it('multi-paragraph documents: editing one paragraph does not corrupt untouched special characters in other paragraphs', () => {
    const editor = editorWith(
      '# Role\n\nOnly call tools whose name matches app_[0-9]+.\n\nBe concise.'
    )
    // Edit only the last paragraph -- the middle paragraph is never touched.
    editor.commands.focus('end')
    editor.commands.insertContent('!')

    const result = editor.getMarkdown()
    expect(result).toContain('# Role')
    expect(result).toContain('app_[0-9]+')
    editor.destroy()
  })

  it('bullet lists and inline code round-trip correctly when genuinely untouched (no edit made)', () => {
    const source = '- Always call `list_questions` before `select_question`\n- Never fabricate question names'
    const editor = editorWith(source)
    // No edit at all -- initial parse+immediate serialize, closest to the
    // "open the panel, don't touch anything" case.
    expect(editor.getMarkdown()).toBe(source)
    editor.destroy()
  })

  it('empty content produces an empty markdown string (the .thought-default fallback trigger)', () => {
    const editor = editorWith('')
    expect(editor.getMarkdown()).toBe('')
    editor.destroy()
  })

  it('links round-trip when untouched, and link text underscores survive an unrelated edit unescaped', () => {
    const editor = editorWith('See [the_docs](https://example.com) for details.')
    editor.commands.focus('end')
    editor.commands.insertContent(' ')
    const result = editor.getMarkdown()
    expect(result.trim()).toBe('See [the_docs](https://example.com) for details.')
    editor.destroy()
  })
})

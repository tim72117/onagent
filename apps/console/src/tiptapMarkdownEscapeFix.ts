import { MarkdownManager } from '@tiptap/markdown'

// @tiptap/markdown's MarkdownManager.encodeTextForMarkdown (node_modules/
// @tiptap/markdown/dist/index.js:1075-1081) unconditionally runs every
// plain-text node through escapeMarkdownSyntax (backslash-escapes \ ` * _
// [ ] ~) and encodeHtmlEntities (< > & -> entities) on every serialize —
// including text the user never touched. Since ThoughtEditor.tsx persists
// getMarkdown()'s output verbatim as the LLM's raw system prompt
// (backend/internal/inference/agent_roles.go), this silently rewrites
// stored content on every edit: "user_id" becomes "user\_id", "<rules>"
// becomes "&lt;rules&gt;", etc. — confirmed in
// ThoughtEditor.markdown.test.ts.
//
// Neither escapeMarkdownSyntax nor encodeHtmlEntities is exposed through
// MarkdownExtensionOptions (only `marked`/`markedOptions`/`indentation`
// are), so there's no supported way to disable this. MarkdownManager
// itself IS a real exported class (not type-only), so this patches its
// prototype method directly to skip both transforms for plain text —
// bold/heading/list/etc. markdown syntax is unaffected, since that comes
// from each node/mark's own renderer, not from this text-encoding path.
//
// Trade-off accepted: text the user typed containing literal
// markdown-syntax-looking runs (e.g. a bare "**not bold**" meant as
// literal asterisks) will round-trip as real markdown on the next load
// instead of staying literal. This is a narrower risk than the current
// guaranteed corruption of common technical content (identifiers with
// underscores, angle-bracket pseudo-tags) on every edit.
//
// Risk: MarkdownManager.prototype.encodeTextForMarkdown is a private,
// undocumented implementation detail — an @tiptap/markdown upgrade could
// rename/restructure it without this patch failing loudly (it would
// silently stop applying, reverting to the original escaping behavior,
// not throw). Re-verify this patch still targets the right method after
// bumping @tiptap/markdown's version.
let applied = false

export function applyMarkdownEscapeFix(): void {
  if (applied) return
  applied = true
  ;(MarkdownManager.prototype as unknown as { encodeTextForMarkdown: (text: string) => string }).encodeTextForMarkdown = function (
    text: string,
  ): string {
    return text
  }
}

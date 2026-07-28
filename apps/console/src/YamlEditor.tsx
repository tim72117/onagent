// PROTOTYPE — display + edit only, no Save wiring, no parse-back-to-App
// validation yet. Purpose: let the user see and feel the YAML-editing
// experience (syntax highlighting, line numbers) before committing to
// replacing ToolForm/SchemaEditor with it. Lives in its own file (rather
// than inline in App.tsx) specifically so it can be React.lazy()-loaded —
// CodeMirror is a real dependency users who never open this view
// shouldn't have to download.
//
// Binds @codemirror/view's EditorView directly (the ~20-line pattern
// CodeMirror's own "Using with React" docs recommend) rather than pulling
// in @uiw/react-codemirror — that wrapper's only job is this same binding.
// Also skips the `codemirror` meta-package entirely (it depends on
// @codemirror/{autocomplete,commands,lint,search} unconditionally, whether
// or not you use them) in favor of importing only the individual
// @codemirror/* packages this editor actually uses.
import { useEffect, useRef } from 'react'
import { Compartment, EditorState, Prec } from '@codemirror/state'
import { EditorView, lineNumbers, highlightActiveLine } from '@codemirror/view'
import { yaml as yamlLang } from '@codemirror/lang-yaml'
import { HighlightStyle, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { monokai } from '@uiw/codemirror-theme-monokai'
import { githubLight } from '@uiw/codemirror-theme-github'

// Matches this project's own dark-mode detection: style.css switches on
// @media (prefers-color-scheme: dark) alone today (a data-theme attribute
// for a future manual toggle exists in the CSS but nothing sets it yet —
// see docs/console-yaml-editor-2026-07-28.md), so following the same media
// query here keeps the editor's colors in sync with the rest of the UI
// without inventing a second source of truth for "which mode is active."
const darkModeQuery = window.matchMedia('(prefers-color-scheme: dark)')

// monokai/githubLight's own background colors don't match this app's panel
// background (style.css's --bg-raised) — monokai in particular ships
// #272822 (a dark olive-grey) that stands out against this UI's near-black
// panels. Overriding just the background keeps each theme's syntax colors
// (which do look right) while making the editor read as part of the same
// panel rather than a visibly different box. Hand-copied from style.css's
// --bg-raised/--ink values (light bg: #ffffff, dark bg: #1e1a15; light ink:
// #1c1917, dark ink: #efe9e1) — no shared source of truth between the CSS
// custom properties and this TS file, same tradeoff schema.ts already makes
// against backend/internal/toolschema/schema.go.
//
// Wrapped in Prec.high: CodeMirror mounts each extension's EditorView.theme
// StyleModule in *reverse* of the order they're combined in (see
// @codemirror/view's mountStyles — Precedence.Default extensions later in
// the list end up earlier in the actual stylesheet), so simply listing this
// override after monokai/githubLight in the extensions array does NOT make
// it win on equal CSS specificity — both themes' "&" rules have the same
// specificity, and without an explicit precedence bump the theme's own
// background silently kept winning here.
//
// The "&" selector must set BOTH backgroundColor and color: monokai's own
// "&" rule sets both in one declaration block, so once Prec.high makes our
// "&" win, it wins the *whole* rule, not just backgroundColor — omitting
// color here left text falling back to an unstyled default, unreadably dark
// against the new dark background (caught earlier with oneDark, same issue
// applies to any theme sharing this "&" selector shape).
const backgroundOverride = (bg: string, ink: string) =>
  Prec.high(
    EditorView.theme({
      '&': { backgroundColor: bg, color: ink },
      '.cm-gutters': { backgroundColor: bg, borderRight: 'none' },
    }),
  )

// YAML keys highlight as tags.propertyName. Monokai's own color for it is
// #66D9EF (cyan/blue — Monokai's "function" color, reused for property
// names) — genuine Monokai does NOT make keys green by default (that's
// #A6E22E, reserved for tags.className/heading instead). Verified VS Code's
// actual Dark+ theme too (entity.name.tag.yaml scope -> #569cd6, blue) —
// no shade of green is used for YAML keys there either; #98c379 below is
// oneDark's own "sage" green (used before this file switched to Monokai),
// kept per explicit user preference over both Monokai's and VS Code's
// defaults. Only affects dark mode — light mode (githubLight) keeps its
// own key color.
const darkKeyColorOverride = Prec.high(
  syntaxHighlighting(HighlightStyle.define([{ tag: tags.propertyName, color: '#98c379' }])),
)

const themeFor = (isDark: boolean) =>
  isDark
    ? [monokai, backgroundOverride('#1e1a15', '#f8f8f2'), darkKeyColorOverride]
    : [githubLight, backgroundOverride('#ffffff', '#1c1917')]

export function YamlEditor({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  // Holds the theme extension in a swappable slot — reconfiguring this
  // compartment lets the active color theme change without tearing down
  // and rebuilding the whole EditorView (which would lose cursor position,
  // undo history, and scroll offset).
  const themeCompartment = useRef(new Compartment())
  // Mirrors the doc content the view itself last reported via onChange, so
  // the sync effect below can tell "this is the same value we just emitted"
  // apart from "value changed from outside" — without it, every keystroke
  // would round-trip back through a prop update that resets the view's
  // state and the cursor jumps to the end of the document.
  const lastEmitted = useRef(value)

  useEffect(() => {
    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          yamlLang(),
          lineNumbers(),
          highlightActiveLine(),
          syntaxHighlighting(defaultHighlightStyle),
          themeCompartment.current.of(themeFor(darkModeQuery.matches)),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return
            const next = update.state.doc.toString()
            lastEmitted.current = next
            onChange(next)
          }),
        ],
      }),
      parent: hostRef.current!,
    })
    viewRef.current = view

    const onThemeChange = (e: MediaQueryListEvent) => {
      view.dispatch({ effects: themeCompartment.current.reconfigure(themeFor(e.matches)) })
    }
    darkModeQuery.addEventListener('change', onThemeChange)

    return () => {
      darkModeQuery.removeEventListener('change', onThemeChange)
      view.destroy()
    }
    // Deliberately mount-once: this prototype's App.tsx doesn't currently
    // replace `value` out from under the editor after initial mount (no
    // Save round-trip yet). A full implementation switching between
    // multiple tools' YAML would need this effect to re-sync `doc` when
    // `value` changes for a reason other than the view's own edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (!view || value === lastEmitted.current) return
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    })
    lastEmitted.current = value
  }, [value])

  return (
    <div className="yaml-editor">
      <div className="yaml-editor-hint">
        Prototype — editing here doesn't save yet. Compare the feel against the form editor.
      </div>
      <div ref={hostRef} className="yaml-editor-host" />
    </div>
  )
}

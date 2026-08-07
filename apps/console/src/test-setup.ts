// Vitest setupFiles entry (see vite.config.ts's test.setupFiles) — applies
// the same @tiptap/markdown escaping patch ThoughtEditor.tsx applies at
// module load, so tests that construct their own Editor instances (e.g.
// ThoughtEditor.markdown.test.ts, which deliberately tests the engine
// directly rather than importing the React component) exercise the same
// patched behavior the real app runs under, not the unpatched default.
import { applyMarkdownEscapeFix } from './tiptapMarkdownEscapeFix'

applyMarkdownEscapeFix()

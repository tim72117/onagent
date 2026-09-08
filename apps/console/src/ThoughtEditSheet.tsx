import { Suspense, lazy } from 'react'
import { DEFAULT_THOUGHT } from './schema'
import { BottomSheet } from './BottomSheet'
import { SheetHeader } from './SheetHeader'
import styles from './ThoughtEditSheet.module.css'

// Lazy for the same reason App.tsx's desktop ThoughtEditor import and
// MobileWorkspaceCards.tsx's own lazy() call are — Tiptap + its markdown
// extension add ~145kB gzip, not worth paying until this sheet actually
// opens. A third lazy() call for the same module still dedupes to one
// chunk, so this doesn't add to that cost.
const ThoughtEditor = lazy(() => import('./ThoughtEditor').then((m) => ({ default: m.ThoughtEditor })))

function ThoughtEditorFallback() {
  return <div className="thought-textarea" aria-hidden="true" />
}

// Mobile-only, full-screen (see BottomSheet.tsx's fullscreen prop) — the
// Thought editor needs real room to write/preview a multi-paragraph
// system prompt, unlike the partial-height sheets used for a single short
// field (OriginEditSheet.tsx, KeyEditSheet.tsx). Opened by tapping the
// summary card MobileWorkspaceCards.tsx renders in its place — showing
// the full ThoughtEditor inline in the card stack (an earlier version of
// this feature) pushed the Tools card far enough down the page that it
// read as "barely anything is visible here", not just "this card is
// tall". The header and body both live inside one <form> so SheetHeader's
// Save button (type="submit" by default) reuses onSaveThought's existing
// (e: React.FormEvent) => void signature unchanged — the same handler the
// desktop agentSelected branch in App.tsx already uses.
export function ThoughtEditSheet({
  open,
  onClose,
  thoughtDraft,
  thoughtBusy,
  thoughtDirty,
  onThoughtChange,
  onSaveThought,
}: {
  open: boolean
  onClose: () => void
  thoughtDraft: string
  thoughtBusy: boolean
  thoughtDirty: boolean
  onThoughtChange: (value: string) => void
  onSaveThought: (e: React.FormEvent) => void
}) {
  return (
    <BottomSheet open={open} onClose={onClose} fullscreen disableBackdropClose>
      <form className={styles.form} onSubmit={onSaveThought}>
        <div className={styles.header}>
          <SheetHeader
            title="Agent thought"
            onClose={onClose}
            saveLabel={thoughtBusy ? 'Saving…' : 'Save'}
            saveDisabled={thoughtBusy || !thoughtDirty}
          />
        </div>
        <div className={styles.body}>
          <Suspense fallback={<ThoughtEditorFallback />}>
            <ThoughtEditor value={thoughtDraft} defaultPreview={DEFAULT_THOUGHT} onChange={onThoughtChange} />
          </Suspense>
        </div>
      </form>
    </BottomSheet>
  )
}

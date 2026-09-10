import { useState } from 'react'
import type { App as AppSchema, Tool } from './schema'
import { emptyTool } from './schema'
import type { ValidationIssue } from './validate'
import { ThoughtEditSheet } from './ThoughtEditSheet'
import { ToolEditSheet } from './ToolEditSheet'
import { AiToolGeneratorSheet } from './AiToolGeneratorSheet'
import { useSheet } from './useSheet'
import styles from './MobileWorkspaceCards.module.css'

// Mobile's card-stack home view — Agent Thought and Tools rendered as
// stacked cards (see App.tsx's Google-Ads-style reference screenshot),
// replacing the desktop sidebar-driven agentSelected/activeToolIndex
// navigation for narrow viewports. Playground is deliberately NOT one of
// these cards — it stays reachable only via MobileBottomBar.tsx's
// full-screen sheet, per the user's explicit call to keep it independent.
//
// Tapping a tool row opens ToolEditSheet.tsx (a full-screen sheet), not an
// inline accordion (an earlier version expanded ToolForm right in the
// list) — same reasoning as the Thought card: a fully expanded ToolForm
// (name/description/parameters/returns) made the list tall enough that
// scrolling past one open tool to reach the next felt like the page was
// broken rather than just long. openToolIndex is owned entirely here, not
// lifted to App.tsx's activeToolIndex — that state continues to serve only
// the desktop sidebar's tool selection, so resizing between breakpoints
// can't make the two navigation models fight over one value.
//
// No page-level "Unsaved changes"/"Saving…" banner here (an earlier
// version had one at the top of .root) — it ate into the scarce mobile
// viewport with an empty bar most of the time, and the busy/dirty state
// only actually matters to the Tools card (tool edits are the only thing
// that touches draft.tools), so the indicator lives there instead, next to
// its own title, same dirtyDot treatment as the Agent thought card's above.
export function MobileWorkspaceCards({
  draft,
  dirty,
  busy,
  appLevelIssues,
  issuesByTool,
  thoughtDraft,
  thoughtBusy,
  thoughtDirty,
  onThoughtChange,
  onSaveThought,
  onChangeTool,
  onRemoveTool,
  onCreateTool,
  onConfirmDiscard,
  onAddToolWizard,
}: {
  draft: AppSchema
  dirty: boolean
  busy: boolean
  appLevelIssues: ValidationIssue[]
  issuesByTool: Map<number, ValidationIssue[]>
  thoughtDraft: string
  thoughtBusy: boolean
  thoughtDirty: boolean
  onThoughtChange: (value: string) => void
  onSaveThought: (e: React.FormEvent) => void
  // App.tsx's updateAndSaveTool — saves immediately, since ToolEditSheet.tsx
  // only ever calls this once, from its own internal Save button (it holds
  // its own local draft across however many field edits happened inside
  // it), not per keystroke.
  onChangeTool: (index: number, next: Tool) => void
  onRemoveTool: (index: number) => void
  // Appends to draft.tools AND persists immediately (App.tsx's appendTool
  // called with persist:true) — called only once, by the brand-new
  // ToolEditSheet instance below's own Save, not on "+ New tool" itself.
  // Unlike the old onAddTool this replaces (which appended an emptyTool()
  // immediately, before any field was even open), the new tool doesn't
  // exist in draft.tools — and can't dirty this app's save machinery, or
  // show up mid-creation in the Tools list above — until the user actually
  // saves it. By the time this fires the tool is already complete and
  // confirmed (ToolEditSheet's Save is the only place its onChange ever
  // fires), so there's no half-finished state to wait on a separate save
  // step for.
  onCreateTool: (tool: Tool) => void
  onConfirmDiscard: (message: string, onConfirm: () => void) => void
  onAddToolWizard: () => void
}) {
  const [openToolIndex, setOpenToolIndex] = useState<number | null>(null)
  // The tool currently being created via "+ New tool", held here instead
  // of in draft.tools until it's actually saved — see onCreateTool's own
  // comment above for why. null means no creation in progress.
  const [newTool, setNewTool] = useState<Tool | null>(null)
  const thoughtSheet = useSheet()
  const aiGeneratorSheet = useSheet()

  return (
    <div className={styles.root}>
      {appLevelIssues.length > 0 && (
        <ul className="issue-list">
          {appLevelIssues.map((issue, i) => (
            <li key={i}>{issue.message}</li>
          ))}
        </ul>
      )}

      {/* A summary card, not the full ThoughtEditor inline — that earlier
          version made this card tall enough (Tiptap's editor + preview)
          that Tools ended up pushed far enough down the page to look like
          "there's nothing here" rather than "scroll for more". Tapping it
          opens ThoughtEditSheet.tsx, a full-screen sheet with real room
          to write. */}
      <button type="button" className={styles.card} onClick={thoughtSheet.onOpen}>
        <div className={styles.cardHeader}>
          <span className={styles.cardTitle}>Agent thought</span>
          {thoughtDirty && <span className={styles.dirtyDot} title="Unsaved changes" />}
        </div>
        <div className={styles.cardSummary}>
          {thoughtDraft.trim() || 'Using the platform default — tap to customize.'}
        </div>
      </button>

      <ThoughtEditSheet
        open={thoughtSheet.open}
        onClose={thoughtSheet.onClose}
        thoughtDraft={thoughtDraft}
        thoughtBusy={thoughtBusy}
        thoughtDirty={thoughtDirty}
        onThoughtChange={onThoughtChange}
        onSaveThought={onSaveThought}
      />

      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <span className={styles.cardTitle}>Tools</span>
          {(dirty || busy) && (
            <span className={styles.dirtyDot} title={busy ? 'Saving…' : 'Unsaved changes'} />
          )}
        </div>
        {draft.tools.map((tool, i) => {
          const issueCount = issuesByTool.get(i)?.length ?? 0
          return (
            <button
              key={i}
              type="button"
              className={styles.toolRow}
              onClick={() => setOpenToolIndex(i)}
            >
              <span className={styles.toolRowLabel}>
                {tool.name || <em>unnamed_tool</em>}
                {issueCount > 0 && <span className={styles.errorDot} title={`${issueCount} issue(s)`} />}
              </span>
              <svg
                className={styles.chevron}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                width="16"
                height="16"
              >
                <path d="M9 6l6 6-6 6" />
              </svg>
            </button>
          )
        })}
        <div className={styles.addRow}>
          <button
            type="button"
            className="primary"
            onClick={() => setNewTool(emptyTool())}
            data-track="tool_creation_method_selected:blank"
          >
            + New tool
          </button>
          <button
            type="button"
            className="text-btn"
            onClick={onAddToolWizard}
            data-track="tool_creation_method_selected:wizard"
          >
            Build one step by step →
          </button>
          <button type="button" className={`text-btn ${styles.aiGenerateBtn}`} onClick={aiGeneratorSheet.onOpen}>
            <svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15">
              <path d="M12 2.5c.3 3.3 1 5.6 2.1 6.9 1.2 1.4 3.5 2.1 6.9 2.4-3.4.3-5.7 1-6.9 2.4-1.2 1.3-1.8 3.6-2.1 6.9-.3-3.3-1-5.6-2.1-6.9-1.2-1.4-3.5-2.1-6.9-2.4 3.4-.3 5.7-1 6.9-2.4C11 8.1 11.7 5.8 12 2.5z" />
            </svg>
            Generate with AI →
          </button>
        </div>
      </div>

      <ToolEditSheet
        open={openToolIndex !== null}
        onClose={() => setOpenToolIndex(null)}
        tool={openToolIndex !== null ? draft.tools[openToolIndex] : null}
        onChange={(next) => {
          if (openToolIndex !== null) onChangeTool(openToolIndex, next)
        }}
        onRemove={() => {
          if (openToolIndex !== null) onRemoveTool(openToolIndex)
        }}
      />

      {/* A separate instance, not the same one reused with an isNew flag
          flipped on the same tool prop — this one's tool never lives in
          draft.tools until Save, so it needs its own onClose (discard the
          local newTool draft, not touch openToolIndex/draft.tools at all)
          and its own onChange (append via onCreateTool, the one and only
          time this tool ever reaches draft.tools). */}
      <ToolEditSheet
        open={newTool !== null}
        onClose={() => setNewTool(null)}
        tool={newTool}
        onChange={(next) => {
          onCreateTool(next)
          setNewTool(null)
        }}
        isNew
        onConfirmDiscard={onConfirmDiscard}
      />

      <AiToolGeneratorSheet
        open={aiGeneratorSheet.open}
        onClose={aiGeneratorSheet.onClose}
        onGenerated={setNewTool}
      />
    </div>
  )
}

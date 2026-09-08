import { useState } from 'react'
import type { App as AppSchema, Tool } from './schema'
import type { ValidationIssue } from './validate'
import { ThoughtEditSheet } from './ThoughtEditSheet'
import { ToolEditSheet } from './ToolEditSheet'
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
// only actually matters to the Tools card (autosave only ever touches
// draft.tools), so the indicator lives there instead, next to its own
// title, same dirtyDot treatment as the Agent thought card's above.
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
  onAddTool,
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
  onChangeTool: (index: number, next: Tool) => void
  onRemoveTool: (index: number) => void
  onAddTool: () => void
  onAddToolWizard: () => void
}) {
  const [openToolIndex, setOpenToolIndex] = useState<number | null>(null)
  const thoughtSheet = useSheet()

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
          {/* onAddTool (App.tsx's appendTool) synchronously pushes onto
              draft.tools and re-renders this component with the updated
              draft before the next paint — draft.tools.length read here,
              before that call, is exactly the new tool's index, and by
              the time ToolEditSheet reads draft.tools[openToolIndex] on
              its own next render the array already contains it. */}
          <button
            type="button"
            className="primary"
            onClick={() => {
              setOpenToolIndex(draft.tools.length)
              onAddTool()
            }}
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
    </div>
  )
}

import { useState } from 'react'
import { BottomSheet } from './BottomSheet'
import { FeedbackSheet } from './FeedbackSheet'
import styles from './CardMenuSheet.module.css'

// Generic per-card "⋮" action sheet — opened from the rightmost button in a
// mobile workspace card's header (MobileWorkspaceCards.tsx's Agent
// thought/Tools cards). A settings-style list of rows (mirrors
// ToolEditSheet.tsx's own .row list leading into its four field sheets),
// not a button/CTA — this reads as a menu the user picks an item from, not
// a single prominent action. Currently a single row ("Feedback"), but this
// exists as its own component (rather than inlining a single row where the
// "⋮" is tapped) so a future second/third row — rename, remove, etc. — is
// one more row here, not a second sheet to build.
//
// Deliberately does NOT use SheetHeader.tsx (every other sheet in this app
// does) — see .header/.title in CardMenuSheet.module.css for why this one
// has no close (X) button: closing is backdrop-tap only.
//
// appId/cardTitle are threaded through to FeedbackSheet — appId is what
// api.submitFeedback actually needs to know which app the feedback is
// about, cardTitle is purely display context (which card's "⋮" menu this
// was opened from). This sheet itself has no use for either beyond that.
export function CardMenuSheet({
  open,
  onClose,
  appId,
  cardTitle,
}: {
  open: boolean
  onClose: () => void
  appId: string
  cardTitle: string
}) {
  const [feedbackOpen, setFeedbackOpen] = useState(false)

  return (
    <BottomSheet open={open} onClose={onClose}>
      <div className={styles.header}>
        <span className={styles.title}>{cardTitle}</span>
      </div>
      <div className={styles.body}>
        <div className={styles.list}>
          <button type="button" className={styles.row} onClick={() => setFeedbackOpen(true)}>
            <span className={styles.rowIcon}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
                <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
              </svg>
            </span>
            <span className={styles.rowLabel}>Feedback</span>
            <svg className={styles.chevron} viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
              <path d="M9 18l6-6-6-6" />
            </svg>
          </button>
        </div>
      </div>

      {/* Nested INSIDE this BottomSheet's own JSX (not a sibling) so
          BottomSheet.tsx's SheetDepthContext sees it one level deeper and
          gives it a higher z-index — see ToolEditSheet.tsx's identical
          nesting of its own child sheets for the same reason. */}
      <FeedbackSheet
        open={feedbackOpen}
        onClose={() => setFeedbackOpen(false)}
        appId={appId}
        cardTitle={cardTitle}
      />
    </BottomSheet>
  )
}

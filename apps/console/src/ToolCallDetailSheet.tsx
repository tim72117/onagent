import { useEffect, useState } from 'react'
import type { ToolCallEntry } from './Playground'
import { BottomSheet } from './BottomSheet'
import { SheetHeader } from './SheetHeader'
import detailStyles from './ToolCallDetailSheet.module.css'

// One tool_call/tool_query entry from Playground.tsx's toolCalls strip,
// tapped open for the full picture — read-only (no onSave/saveLabel passed
// to SheetHeader, see its own comment on that mode), since this is a record
// of what already happened, not something to edit. Shows exactly what
// ToolCallEntry captured: the args the LLM called with, and whichever of
// result/error the matching tool_result actually carried — the same data
// send() put on the wire, not a re-derived summary, so this is trustworthy
// for debugging a "why did the model see X" question.
//
// Deliberately NOT fullscreen (unlike ToolEditSheet.tsx's field sheets) —
// this is a small, quick-glance read-only record, not a form with fields to
// navigate between, so the default partial-height panel (BottomSheet.tsx's
// own .panel, capped at 85dvh with its own scroll) fits better than
// covering the whole screen for what's usually a few short lines.
export function ToolCallDetailSheet({
  open,
  onClose,
  toolCall,
}: {
  open: boolean
  onClose: () => void
  // Playground.tsx passes selectedToolCall, which goes null the instant
  // open flips to false (it's derived from selectedToolCallId, which
  // onClose clears). This component itself is always mounted (see
  // BottomSheet.tsx's own comment on why — its slide transition depends on
  // it), so if it rendered toolCall's fields directly, the sheet's content
  // would blank out mid-close, part way through the slide-down animation,
  // rather than staying put until the panel is actually offscreen. `shown`
  // instead holds onto the last non-null toolCall, only clearing once
  // `open` goes false AND the transition has had time to finish — so what
  // you see sliding away is always the real content, not a blank panel.
  toolCall: ToolCallEntry | null
}) {
  const [shown, setShown] = useState(toolCall)

  useEffect(() => {
    if (toolCall) setShown(toolCall)
  }, [toolCall])

  if (!shown) return null

  return (
    <BottomSheet open={open} onClose={onClose}>
      <SheetHeader title={shown.toolName} onClose={onClose} />
      <p className={detailStyles.intro}>
        {shown.status === 'pending'
          ? 'Waiting for a result…'
          : shown.status === 'ok'
            ? 'The agent received this result.'
            : 'The agent received this error.'}
      </p>

      <span className="micro-label">Arguments (from the model)</span>
      <pre className={detailStyles.jsonBlock}>{JSON.stringify(shown.args ?? {}, null, 2)}</pre>

      {shown.status === 'ok' && (
        <>
          <span className="micro-label">Result (sent back to the model)</span>
          <pre className={detailStyles.jsonBlock}>{JSON.stringify(shown.result ?? null, null, 2)}</pre>
        </>
      )}

      {shown.status === 'failed' && (
        <>
          <span className="micro-label">Error (sent back to the model)</span>
          <pre className={`${detailStyles.jsonBlock} ${detailStyles.jsonBlockError}`}>{shown.error}</pre>
        </>
      )}
    </BottomSheet>
  )
}

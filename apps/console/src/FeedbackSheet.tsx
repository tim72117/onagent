import { useEffect, useRef, useState } from 'react'
import { BottomSheet } from './BottomSheet'
import { SheetHeader } from './SheetHeader'
import { focusAndReveal } from './focusField'
import { useToast } from './Toast'
import { api, ApiError } from './api'
import styles from './FeedbackSheet.module.css'

// The actual feedback form, opened from CardMenuSheet.tsx's "Feedback"
// button — nested one level deeper (see CardMenuSheet.tsx's own comment on
// why it's declared inside that BottomSheet's JSX).
//
// Submits via api.submitFeedback, which only publishes a backend event
// (see that method's own doc comment) — there is no feedback inbox this
// message is stored for later reading. message is local, ephemeral state
// (not lifted to App.tsx), since nothing outside this sheet needs to read
// or persist it.
export function FeedbackSheet({
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
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const { showToast } = useToast()

  // Same focus-on-open pattern as OriginEditSheet.tsx/
  // MaxPromptLengthEditSheet.tsx — BottomSheet keeps this sheet always
  // mounted (for its close transition), so a plain autoFocus would pop the
  // keyboard the moment CardMenuSheet mounts, not when this sheet actually
  // opens.
  useEffect(() => {
    if (open) focusAndReveal(textareaRef.current)
  }, [open])

  // Clears the draft only once the sheet has actually closed (not on every
  // keystroke) — resetting on close, rather than on open, means a user who
  // taps back into this same sheet mid-close-transition doesn't see their
  // just-typed text vanish out from under them.
  useEffect(() => {
    if (!open) setMessage('')
  }, [open])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = message.trim()
    if (!trimmed || busy) return
    setBusy(true)
    try {
      await api.submitFeedback(appId, trimmed, cardTitle)
      showToast('Thanks for the feedback!', 'info')
      onClose()
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : 'Failed to send feedback.', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <BottomSheet open={open} onClose={onClose} disableBackdropClose>
      <form onSubmit={handleSubmit}>
        <SheetHeader
          title="Feedback"
          onClose={onClose}
          saveLabel={busy ? 'Sending…' : 'Send'}
          saveDisabled={!message.trim() || busy}
        />
        <div className={styles.body}>
          <p className={styles.hint}>What's on your mind about "{cardTitle}"?</p>
          <textarea
            ref={textareaRef}
            className={styles.textarea}
            placeholder="Tell us what's working, what's confusing, or what you'd like to see…"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={6}
          />
        </div>
      </form>
    </BottomSheet>
  )
}

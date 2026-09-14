import { useEffect, useRef, useState } from 'react'
import { BottomSheet } from './BottomSheet'
import { SheetHeader } from './SheetHeader'
import { focusAndReveal } from './focusField'
import { useToast } from './Toast'
import { api } from './api'
import styles from './UseCaseSheet.module.css'

// Part A of the two-part Builder flow (see
// docs/research-feedback-form-2026-09.md), opened from the welcome
// notification: what domain they're in and what they intend to build.
//
// Asked FIRST, before anyone has used the product, because these two answers
// don't depend on having used it — and answering them is what starts the
// Builder claim. Part B (the feedback that actually earns the month) comes
// later, once there is something real to comment on; asking it here would
// only get guesses.
//
// Still skippable: the answers are worth having from everyone, including the
// people who never come back to claim Builder.
//
// Answers are persisted through PUT /console/use-case (see
// backend/internal/usecase), which replaces any previous submission rather
// than appending — someone refining what they said ends up with one current
// answer, not a pile of drafts.

// DOMAINS are the industries we expect, plus two escape hatches that matter
// more than they look. "Still exploring" stops someone with no concrete
// plan from picking an industry at random and polluting the data, and
// "internal tool" is split out because those users want the opposite of a
// public support agent (no public surface, data staying in-house).
const DOMAINS = [
  'E-commerce / retail',
  'Booking services (salon, clinic, gym)',
  'SaaS / developer tools',
  'Education / courses',
  'Finance / insurance',
  'Internal tool (not customer-facing)',
  'Personal project / still exploring',
  'Other',
] as const

type Domain = (typeof DOMAINS)[number]

// Mirror backend/internal/usecase's own caps. Enforced here too so an
// over-long answer is stopped as it is typed rather than rejected after
// submit, which is the only point the server's error could reach the user.
// maxLength counts UTF-16 code units where the server counts runes, so these
// are a shade stricter for astral characters (emoji) — the gap is harmless,
// since it can only refuse slightly early, never let through what the server
// would reject.
const MAX_DOMAIN = 120
const MAX_TEXT = 2000

export function UseCaseSheet({
  open,
  onClose,
  onSubmitted,
}: {
  open: boolean
  onClose: () => void
  // Fires only after api.saveUseCase actually succeeds — distinct from
  // onClose, which also fires on a plain cancel/backdrop-tap with nothing
  // saved. App.tsx uses this (not onClose) to decide whether the
  // notification that opened this sheet should be marked completed: just
  // opening the form isn't completing the suggested step, actually
  // sending it is. Optional since this sheet has no other entry point
  // today that would need to react to a submission.
  onSubmitted?: () => void
}) {
  const [domain, setDomain] = useState<Domain | null>(null)
  const [otherDomain, setOtherDomain] = useState('')
  const [goal, setGoal] = useState('')
  const [today, setToday] = useState('')
  const [saving, setSaving] = useState(false)
  const [domainPickerOpen, setDomainPickerOpen] = useState(false)
  const goalRef = useRef<HTMLTextAreaElement>(null)
  const otherRef = useRef<HTMLInputElement>(null)
  const { showToast } = useToast()

  // Reveal the free-text field once "Other" is chosen. Runs on the domain
  // change rather than inside the picker's click handler because the field
  // only exists after this component re-renders with the new value.
  useEffect(() => {
    if (domain === 'Other') focusAndReveal(otherRef.current)
  }, [domain])

  // Clear only once closed, not on open — the same reasoning as
  // FeedbackSheet.tsx: someone tapping back in mid-close-transition must not
  // watch their own answers disappear.
  useEffect(() => {
    if (!open) {
      setDomain(null)
      setOtherDomain('')
      setGoal('')
      setToday('')
      setSaving(false)
      setDomainPickerOpen(false)
    }
  }, [open])

  // Only the two questions we actually act on are required; A3 is ours to
  // be curious about, not theirs to owe us.
  const domainAnswered = domain !== null && (domain !== 'Other' || otherDomain.trim() !== '')
  const canSubmit = domainAnswered && goal.trim() !== '' && !saving

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setSaving(true)
    try {
      // "Other" is a placeholder for whatever they typed, not an answer in
      // itself — the whole point of offering it is to record their words.
      await api.saveUseCase({
        domain: domain === 'Other' ? otherDomain.trim() : (domain as string),
        goal: goal.trim(),
        handledToday: today.trim(),
      })
      showToast('Thanks — this genuinely shapes what we build next.', 'info')
      onSubmitted?.()
      onClose()
    } catch (err) {
      // Stay open on failure: the sheet clears itself on close, so closing
      // here would discard answers the user cannot get back.
      showToast(err instanceof Error ? err.message : 'Could not save your answers', 'error')
      setSaving(false)
    }
  }

  return (
    // disableBackdropClose because this sheet clears every answer on close
    // (see the reset effect below) — a thumb brushing the backdrop would
    // otherwise destroy typed text with no way to get it back. Same reason
    // every other editable sheet sets it.
    // Escape is handled by every open BottomSheet independently (see
    // BottomSheet.tsx), so with the picker open one press would close both it
    // AND this sheet, wiping the answers. Ignoring the outer close while the
    // picker is up leaves Escape meaning "close the picker", which is what a
    // user pressing it expects.
    <BottomSheet
      open={open}
      onClose={() => {
        if (!domainPickerOpen) onClose()
      }}
      disableBackdropClose
    >
      <form onSubmit={handleSubmit}>
        <SheetHeader
          title="Join Builder"
          onClose={onClose}
          saveLabel={saving ? 'Sending…' : 'Send'}
          saveDisabled={!canSubmit}
        />
        <div className={styles.body}>
          <p className={styles.intro}>
            First, tell us what you're building — about 30 seconds. Once you've
            tested it for real, we'll ask for your feedback and the month is yours.
          </p>

          <div className={styles.field}>
            <span className={styles.label} id="uc-domain-label">
              What's your domain?
            </span>
            {/* A picker row rather than eight inline options: the list is
                long enough that rendering it here pushes the two questions
                below it off a phone screen, leaving the form reading as if
                choosing an industry were all it asked. */}
            <button
              type="button"
              className={styles.picker}
              aria-labelledby="uc-domain-label uc-domain-value"
              aria-haspopup="dialog"
              aria-expanded={domainPickerOpen}
              onClick={() => setDomainPickerOpen(true)}
            >
              <span id="uc-domain-value" className={domain === null ? styles.pickerEmpty : undefined}>
                {domain ?? 'Choose one…'}
              </span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="16" height="16" aria-hidden="true">
                <path d="M9 18l6-6-6-6" />
              </svg>
            </button>
            {domain === 'Other' && (
              <input
                ref={otherRef}
                className={styles.input}
                aria-label="Which domain"
                maxLength={MAX_DOMAIN}
                placeholder="Tell us which…"
                value={otherDomain}
                onChange={(e) => setOtherDomain(e.target.value)}
              />
            )}
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="uc-goal">
              What do you want it to do?
            </label>
            {/* Asking what it DOES, not what problem it solves — the latter
                reliably returns "improve customer service", which is true
                and useless. The placeholder sets the level of detail. */}
            <textarea
              id="uc-goal"
              ref={goalRef}
              className={styles.textarea}
              maxLength={MAX_TEXT}
              placeholder="e.g. let people check availability, book and cancel by just saying so"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              rows={3}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="uc-today">
              How is this handled today? <span className={styles.optional}>Optional</span>
            </label>
            {/* This one tells us what we're competing with. It's optional
                because it benefits us, not them. */}
            <input
              id="uc-today"
              className={styles.input}
              maxLength={MAX_TEXT}
              placeholder="Staff answering manually, another chatbot, nobody yet…"
              value={today}
              onChange={(e) => setToday(e.target.value)}
            />
          </div>
        </div>
      </form>

      {/* Declared inside the parent sheet's JSX so BottomSheet's
          SheetDepthContext gives it a higher z-index than its parent —
          see BottomSheet.tsx's own comment on depth. */}
      <BottomSheet open={domainPickerOpen} onClose={() => setDomainPickerOpen(false)}>
        {/* Plain buttons, not role="radio": a radio group promises arrow-key
            navigation and a single tab stop, and implementing neither while
            claiming the role is worse for a screen reader than not claiming
            it. Choosing here also closes the sheet, which is menu behaviour
            rather than radio behaviour. aria-current marks the active one.
            AppPickerSheet.tsx takes the same plain-list approach. */}
        <div className={styles.pickerList}>
          {DOMAINS.map((d) => (
            <button
              key={d}
              type="button"
              aria-current={domain === d}
              className={`${styles.pickerRow} ${domain === d ? styles.pickerRowOn : ''}`}
              onClick={() => {
                setDomain(d)
                setDomainPickerOpen(false)
              }}
            >
              <span>{d}</span>
              {domain === d && (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16" aria-hidden="true">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
              )}
            </button>
          ))}
        </div>
      </BottomSheet>
    </BottomSheet>
  )
}

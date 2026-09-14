// Integration test covering CardMenuSheet.tsx + its nested FeedbackSheet.tsx
// end to end: open the "⋮" menu, tap "Feedback", the form sheet slides out,
// fill it in, submit, and confirm it calls api.submitFeedback and shows a
// success toast. api.submitFeedback is mocked (see UseCaseSheet.test.tsx
// for the same vi.mock convention) rather than exercised for real — this
// suite is about the sheet's own wiring, not the network layer.
//
// No @testing-library/jest-dom here (not a dependency of this app — see
// SchemaEditor.test.tsx for the same convention) — assertions use plain
// vitest matchers against the query result itself (null vs. an element,
// or a DOM property) rather than toBeInTheDocument()/toBeDisabled().
//
// Explicit cleanup() after each test: BottomSheet.tsx portals directly to
// document.body (not into the test's own render container), so without
// this, a second test's render would find duplicate "Feedback"
// text/buttons left over from the first test's still-mounted portal.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CardMenuSheet } from './CardMenuSheet'
import { ToastProvider } from './Toast'
import { api } from './api'

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api')
  return { ...actual, api: { ...actual.api, submitFeedback: vi.fn() } }
})
const submitFeedback = vi.mocked(api.submitFeedback)

beforeEach(() => {
  submitFeedback.mockReset()
  submitFeedback.mockResolvedValue(undefined)
})

afterEach(cleanup)

function renderMenu() {
  return render(
    <ToastProvider>
      <CardMenuSheet open onClose={() => {}} appId="my-app" cardTitle="Agent thought" />
    </ToastProvider>,
  )
}

describe('CardMenuSheet + FeedbackSheet', () => {
  it('opens the feedback form from the menu, submits it, and shows a success toast', async () => {
    renderMenu()

    // The menu sheet is open and offers the one "Feedback" action.
    const feedbackBtn = screen.getByRole('button', { name: 'Feedback' })
    fireEvent.click(feedbackBtn)

    // The feedback form sheet is now showing its own textarea.
    const textarea = (await screen.findByPlaceholderText(
      "Tell us what's working, what's confusing, or what you'd like to see…",
    )) as HTMLTextAreaElement

    const sendBtn = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement
    expect(sendBtn.disabled).toBe(true)

    fireEvent.change(textarea, { target: { value: 'The thought editor could use a word count.' } })
    expect(sendBtn.disabled).toBe(false)

    fireEvent.click(sendBtn)

    await waitFor(() => {
      expect(screen.queryByText('Thanks for the feedback!')).not.toBeNull()
    })
    expect(submitFeedback).toHaveBeenCalledWith(
      'my-app',
      'The thought editor could use a word count.',
      'Agent thought',
    )
  })

  it('does not allow submitting an empty or whitespace-only message', async () => {
    renderMenu()

    fireEvent.click(screen.getByRole('button', { name: 'Feedback' }))
    const textarea = await screen.findByPlaceholderText(
      "Tell us what's working, what's confusing, or what you'd like to see…",
    )
    const sendBtn = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement

    fireEvent.change(textarea, { target: { value: '   ' } })
    expect(sendBtn.disabled).toBe(true)

    // Submitting the form directly (bypassing the disabled button) must
    // still be a no-op — no API call, no toast.
    fireEvent.submit(textarea.closest('form')!)
    expect(submitFeedback).not.toHaveBeenCalled()
    expect(screen.queryByText('Thanks for the feedback!')).toBeNull()
  })

  it('rendering the menu sheet does not itself open the nested feedback sheet', () => {
    render(
      <ToastProvider>
        <CardMenuSheet open onClose={() => {}} appId="my-app" cardTitle="Tools" />
      </ToastProvider>,
    )

    // BottomSheet.tsx keeps every sheet always mounted (for its close
    // transition), so the feedback form's "Send" button exists in the DOM
    // even while closed — open/closed is tracked via the "_open_" class on
    // its panel, not presence/absence. Only the menu's own panel should
    // carry that class at this point; the nested feedback sheet's panel
    // must not.
    const sendBtn = screen.getByRole('button', { name: 'Send' })
    const feedbackPanel = sendBtn.closest('[role="dialog"]') as HTMLElement
    expect(feedbackPanel.className).not.toMatch(/_open_/)

    const menuPanel = screen
      .getByRole('button', { name: 'Feedback' })
      .closest('[role="dialog"]') as HTMLElement
    expect(menuPanel.className).toMatch(/_open_/)
  })
})

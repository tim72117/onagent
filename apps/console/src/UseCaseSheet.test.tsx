// Covers UseCaseSheet.tsx's submit gating: which answers are required,
// which are not, and the "Other" branch that turns a chosen option into an
// incomplete one until it is named.
//
// Same conventions as CardMenuSheet.test.tsx: no @testing-library/jest-dom
// (not a dependency), so assertions read DOM properties directly; explicit
// cleanup() because BottomSheet portals to document.body and would
// otherwise leak duplicate matches into the next test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { UseCaseSheet } from './UseCaseSheet'
import { ToastProvider } from './Toast'
import { api } from './api'

// Submitting now calls PUT /console/use-case, so the API is stubbed rather
// than left to hit the network from jsdom.
vi.mock('./api', () => ({ api: { saveUseCase: vi.fn() } }))
const saveUseCase = vi.mocked(api.saveUseCase)

beforeEach(() => {
  saveUseCase.mockReset()
  saveUseCase.mockResolvedValue(undefined)
})

afterEach(cleanup)

function renderSheet() {
  return render(
    <ToastProvider>
      <UseCaseSheet open onClose={() => {}} />
    </ToastProvider>,
  )
}

function sendButton() {
  return screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement
}

// The domain question is a picker row that opens a nested sheet, so choosing
// one is two taps rather than a single click on a visible option.
function chooseDomain(name: string) {
  fireEvent.click(screen.getByRole('button', { name: /what's your domain/i }))
  fireEvent.click(screen.getByRole('button', { name }))
}

function goalField() {
  return screen.getByLabelText(/what do you want it to do/i)
}

describe('UseCaseSheet', () => {
  it('cannot be sent empty', () => {
    renderSheet()
    expect(sendButton().disabled).toBe(true)
  })

  it('needs both the domain and the goal, not either alone', () => {
    renderSheet()

    chooseDomain('SaaS / developer tools')
    expect(sendButton().disabled).toBe(true)

    fireEvent.change(goalField(), { target: { value: 'Answer billing questions' } })
    expect(sendButton().disabled).toBe(false)
  })

  it('treats whitespace as no answer', () => {
    renderSheet()
    chooseDomain('Education / courses')
    fireEvent.change(goalField(), { target: { value: '   ' } })
    expect(sendButton().disabled).toBe(true)
  })

  it('leaves the third question optional', async () => {
    renderSheet()
    chooseDomain('E-commerce / retail')
    fireEvent.change(goalField(), { target: { value: 'Help shoppers track orders' } })

    // "How is this handled today?" is deliberately never filled in here.
    expect(sendButton().disabled).toBe(false)
    fireEvent.click(sendButton())
    await waitFor(() => {
      expect(screen.queryByText(/genuinely shapes what we build/i)).not.toBeNull()
    })
  })

  describe('the Other branch', () => {
    it('stays incomplete until the domain is actually named', () => {
      renderSheet()
      fireEvent.change(goalField(), { target: { value: 'Route support tickets' } })

      // Picking "Other" looks like an answer but says nothing on its own.
      chooseDomain('Other')
      expect(sendButton().disabled).toBe(true)

      fireEvent.change(screen.getByLabelText(/which domain/i), {
        target: { value: 'Logistics' },
      })
      expect(sendButton().disabled).toBe(false)
    })

    it('only shows its text field once Other is chosen', () => {
      renderSheet()
      expect(screen.queryByLabelText(/which domain/i)).toBeNull()
      chooseDomain('Other')
      expect(screen.queryByLabelText(/which domain/i)).not.toBeNull()
    })
  })

  it('offers an escape hatch for people with no concrete plan yet', () => {
    // Without this option someone still exploring has to pick an industry at
    // random, which quietly corrupts the one thing this form exists to learn.
    renderSheet()
    fireEvent.click(screen.getByRole('button', { name: /what's your domain/i }))
    expect(screen.queryByRole('button', { name: 'Personal project / still exploring' })).not.toBeNull()
  })
})

describe('submitting', () => {
  it('sends the trimmed answers', async () => {
    renderSheet()
    chooseDomain('Finance / insurance')
    fireEvent.change(goalField(), { target: { value: '  Answer policy questions  ' } })
    fireEvent.change(screen.getByLabelText(/how is this handled today/i), {
      target: { value: ' A call centre ' },
    })
    fireEvent.click(sendButton())

    await waitFor(() => expect(saveUseCase).toHaveBeenCalledTimes(1))
    expect(saveUseCase).toHaveBeenCalledWith({
      domain: 'Finance / insurance',
      goal: 'Answer policy questions',
      handledToday: 'A call centre',
    })
  })

  it('sends what the user typed, not the word "Other"', async () => {
    // The option exists precisely to capture a domain we did not list, so
    // storing the literal "Other" would throw away the only useful part.
    renderSheet()
    chooseDomain('Other')
    fireEvent.change(screen.getByLabelText(/which domain/i), {
      target: { value: 'Logistics' },
    })
    fireEvent.change(goalField(), { target: { value: 'Track shipments' } })
    fireEvent.click(sendButton())

    await waitFor(() => expect(saveUseCase).toHaveBeenCalledTimes(1))
    expect(saveUseCase.mock.calls[0][0].domain).toBe('Logistics')
  })

  it('sends an empty string when the optional question is skipped', async () => {
    renderSheet()
    chooseDomain('SaaS / developer tools')
    fireEvent.change(goalField(), { target: { value: 'Explain the API' } })
    fireEvent.click(sendButton())

    await waitFor(() => expect(saveUseCase).toHaveBeenCalledTimes(1))
    expect(saveUseCase.mock.calls[0][0].handledToday).toBe('')
  })

  it('cannot be submitted twice while the first send is in flight', async () => {
    let release!: () => void
    saveUseCase.mockReturnValue(new Promise<void>((r) => { release = r }))

    renderSheet()
    chooseDomain('Education / courses')
    fireEvent.change(goalField(), { target: { value: 'Answer student questions' } })
    fireEvent.click(sendButton())

    // The label itself changes while in flight, which is the visible half of
    // the guard; the disabled state is the half that actually blocks a
    // second submit.
    const sending = await screen.findByRole('button', { name: 'Sending…' })
    expect((sending as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(sending)
    expect(saveUseCase).toHaveBeenCalledTimes(1)

    release()
  })

  it('stays open and reports the error when saving fails', async () => {
    // The sheet clears itself on close, so closing on failure would destroy
    // answers the user has no way to recover.
    saveUseCase.mockRejectedValue(new Error('Service unavailable'))

    renderSheet()
    chooseDomain('E-commerce / retail')
    fireEvent.change(goalField(), { target: { value: 'Track orders' } })
    fireEvent.click(sendButton())

    await waitFor(() => {
      expect(screen.queryByText('Service unavailable')).not.toBeNull()
    })
    // Still filled in, and submittable again.
    expect((goalField() as HTMLTextAreaElement).value).toBe('Track orders')
    await waitFor(() => expect(sendButton().disabled).toBe(false))
  })
})

describe('protecting typed answers', () => {
  it('does not let a backdrop tap close the sheet', () => {
    // The sheet clears every field on close, so a thumb brushing the backdrop
    // would otherwise destroy typed text with no way to recover it.
    renderSheet()
    fireEvent.change(goalField(), { target: { value: 'Half-written answer' } })

    const backdrop = document.querySelector('[class*="backdrop"]')
    expect(backdrop).not.toBeNull()
    fireEvent.click(backdrop as Element)

    expect((goalField() as HTMLTextAreaElement).value).toBe('Half-written answer')
  })

  it('leaves the form open when Escape closes the domain picker', () => {
    // Every open BottomSheet handles Escape independently, so without a guard
    // one press would close the picker AND the form beneath it, wiping the
    // answers along with it.
    const onClose = vi.fn()
    render(
      <ToastProvider>
        <UseCaseSheet open onClose={onClose} />
      </ToastProvider>,
    )
    fireEvent.change(screen.getByLabelText(/what do you want it to do/i), {
      target: { value: 'Half-written answer' },
    })
    fireEvent.click(screen.getByRole('button', { name: /what's your domain/i }))
    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onClose).not.toHaveBeenCalled()
  })

  it('still closes on Escape when no picker is open', () => {
    const onClose = vi.fn()
    render(
      <ToastProvider>
        <UseCaseSheet open onClose={onClose} />
      </ToastProvider>,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})

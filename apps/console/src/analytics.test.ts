import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installClickTracking } from './analytics'

describe('installClickTracking', () => {
  let gtagCalls: unknown[][]

  beforeEach(() => {
    gtagCalls = []
    // .env.local sets VITE_DISABLE_ANALYTICS=true for local dev (so running
    // the app locally doesn't pollute real GA4 data) — vitest picks that up
    // too, so it has to be overridden here for tests that want to observe
    // a real (fake) gtag call; the "does not fire when ... is true" test
    // below re-stubs it back to 'true' to exercise that path deliberately.
    vi.stubEnv('VITE_DISABLE_ANALYTICS', 'false')
    ;(window as unknown as { gtag: (...args: unknown[]) => void }).gtag = (...args: unknown[]) => {
      gtagCalls.push(args)
    }
    installClickTracking()
  })

  afterEach(() => {
    document.body.innerHTML = ''
    delete (window as unknown as { gtag?: unknown }).gtag
    vi.unstubAllEnvs()
  })

  it('fires a GA4 event with the value from a "name:value" data-track attribute', () => {
    const button = document.createElement('button')
    button.setAttribute('data-track', 'tool_creation_method_selected:wizard')
    document.body.appendChild(button)

    fireEvent.click(button)

    expect(gtagCalls).toEqual([['event', 'tool_creation_method_selected', { value: 'wizard' }]])
  })

  it('fires with no params for a data-track attribute with no ":value" suffix', () => {
    const button = document.createElement('button')
    button.setAttribute('data-track', 'some_event')
    document.body.appendChild(button)

    fireEvent.click(button)

    expect(gtagCalls).toEqual([['event', 'some_event', undefined]])
  })

  it('finds the nearest data-track ancestor when the click lands on a child element', () => {
    const button = document.createElement('button')
    button.setAttribute('data-track', 'tool_creation_method_selected:blank')
    const icon = document.createElement('span')
    button.appendChild(icon)
    document.body.appendChild(button)

    fireEvent.click(icon)

    expect(gtagCalls).toEqual([['event', 'tool_creation_method_selected', { value: 'blank' }]])
  })

  it('does nothing for a click with no data-track ancestor', () => {
    const button = document.createElement('button')
    document.body.appendChild(button)

    fireEvent.click(button)

    expect(gtagCalls).toEqual([])
  })

  it('does not fire when VITE_DISABLE_ANALYTICS is "true"', () => {
    vi.stubEnv('VITE_DISABLE_ANALYTICS', 'true')
    const button = document.createElement('button')
    button.setAttribute('data-track', 'tool_creation_method_selected:wizard')
    document.body.appendChild(button)

    fireEvent.click(button)

    expect(gtagCalls).toEqual([])
  })
})

import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireRegistrationConversion, installClickTracking } from './analytics'

describe('analytics', () => {
  beforeEach(() => {
    // .env.local sets VITE_DISABLE_ANALYTICS=true for local dev (so running
    // the app locally doesn't pollute real GA4/GTM data) — vitest picks
    // that up too, so it has to be overridden here for tests that want to
    // observe a real dataLayer push; the "does not push ... is true" tests
    // below re-stub it back to 'true' to exercise that path deliberately.
    vi.stubEnv('VITE_DISABLE_ANALYTICS', 'false')
    window.dataLayer = []
    installClickTracking()
  })

  afterEach(() => {
    document.body.innerHTML = ''
    delete window.dataLayer
    vi.unstubAllEnvs()
  })

  describe('fireRegistrationConversion', () => {
    it('pushes a sign_up event onto dataLayer', () => {
      fireRegistrationConversion()

      expect(window.dataLayer).toEqual([{ event: 'sign_up' }])
    })

    it('does not push when VITE_DISABLE_ANALYTICS is "true"', () => {
      vi.stubEnv('VITE_DISABLE_ANALYTICS', 'true')

      fireRegistrationConversion()

      expect(window.dataLayer).toEqual([])
    })
  })

  describe('installClickTracking', () => {
    it('pushes a dataLayer event with the value from a "name:value" data-track attribute', () => {
      const button = document.createElement('button')
      button.setAttribute('data-track', 'tool_creation_method_selected:wizard')
      document.body.appendChild(button)

      fireEvent.click(button)

      expect(window.dataLayer).toEqual([{ event: 'tool_creation_method_selected', value: 'wizard' }])
    })

    it('pushes with no value key for a data-track attribute with no ":value" suffix', () => {
      const button = document.createElement('button')
      button.setAttribute('data-track', 'some_event')
      document.body.appendChild(button)

      fireEvent.click(button)

      expect(window.dataLayer).toEqual([{ event: 'some_event' }])
    })

    it('finds the nearest data-track ancestor when the click lands on a child element', () => {
      const button = document.createElement('button')
      button.setAttribute('data-track', 'tool_creation_method_selected:blank')
      const icon = document.createElement('span')
      button.appendChild(icon)
      document.body.appendChild(button)

      fireEvent.click(icon)

      expect(window.dataLayer).toEqual([{ event: 'tool_creation_method_selected', value: 'blank' }])
    })

    it('does nothing for a click with no data-track ancestor', () => {
      const button = document.createElement('button')
      document.body.appendChild(button)

      fireEvent.click(button)

      expect(window.dataLayer).toEqual([])
    })

    it('does not push when VITE_DISABLE_ANALYTICS is "true"', () => {
      vi.stubEnv('VITE_DISABLE_ANALYTICS', 'true')
      const button = document.createElement('button')
      button.setAttribute('data-track', 'tool_creation_method_selected:wizard')
      document.body.appendChild(button)

      fireEvent.click(button)

      expect(window.dataLayer).toEqual([])
    })
  })
})

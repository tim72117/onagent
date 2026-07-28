// Integration test for App.tsx wired to useAppMutations — verifies the hook
// extraction (moving every api.* call and its surrounding busy/error/refresh
// bookkeeping out of App.tsx into useAppMutations) didn't change what the
// user actually sees: mocks only the api module's network boundary, renders
// the real App + real useAppMutations, and drives it through the UI exactly
// like a user (or the Playwright smoke run this mirrors) would.
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import App from './App'
import { ToastProvider } from './Toast'
import type { App as AppSchema } from './schema'
import type { AppSummary, CurrentUser } from './api'

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api')
  return {
    ...actual,
    api: {
      register: vi.fn(),
      login: vi.fn(),
      logout: vi.fn().mockResolvedValue(undefined),
      me: vi.fn(),
      getQuota: vi.fn(),
      listApps: vi.fn(),
      getApp: vi.fn(),
      createApp: vi.fn(),
      saveTools: vi.fn(),
      setOrigin: vi.fn(),
      setThought: vi.fn(),
      deleteApp: vi.fn(),
      issueKey: vi.fn(),
      revokeKey: vi.fn(),
      getCliAuthName: vi.fn(),
      approveCliAuth: vi.fn(),
    },
  }
})

import { api } from './api'

const user: CurrentUser = { email: 'test@example.com' }

const summary: AppSummary = {
  appId: 'demo-app',
  toolCount: 1,
  hasKey: false,
  allowedOrigin: '',
  thought: '',
}

const appDetail: AppSchema = {
  appId: 'demo-app',
  tools: [
    {
      name: 'ping',
      description: 'a test tool',
      parameters: { type: 'object', properties: {} },
    },
  ],
}

function renderApp() {
  return render(
    <ToastProvider>
      <App />
    </ToastProvider>,
  )
}

// Every test starts already "logged in" — App.tsx's mount effect always
// calls api.me() first, and every other test here is really about what
// happens after that resolves, not the login screen itself.
beforeEach(() => {
  vi.mocked(api.me).mockResolvedValue(user)
  vi.mocked(api.getQuota).mockResolvedValue({ enabled: false })
  vi.mocked(api.listApps).mockResolvedValue([summary])
  vi.mocked(api.getApp).mockResolvedValue(appDetail)
})

describe('App', () => {
  it('loads the app list after login and shows the sidebar', async () => {
    renderApp()

    expect(await screen.findByText('demo-app')).toBeInTheDocument()
    expect(api.listApps).toHaveBeenCalledTimes(1)
  })

  it('selecting an app fetches and displays its tools', async () => {
    const u = userEvent.setup()
    renderApp()

    await u.click(await screen.findByText('demo-app'))

    expect(await screen.findByText('ping')).toBeInTheDocument()
    expect(api.getApp).toHaveBeenCalledWith('demo-app')
  })

  it('editing a tool marks the app dirty, and Save shows "Saving…" then clears it', async () => {
    const u = userEvent.setup()
    let resolveSave!: (v: AppSummary) => void
    vi.mocked(api.saveTools).mockImplementation(
      () => new Promise((resolve) => { resolveSave = resolve }),
    )

    renderApp()
    await u.click(await screen.findByText('demo-app'))
    await u.click(await screen.findByText('ping'))

    const description = await screen.findByDisplayValue('a test tool')
    await u.clear(description)
    await u.type(description, 'an edited test tool')

    // Dirty state and an enabled Save button appear only after a real edit —
    // this is what proves updateDraft/setDirty (left in App.tsx, not moved
    // into the hook) still fire correctly.
    expect(await screen.findByText('UNSAVED', { exact: false })).toBeInTheDocument()
    const saveButton = screen.getByRole('button', { name: /^save$/i })
    expect(saveButton).toBeEnabled()

    const listAppsCallsBeforeSave = vi.mocked(api.listApps).mock.calls.length
    await u.click(saveButton)

    // Still pending: useAppMutations.saveDraft's busy state should already
    // be true, driving the button's own label — the exact case the
    // Playwright smoke run caught visually.
    expect(await screen.findByRole('button', { name: /saving/i })).toBeInTheDocument()

    resolveSave({ ...summary, toolCount: 1 })

    await waitFor(() => {
      expect(screen.queryByText('UNSAVED', { exact: false })).not.toBeInTheDocument()
    })
    expect(api.saveTools).toHaveBeenCalledWith(
      'demo-app',
      expect.arrayContaining([expect.objectContaining({ description: 'an edited test tool' })]),
    )
    // saveDraft refreshes the summary list after a successful save — compared
    // against the count just before the click (rather than a hardcoded
    // total) since selecting the app/tool beforehand triggers its own
    // refreshes this assertion isn't about.
    expect(vi.mocked(api.listApps).mock.calls.length).toBeGreaterThan(listAppsCallsBeforeSave)
  })

  it('a failed save surfaces a toast and does not clear the dirty badge', async () => {
    const u = userEvent.setup()
    vi.mocked(api.saveTools).mockRejectedValue(new Error('network exploded'))

    renderApp()
    await u.click(await screen.findByText('demo-app'))
    await u.click(await screen.findByText('ping'))

    const description = await screen.findByDisplayValue('a test tool')
    await u.type(description, ' v2')
    await u.click(screen.getByRole('button', { name: /^save$/i }))

    expect(await screen.findByText('network exploded')).toBeInTheDocument()
    expect(screen.getByText('UNSAVED', { exact: false })).toBeInTheDocument()
  })

  it('issuing a key shows the modal and updates the badge/button to "Rotate key"', async () => {
    const u = userEvent.setup()
    vi.mocked(api.issueKey).mockResolvedValue({ appId: 'demo-app', apiKey: 'plaintext-key-once' })
    vi.mocked(api.listApps).mockResolvedValueOnce([summary]).mockResolvedValue([{ ...summary, hasKey: true }])

    renderApp()
    await u.click(await screen.findByText('demo-app'))
    await u.click(screen.getByRole('button', { name: /issue key/i }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('plaintext-key-once')).toBeInTheDocument()

    await u.click(within(dialog).getByRole('button', { name: /saved it/i }))

    expect(await screen.findByRole('button', { name: /rotate key/i })).toBeInTheDocument()
  })

  it('saving the origin field calls setOrigin with the trimmed value', async () => {
    const u = userEvent.setup()
    vi.mocked(api.setOrigin).mockResolvedValue({ ...summary, allowedOrigin: 'https://example.com' })

    renderApp()
    await u.click(await screen.findByText('demo-app'))

    const originInput = screen.getByPlaceholderText(/your-site\.example\.com/i)
    await u.type(originInput, '  https://example.com  ')
    await u.click(screen.getByRole('button', { name: /save origin/i }))

    await waitFor(() => {
      expect(api.setOrigin).toHaveBeenCalledWith('demo-app', 'https://example.com')
    })
  })

  it('saving the thought field calls setThought with the trimmed value', async () => {
    const u = userEvent.setup()
    vi.mocked(api.setThought).mockResolvedValue({ ...summary, thought: 'Be a helpful test agent.' })

    renderApp()
    await u.click(await screen.findByText('demo-app'))
    await u.click(screen.getByText('Thought'))

    // getByRole('textbox') alone is ambiguous here: the Origin input in the
    // page header (an <input> with no type, so it's also role=textbox)
    // stays mounted while the Thought sub-view is showing — scope to the
    // editor pane's own textarea by its distinguishing class.
    const textarea = await waitFor(() => {
      const el = document.querySelector('textarea.thought-textarea')
      if (!el) throw new Error('thought textarea not found yet')
      return el as HTMLTextAreaElement
    })
    await u.type(textarea, '  Be a helpful test agent.  ')
    // Same ambiguity as the textarea above: the tool draft's own header Save
    // button is also on screen (disabled, since no tool is selected). Scope
    // to the ThoughtEditor's <form> to click its Save specifically.
    const thoughtForm = textarea.closest('form')!
    await u.click(within(thoughtForm).getByRole('button', { name: /^save$/i }))

    await waitFor(() => {
      expect(api.setThought).toHaveBeenCalledWith('demo-app', 'Be a helpful test agent.')
    })
  })
})

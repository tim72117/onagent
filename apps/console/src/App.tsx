import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import type { App as AppSchema, Tool } from './schema'
import { DEFAULT_THOUGHT, emptyTool } from './schema'
import { api, ApiError } from './api'
import type { AppSummary, CurrentUser, IssuedKey, Quota } from './api'
import { Login } from './Login'
import { fireRegistrationConversion } from './analytics'
import { KeyModal } from './KeyModal'
import { AddAppModal } from './AddAppModal'
import { ConfirmModal } from './ConfirmModal'
import { Sidebar } from './Sidebar'
import { ToolForm } from './ToolForm'
import { ToolWizard } from './ToolWizard'
import { Playground } from './Playground'
import { PreviewPanel } from './PreviewPanel'
import { validateApp } from './validate'
import { useToast } from './Toast'

// Lazy: Tiptap + its markdown extension add ~145kB gzip to whatever bundle
// imports them (see docs/thought-markdown-editor-design.md) — not worth
// paying on every console load when most sessions never open the thought
// panel. Split into its own chunk, fetched only the first time it renders.
const ThoughtEditor = lazy(() => import('./ThoughtEditor').then((m) => ({ default: m.ThoughtEditor })))

// Matches ThoughtEditor's own markup shape (.thought-editor/.thought-header/
// .thought-copy/.thought-textarea) so the real component's chunk finishing
// its fetch doesn't cause a layout shift — see PostToolUse review finding on
// the bare <div className="empty-state" /> this replaced.
function ThoughtEditorFallback() {
  return (
    <div className="thought-editor">
      <div className="thought-header">
        <span className="micro-label">Agent thought</span>
        <button type="button" className="primary" disabled>
          Save
        </button>
      </div>
      <p className="thought-copy">
        Custom system prompt for the LLM that selects this app's tools — tone, domain knowledge,
        or rules specific to this app. Leave empty to use the platform default shown below.
      </p>
      <div className="thought-textarea" aria-hidden="true" />
    </div>
  )
}

type AuthState = 'checking' | 'anonymous' | 'authenticated'

export default function App() {
  // The session lives in an httpOnly cookie the backend sets — JS can't
  // read it directly, so on mount we ask the backend who (if anyone) it
  // belongs to instead of trusting any client-side flag.
  const [authState, setAuthState] = useState<AuthState>('checking')
  const [user, setUser] = useState<CurrentUser | null>(null)
  const [loginError, setLoginError] = useState<string | null>(null)
  const [summaries, setSummaries] = useState<AppSummary[] | null>(null)
  // Account-level plan/usage standing, shown in the sidebar. Best-effort:
  // fetched once alongside the app list, but its own failure never blocks
  // the rest of the console (see the catch below) since it's purely
  // informational.
  const [quota, setQuota] = useState<Quota | null>(null)

  // draft is the full definition of the app being edited; edits stay local
  // until Save PUTs them to the backend, so half-finished schema changes
  // never go live on keystroke.
  const [draft, setDraft] = useState<AppSchema | null>(null)
  const [dirty, setDirty] = useState(false)
  const [activeToolIndex, setActiveToolIndex] = useState<number | null>(null)
  const [agentSelected, setAgentSelected] = useState(false)
  const [playgroundSelected, setPlaygroundSelected] = useState(false)
  const [issuedKey, setIssuedKey] = useState<IssuedKey | null>(null)
  const [showAddApp, setShowAddApp] = useState(false)
  const [showToolWizard, setShowToolWizard] = useState(false)
  // Replaces window.confirm — set to show ConfirmModal, cleared (with or
  // without running the action) on either button. A single slot is enough
  // since only one confirmation is ever in flight at a time.
  const [pendingConfirm, setPendingConfirm] = useState<{
    message: string
    confirmLabel?: string
    destructive?: boolean
    onConfirm: () => void
  } | null>(null)
  const [busy, setBusy] = useState(false)
  // Origin edits save immediately on submit (unlike tool edits, which batch
  // into draft/dirty until Save) — it's a single field with its own PUT
  // endpoint, and there's no half-finished intermediate state worth
  // protecting against an accidental navigate-away.
  const [originDraft, setOriginDraft] = useState('')
  const [originBusy, setOriginBusy] = useState(false)
  // Thought edits follow the same immediate-save pattern as origin.
  const [thoughtDraft, setThoughtDraft] = useState('')
  const [thoughtBusy, setThoughtBusy] = useState(false)

  const logout = useCallback((message: string | null) => {
    setUser(null)
    setAuthState('anonymous')
    setSummaries(null)
    setQuota(null)
    setDraft(null)
    setDirty(false)
    setActiveToolIndex(null)
    setAgentSelected(false)
    setPlaygroundSelected(false)
    setLoginError(message)
  }, [])

  const { showToast } = useToast()

  // Any API failure funnels through here: auth problems end the session,
  // everything else surfaces as a dismissible toast rather than a
  // blocking native alert() (which stalls the whole tab and can't be
  // styled or auto-dismissed).
  const reportError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) {
        logout('Your session expired. Sign in again.')
        return
      }
      showToast(err instanceof Error ? err.message : String(err), 'error')
    },
    [logout, showToast],
  )

  const refreshSummaries = useCallback(async () => {
    const list = await api.listApps()
    list.sort((a, b) => a.appId.localeCompare(b.appId))
    setSummaries(list)
  }, [])

  // Check for an existing session once on load.
  useEffect(() => {
    api
      .me()
      .then((u) => {
        setUser(u)
        setAuthState('authenticated')
      })
      .catch(() => setAuthState('anonymous'))
  }, [])

  // Google's success redirect carries ?new=1 only when
  // backend/internal/googleauth's callback just created a brand-new
  // account via LoginOrCreateWithGoogle — the only signal distinguishing a
  // first-time Google signup from a returning user's login. Handled here,
  // not in Login.tsx: that redirect always lands with a session cookie
  // already set, so the api.me() check above resolves straight to
  // 'authenticated' and Login.tsx never renders for this case at all. Same
  // one-shot-then-strip pattern as Login.tsx's own ?error= handling, for
  // the same reason — a page refresh must not re-fire this.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('new') === '1') {
      fireRegistrationConversion()
      params.delete('new')
      const rest = params.toString()
      window.history.replaceState(null, '', window.location.pathname + (rest ? `?${rest}` : ''))
    }
  }, [])

  useEffect(() => {
    if (authState !== 'authenticated') return
    refreshSummaries().catch((err) => {
      if (err instanceof ApiError && err.status === 401) {
        logout('Your session expired. Sign in again.')
      } else {
        reportError(err)
      }
    })
  }, [authState, refreshSummaries, logout, reportError])

  // Quota is informational-only sidebar chrome, not something the rest of
  // the console depends on to function — so unlike refreshSummaries, a
  // failure here (including a 401) is swallowed rather than routed through
  // reportError/logout. A real session expiry still gets caught by the
  // next app-list or save call, which do funnel through logout.
  useEffect(() => {
    if (authState !== 'authenticated') return
    api.getQuota().then(setQuota).catch(() => setQuota(null))
  }, [authState])

  // Unsaved edits only live in this tab; warn before the browser discards them.
  useEffect(() => {
    if (!dirty) return
    const handler = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

  const issues = useMemo(() => (draft ? validateApp(draft) : []), [draft])
  const issuesByTool = useMemo(() => {
    const m = new Map<number, typeof issues>()
    for (const issue of issues) {
      if (issue.toolIndex === null) continue
      if (!m.has(issue.toolIndex)) m.set(issue.toolIndex, [])
      m.get(issue.toolIndex)!.push(issue)
    }
    return m
  }, [issues])

  const activeSummary = summaries?.find((s) => s.appId === draft?.appId) ?? null

  // Keep the origin/thought inputs in sync with the server's value whenever
  // the selected app changes (including right after a save, via
  // refreshSummaries) — but not on every keystroke, since that would fight
  // the user typing.
  useEffect(() => {
    setOriginDraft(activeSummary?.allowedOrigin ?? '')
  }, [activeSummary?.appId, activeSummary?.allowedOrigin])

  useEffect(() => {
    setThoughtDraft(activeSummary?.thought ?? '')
  }, [activeSummary?.appId, activeSummary?.thought])

  // Runs action immediately if there's nothing unsaved to lose; otherwise
  // gates it behind a confirmation. action itself may be async — this
  // helper doesn't need to await it, callers that care already do.
  function withDiscardConfirm(action: () => void) {
    if (!dirty) {
      action()
      return
    }
    setPendingConfirm({
      message: 'Discard unsaved changes to this app?',
      confirmLabel: 'Discard',
      destructive: false,
      onConfirm: action,
    })
  }

  function selectApp(appId: string) {
    withDiscardConfirm(async () => {
      try {
        const app = await api.getApp(appId)
        setDraft({ appId: app.appId, tools: app.tools ?? [] })
        setDirty(false)
        setActiveToolIndex(null)
        setAgentSelected(false)
        setPlaygroundSelected(false)
      } catch (err) {
        reportError(err)
      }
    })
  }

  function addApp() {
    withDiscardConfirm(() => setShowAddApp(true))
  }

  async function createApp(appId: string) {
    try {
      await api.createApp(appId)
      await refreshSummaries()
      const app = await api.getApp(appId)
      setDraft({ appId: app.appId, tools: app.tools ?? [] })
      setDirty(false)
      setActiveToolIndex(null)
      setAgentSelected(false)
      setPlaygroundSelected(false)
      setShowAddApp(false)
    } catch (err) {
      reportError(err)
    }
  }

  function deleteApp() {
    if (!draft) return
    const appId = draft.appId
    setPendingConfirm({
      message: `Delete app "${appId}" and its tools? Its API key is revoked too.`,
      confirmLabel: 'Delete',
      onConfirm: async () => {
        try {
          await api.deleteApp(appId)
          await refreshSummaries()
          setDraft(null)
          setDirty(false)
          setActiveToolIndex(null)
          setAgentSelected(false)
          setPlaygroundSelected(false)
        } catch (err) {
          reportError(err)
        }
      },
    })
  }

  async function saveDraft() {
    if (!draft) return
    setBusy(true)
    try {
      await api.saveTools(draft.appId, draft.tools)
      setDirty(false)
      await refreshSummaries()
    } catch (err) {
      reportError(err)
    } finally {
      setBusy(false)
    }
  }

  function issueKey() {
    if (!draft) return
    const appId = draft.appId
    const proceed = async () => {
      try {
        const issued = await api.issueKey(appId)
        setIssuedKey(issued)
        await refreshSummaries()
      } catch (err) {
        reportError(err)
      }
    }
    if (activeSummary?.hasKey) {
      setPendingConfirm({
        message: 'This app already has a key. Issuing a new one revokes the old key immediately. Continue?',
        confirmLabel: 'Issue new key',
        onConfirm: proceed,
      })
    } else {
      proceed()
    }
  }

  async function saveOrigin(e: React.FormEvent) {
    e.preventDefault()
    if (!draft) return
    setOriginBusy(true)
    try {
      await api.setOrigin(draft.appId, originDraft.trim())
      await refreshSummaries()
    } catch (err) {
      reportError(err)
    } finally {
      setOriginBusy(false)
    }
  }

  async function saveThought(e: React.FormEvent) {
    e.preventDefault()
    if (!draft) return
    setThoughtBusy(true)
    try {
      await api.setThought(draft.appId, thoughtDraft.trim())
      await refreshSummaries()
    } catch (err) {
      reportError(err)
    } finally {
      setThoughtBusy(false)
    }
  }

  function revokeKey() {
    if (!draft) return
    const appId = draft.appId
    setPendingConfirm({
      message: `Revoke the API key for "${appId}"? Connected sites stop working immediately.`,
      confirmLabel: 'Revoke',
      onConfirm: async () => {
        try {
          await api.revokeKey(appId)
          await refreshSummaries()
        } catch (err) {
          reportError(err)
        }
      },
    })
  }

  function updateDraft(next: AppSchema) {
    setDraft(next)
    setDirty(true)
  }

  function appendTool(tool: Tool) {
    if (!draft) return
    updateDraft({ ...draft, tools: [...draft.tools, tool] })
    setActiveToolIndex(draft.tools.length)
    setAgentSelected(false)
    setPlaygroundSelected(false)
  }

  function addTool() {
    appendTool(emptyTool())
  }

  // Unlike appendTool (used by the blank-form "+ New tool" path, which only
  // stages the change in draft/dirty until the user hits Save), a tool
  // built through the guided wizard saves immediately — it went through a
  // multi-step review already, so there's less risk of it being a
  // half-finished edit someone would want to back out of before it's
  // persisted. Computes the new tools list explicitly (not via draft.tools
  // after updateDraft) since setDraft's update wouldn't be visible yet in
  // this same function body.
  async function addToolFromWizard(tool: Tool) {
    setShowToolWizard(false)
    if (!draft) return
    const tools = [...draft.tools, tool]
    updateDraft({ ...draft, tools })
    setActiveToolIndex(tools.length - 1)
    setAgentSelected(false)
    setPlaygroundSelected(false)
    setBusy(true)
    try {
      await api.saveTools(draft.appId, tools)
      setDirty(false)
      await refreshSummaries()
    } catch (err) {
      reportError(err)
    } finally {
      setBusy(false)
    }
  }

  function updateTool(index: number, next: Tool) {
    if (!draft) return
    const tools = draft.tools.slice()
    tools[index] = next
    updateDraft({ ...draft, tools })
  }

  // Saves immediately, unlike updateTool/appendTool (staged in draft/dirty
  // until an explicit Save) — matches addToolFromWizard's reasoning:
  // "Delete tool" is itself a deliberate, named action (behind a
  // confirmation here too, since it's destructive), not an in-progress
  // edit someone might want to back out of before it's persisted.
  function removeTool(index: number) {
    if (!draft) return
    const toolName = draft.tools[index]?.name || 'this tool'
    const appId = draft.appId
    setPendingConfirm({
      message: `Delete "${toolName}"? This can't be undone.`,
      confirmLabel: 'Delete',
      onConfirm: async () => {
        const tools = draft.tools.filter((_, i) => i !== index)
        updateDraft({ ...draft, tools })
        setActiveToolIndex(null)
        setBusy(true)
        try {
          await api.saveTools(appId, tools)
          setDirty(false)
          await refreshSummaries()
        } catch (err) {
          reportError(err)
        } finally {
          setBusy(false)
        }
      },
    })
  }

  // Re-fetches draft (and, via refreshSummaries, the thought/origin/key
  // fields selectApp's fetch doesn't cover) before switching sub-views
  // within the same app — so e.g. a Thought edit saved from another tab
  // shows up here without a full app reselect. Gated by the same
  // withDiscardConfirm() every other draft-replacing action here uses: the
  // switch itself (switchView) only actually runs once confirmed (or
  // immediately if there's nothing unsaved) — the view must not change
  // before the user has answered, or the confirmation reads as showing up
  // after the fact instead of gating it.
  function refreshDraftForSwitch(switchView: () => void) {
    if (!draft) {
      switchView()
      return
    }
    withDiscardConfirm(async () => {
      switchView()
      try {
        const app = await api.getApp(draft.appId)
        setDraft({ appId: app.appId, tools: app.tools ?? [] })
        setDirty(false)
        await refreshSummaries()
      } catch (err) {
        reportError(err)
      }
    })
  }

  function selectTool(index: number) {
    refreshDraftForSwitch(() => {
      setActiveToolIndex(index)
      setAgentSelected(false)
      setPlaygroundSelected(false)
    })
  }

  function selectAgent() {
    refreshDraftForSwitch(() => {
      setActiveToolIndex(null)
      setAgentSelected(true)
      setPlaygroundSelected(false)
    })
  }

  function selectPlayground() {
    refreshDraftForSwitch(() => {
      setActiveToolIndex(null)
      setAgentSelected(false)
      setPlaygroundSelected(true)
    })
  }

  async function doLogout() {
    try {
      await api.logout()
    } catch {
      // Cookie may already be gone server-side; clear local state regardless.
    }
    logout(null)
  }

  if (authState === 'checking') {
    return <div className="connecting">Loading…</div>
  }

  if (authState === 'anonymous' || !user) {
    return (
      <Login
        initialError={loginError}
        onSuccess={(u) => {
          setLoginError(null)
          setUser(u)
          setAuthState('authenticated')
        }}
      />
    )
  }

  if (!summaries) {
    return <div className="connecting">Connecting…</div>
  }

  const selectedTool = draft && activeToolIndex !== null ? draft.tools[activeToolIndex] : null
  const appLevelIssues = issues.filter((i) => i.toolIndex === null)
  const canSave = dirty && issues.length === 0 && !busy

  return (
    <div className="shell">
      <Sidebar
        userEmail={user.email}
        quota={quota}
        summaries={summaries}
        activeAppId={draft?.appId ?? null}
        onSelectApp={selectApp}
        onAddApp={addApp}
        tools={draft?.tools ?? null}
        activeToolIndex={activeToolIndex}
        agentSelected={agentSelected}
        playgroundSelected={playgroundSelected}
        issuesByTool={issuesByTool}
        onSelectTool={selectTool}
        onSelectAgent={selectAgent}
        onSelectPlayground={selectPlayground}
        onAddTool={addTool}
        onAddToolWizard={() => setShowToolWizard(true)}
        onDeleteApp={deleteApp}
        onLogout={doLogout}
      />

      <main className="workspace">
        {draft ? (
          <>
            <header className="workspace-header">
              <div className="workspace-heading">
                <h1 className="appid-heading">{draft.appId}</h1>
                <span className="workspace-sub">
                  {draft.tools.length} {draft.tools.length === 1 ? 'tool' : 'tools'}
                </span>
                {activeSummary?.hasKey && <span className="badge">key issued</span>}
                {dirty && <span className="badge badge-dirty">unsaved</span>}
                <div className="workspace-actions">
                  <button type="button" className="text-btn" onClick={issueKey}>
                    {activeSummary?.hasKey ? 'Rotate key' : 'Issue key'}
                  </button>
                  {activeSummary?.hasKey && (
                    <button type="button" className="text-btn danger" onClick={revokeKey}>
                      Revoke key
                    </button>
                  )}
                  <button type="button" className="primary" onClick={saveDraft} disabled={!canSave}>
                    {busy ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </div>
              <form className="origin-row" onSubmit={saveOrigin}>
                <span className="micro-label origin-label">Allowed origin</span>
                <input
                  className="origin-input"
                  placeholder="https://your-site.example.com"
                  value={originDraft}
                  onChange={(e) => setOriginDraft(e.target.value)}
                />
                <button
                  type="submit"
                  className="text-btn"
                  disabled={originBusy || originDraft.trim() === (activeSummary?.allowedOrigin ?? '')}
                >
                  {originBusy ? 'Saving…' : 'Save origin'}
                </button>
                {!activeSummary?.allowedOrigin && (
                  <span className="origin-warning">
                    No origin set — every connection for this app is blocked until one is saved.
                  </span>
                )}
              </form>

              {appLevelIssues.length > 0 && (
                <ul className="issue-list issue-list-inline">
                  {appLevelIssues.map((issue, i) => (
                    <li key={i}>{issue.message}</li>
                  ))}
                </ul>
              )}
            </header>

            {playgroundSelected ? (
              <div className="workspace-body workspace-body-single">
                <section className="editor-pane editor-pane-wide">
                  <Playground appId={draft.appId} tools={draft.tools} />
                </section>
              </div>
            ) : (
              <div className="workspace-body">
                <section className="editor-pane">
                  {agentSelected ? (
                    <Suspense fallback={<ThoughtEditorFallback />}>
                      <ThoughtEditor
                        value={thoughtDraft}
                        defaultPreview={DEFAULT_THOUGHT}
                        busy={thoughtBusy}
                        dirty={thoughtDraft.trim() !== (activeSummary?.thought ?? '')}
                        onChange={setThoughtDraft}
                        onSave={saveThought}
                      />
                    </Suspense>
                  ) : selectedTool ? (
                    <ToolForm
                      key={activeToolIndex}
                      tool={selectedTool}
                      issues={issuesByTool.get(activeToolIndex!) ?? []}
                      onChange={(next) => updateTool(activeToolIndex!, next)}
                      onRemove={() => removeTool(activeToolIndex!)}
                    />
                  ) : (
                    <div className="empty-state">
                      <p className="empty-state-title">No tool selected</p>
                      <p className="empty-state-body">
                        Choose a tool from the sidebar, or add a new one to define its parameters.
                      </p>
                      <div className="empty-state-actions">
                        <button
                          type="button"
                          className="primary"
                          onClick={addTool}
                          data-track="tool_creation_method_selected:blank"
                        >
                          + New tool
                        </button>
                        <button
                          type="button"
                          className="text-btn"
                          onClick={() => setShowToolWizard(true)}
                          data-track="tool_creation_method_selected:wizard"
                        >
                          Build one step by step →
                        </button>
                      </div>
                    </div>
                  )}
                </section>

                <section className="preview-pane">
                  <PreviewPanel app={draft} />
                </section>
              </div>
            )}
          </>
        ) : (
          <div className="empty-state workspace-empty">
            <p className="empty-state-title">No app selected</p>
            <p className="empty-state-body">
              Pick an app from the sidebar to edit its tools, or create a new one.
            </p>
            <button type="button" className="primary" onClick={addApp}>
              + New app
            </button>
          </div>
        )}
      </main>

      {issuedKey && <KeyModal issued={issuedKey} onClose={() => setIssuedKey(null)} />}
      {showAddApp && <AddAppModal onSubmit={createApp} onClose={() => setShowAddApp(false)} />}
      {showToolWizard && (
        <ToolWizard
          existingNames={draft?.tools.map((t) => t.name) ?? []}
          onCreate={addToolFromWizard}
          onClose={() => setShowToolWizard(false)}
        />
      )}
      {pendingConfirm && (
        <ConfirmModal
          message={pendingConfirm.message}
          confirmLabel={pendingConfirm.confirmLabel}
          destructive={pendingConfirm.destructive}
          onConfirm={() => {
            const action = pendingConfirm.onConfirm
            setPendingConfirm(null)
            action()
          }}
          onCancel={() => setPendingConfirm(null)}
        />
      )}
    </div>
  )
}

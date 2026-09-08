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
import { MobileNav } from './MobileNav'
import { SettingsView } from './SettingsView'
import { AppSettingsView } from './AppSettingsView'
import { AppSettingsList } from './AppSettingsList'
import { AppShell } from './AppShell'
import { ToolForm } from './ToolForm'
import { MobileWorkspaceCards } from './MobileWorkspaceCards'
import { ToolWizard } from './ToolWizard'
import { Playground } from './Playground'
import { PreviewPanel } from './PreviewPanel'
import { validateApp } from './validate'
import { useToast } from './Toast'
import styles from './App.module.css'

// Lazy: Tiptap + its markdown extension add ~145kB gzip to whatever bundle
// imports them (see docs/thought-markdown-editor-design.md) — not worth
// paying on every console load when most sessions never open the thought
// panel. Split into its own chunk, fetched only the first time it renders.
const ThoughtEditor = lazy(() => import('./ThoughtEditor').then((m) => ({ default: m.ThoughtEditor })))

// Matches ThoughtEditor's own markup shape (.thought-copy/.thought-textarea)
// so the real component's chunk finishing its fetch doesn't cause a layout
// shift — see PostToolUse review finding on the bare
// <div className="empty-state" /> this replaced. Just the editor's own
// content, same as ThoughtEditor itself — the <form>/header/Save button
// wrapping it below (in the agentSelected branch) render immediately
// either way, so there's no fallback needed for those.
function ThoughtEditorFallback() {
  return (
    <>
      <p className="thought-copy">
        Custom system prompt for the LLM that selects this app's tools — tone, domain knowledge,
        or rules specific to this app. Leave empty to use the platform default shown below.
      </p>
      <div className="thought-textarea" aria-hidden="true" />
    </>
  )
}

type AuthState = 'checking' | 'anonymous' | 'authenticated'

// A single discriminated union replaces what used to be five independent
// booleans (activeToolIndex/agentSelected/playgroundSelected/
// settingsSelected/appSettingsSelected) — those were mutually exclusive by
// convention only, with every select* function responsible for manually
// clearing the other four. That's pure hand-discipline: miss one line and
// two views can end up true at once, with the render ternaries' ordering
// silently deciding which one wins. null means "no sub-view" (the
// workspace's own empty-state / no-tool-selected fallback).
type View = { kind: 'tool'; index: number } | { kind: 'agent' } | { kind: 'playground' } | { kind: 'settings' } | { kind: 'appSettings' } | null

// Whether each view kind has a mobile entry point of its own — used below
// to clear a view on resize-to-mobile only when it doesn't. This used to
// be a single hardcoded `v.kind === 'settings'` check with a comment
// explaining that 'appSettings' was fine to leave alone only because it
// happens to have a gear icon in MobileTopBar.tsx — true, but nothing
// enforced it: a future view kind added without updating that check would
// silently reproduce the exact "resized to mobile, now stuck with no way
// back" bug this effect exists to prevent, and TypeScript would have no
// way to flag the gap. Record<View['kind'], boolean> makes the compiler
// reject this file the moment a new kind is added to View without an
// entry here.
const VIEW_HAS_MOBILE_ENTRY_POINT: Record<NonNullable<View>['kind'], boolean> = {
  tool: true, // MobileWorkspaceCards.tsx's Tools card
  agent: true, // MobileWorkspaceCards.tsx's Agent thought card
  playground: true, // MobileBottomBar.tsx's Playground button
  settings: false, // no mobile entry point — see the effect below
  appSettings: true, // MobileTopBar.tsx's gear icon
}

// Only place in this file that needs a JS-level mobile/desktop signal
// (everywhere else uses pure CSS media queries, see e.g. AppShell.module.css
// and MobileNav.module.css) — App settings genuinely renders two different
// components below 860px (AppSettingsList.tsx, a native-settings-style list
// + edit sheets) vs above it (AppSettingsView.tsx, a flat form), not the
// same markup restyled, so a CSS-only display:none toggle would mean
// mounting and driving both components' state at once for no reason.
function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 860px)').matches)
  useEffect(() => {
    const mql = window.matchMedia('(max-width: 860px)')
    function onChange(e: MediaQueryListEvent | MediaQueryList) {
      setIsMobile(e.matches)
    }
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])
  return isMobile
}

export default function App() {
  const isMobile = useIsMobile()
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
  const [view, setView] = useState<View>(null)

  // Any view without a mobile entry point of its own (currently just
  // 'settings', reached via the desktop-only SidebarFooter.tsx avatar
  // button) has no CSS-driven way back once the window resizes below the
  // 860px breakpoint — the control that set it is gone, but the view
  // state it set persists, leaving the workspace stuck showing a screen
  // nothing on the mobile UI can navigate away from. Clearing those views
  // here, gated on the same breakpoint the CSS uses (via isMobile, from the
  // one matchMedia subscription in useIsMobile — this used to subscribe a
  // second time on its own, which meant the 860px literal had to be kept in
  // sync by hand in two places in this same file) and driven by the
  // exhaustive VIEW_HAS_MOBILE_ENTRY_POINT table above (not a one-off
  // per-kind check), keeps this state in sync with which UI is visible —
  // and keeps doing so automatically for any view kind added later.
  useEffect(() => {
    if (isMobile) {
      setView((v) => (v && !VIEW_HAS_MOBILE_ENTRY_POINT[v.kind] ? null : v))
    }
  }, [isMobile])

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
    setView(null)
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

  // Collapses the setBusy(true)/try/await/catch/finally setBusy(false)
  // skeleton that saveDraft, addToolFromWizard, removeTool, saveOrigin,
  // saveThought, and issueKey/revokeKey's onConfirm all repeated verbatim
  // — differing only in which busy setter they used and what ran on
  // success. reportError is closed over rather than a parameter since
  // every call site here wants identical error handling; onSuccess is the
  // only per-call variation (e.g. saveDraft's setDirty(false), or
  // addToolFromWizard's view/dirty updates that must happen before the
  // request, not after — those still sit outside runAction, which only
  // wraps the request itself).
  // Returns whether fn succeeded, so callers that need to react to the
  // outcome (e.g. AppSettingsList.tsx only closing OriginEditSheet after a
  // confirmed save, not immediately on click) can await it instead of
  // assuming success the instant the action is fired.
  const runAction = useCallback(
    async (setBusyState: (busy: boolean) => void, fn: () => Promise<void>, onSuccess?: () => void) => {
      setBusyState(true)
      try {
        await fn()
        onSuccess?.()
        return true
      } catch (err) {
        reportError(err)
        return false
      } finally {
        setBusyState(false)
      }
    },
    [reportError],
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

  // afterSelect: runs after the app finishes loading, instead of the usual
  // "leave Settings/App settings, land in the workspace" default —
  // selectAppSettings uses this to pick a default app and land back in
  // App settings, not the workspace (see its own comment).
  function selectApp(appId: string, afterSelect: () => void = () => setView(null)) {
    withDiscardConfirm(async () => {
      try {
        const app = await api.getApp(appId)
        setDraft({ appId: app.appId, tools: app.tools ?? [] })
        setDirty(false)
        afterSelect()
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
      setView(null)
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
          setView(null)
        } catch (err) {
          reportError(err)
        }
      },
    })
  }

  function saveDraft() {
    if (!draft) return
    runAction(
      setBusy,
      async () => {
        await api.saveTools(draft.appId, draft.tools)
        await refreshSummaries()
      },
      () => setDirty(false),
    )
  }

  // Replaces the workspace header's manual Save button — autosaves
  // draft.tools 1.2s after the last edit, same as saveDraft's own guard
  // (canSave, below) required before: dirty, no validation issues, and
  // not already mid-save. Debounced (not saved on every keystroke) so
  // rapid edits (e.g. typing a tool name) don't fire a request per
  // character. saveDraft itself already no-ops if draft becomes null
  // before the timer fires (e.g. the visitor switched apps), so no extra
  // guard is needed here for that race.
  useEffect(() => {
    if (!dirty || issues.length > 0 || busy) return
    const timer = setTimeout(() => {
      saveDraft()
    }, 1200)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- saveDraft closes over draft/dirty itself; re-running this effect on every draft change (not just dirty/issues/busy) would reset the debounce timer on every keystroke instead of only after typing pauses.
  }, [dirty, issues.length, busy])

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

  // Returns whether the save succeeded — AppSettingsList.tsx's mobile sheet
  // awaits this to decide whether it's safe to close (see runAction's own
  // comment on why this can't just assume success).
  function saveOrigin(e: React.FormEvent): Promise<boolean> {
    e.preventDefault()
    if (!draft) return Promise.resolve(false)
    return runAction(setOriginBusy, async () => {
      await api.setOrigin(draft.appId, originDraft.trim())
      await refreshSummaries()
    })
  }

  function saveThought(e: React.FormEvent) {
    e.preventDefault()
    if (!draft) return
    runAction(setThoughtBusy, async () => {
      await api.setThought(draft.appId, thoughtDraft.trim())
      await refreshSummaries()
    })
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
    setView({ kind: 'tool', index: draft.tools.length })
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
  function addToolFromWizard(tool: Tool) {
    setShowToolWizard(false)
    if (!draft) return
    const tools = [...draft.tools, tool]
    updateDraft({ ...draft, tools })
    setView({ kind: 'tool', index: tools.length - 1 })
    runAction(
      setBusy,
      async () => {
        await api.saveTools(draft.appId, tools)
        await refreshSummaries()
      },
      () => setDirty(false),
    )
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
      onConfirm: () => {
        const tools = draft.tools.filter((_, i) => i !== index)
        updateDraft({ ...draft, tools })
        setView(null)
        runAction(
          setBusy,
          async () => {
            await api.saveTools(appId, tools)
            await refreshSummaries()
          },
          () => setDirty(false),
        )
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
    refreshDraftForSwitch(() => setView({ kind: 'tool', index }))
  }

  function selectAgent() {
    refreshDraftForSwitch(() => setView({ kind: 'agent' }))
  }

  function selectPlayground() {
    refreshDraftForSwitch(() => setView({ kind: 'playground' }))
  }

  // Account-level (plan/usage/sign-out) — not an app sub-view.
  // refreshDraftForSwitch already no-ops the discard-confirm/refetch dance
  // when there's no draft (see its own comment), which is exactly the
  // "works with or without an app selected" behavior this needs.
  function selectSettings() {
    refreshDraftForSwitch(() => setView({ kind: 'settings' }))
  }

  // Unlike account Settings, App settings (key/origin) needs SOME app to
  // operate on — if none is selected yet, default to the first one in the
  // list rather than rendering an empty view; a no-op if there are no
  // apps at all (Sidebar.tsx doesn't render this nav item in that case
  // anyway — see its own comment). selectApp already resets view via its
  // default afterSelect (see selectApp's own comment) — that's fine here
  // since this whole function immediately re-sets it to 'appSettings'
  // right after.
  function selectAppSettings() {
    if (!draft) {
      if (!summaries || summaries.length === 0) return
      selectApp(summaries[0].appId, () => setView({ kind: 'appSettings' }))
      return
    }
    refreshDraftForSwitch(() => setView({ kind: 'appSettings' }))
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

  const activeToolIndex = view?.kind === 'tool' ? view.index : null
  const selectedTool = draft && activeToolIndex !== null ? draft.tools[activeToolIndex] : null
  const agentSelected = view?.kind === 'agent'
  const playgroundSelected = view?.kind === 'playground'
  const settingsSelected = view?.kind === 'settings'
  const appSettingsSelected = view?.kind === 'appSettings'
  const appLevelIssues = issues.filter((i) => i.toolIndex === null)

  return (
    <AppShell
      sidebar={
        <>
          <MobileNav
            userEmail={user.email}
            quota={quota}
            summaries={summaries}
            activeAppId={draft?.appId ?? null}
            tools={draft?.tools ?? null}
            onSelectApp={selectApp}
            onAddApp={addApp}
            onLogout={doLogout}
            onSelectAppSettings={selectAppSettings}
          />
          <Sidebar
            userEmail={user.email}
            summaries={summaries}
            activeAppId={draft?.appId ?? null}
            onSelectApp={selectApp}
            onAddApp={addApp}
            tools={draft?.tools ?? null}
            activeToolIndex={activeToolIndex}
            agentSelected={agentSelected}
            playgroundSelected={playgroundSelected}
            settingsSelected={settingsSelected}
            appSettingsSelected={appSettingsSelected}
            issuesByTool={issuesByTool}
            onSelectTool={selectTool}
            onSelectAgent={selectAgent}
            onSelectPlayground={selectPlayground}
            onSelectSettings={selectSettings}
            onSelectAppSettings={selectAppSettings}
            onAddTool={addTool}
            onAddToolWizard={() => setShowToolWizard(true)}
          />
        </>
      }
      main={
        <main className={styles.workspace}>
        {settingsSelected ? (
          <SettingsView quota={quota} onLogout={doLogout} />
        ) : appSettingsSelected && draft ? (
          isMobile ? (
            <AppSettingsList
              appId={draft.appId}
              onBack={() => setView(null)}
              hasKey={activeSummary?.hasKey ?? false}
              onIssueKey={issueKey}
              onRevokeKey={revokeKey}
              allowedOrigin={activeSummary?.allowedOrigin ?? null}
              originDraft={originDraft}
              onOriginDraftChange={setOriginDraft}
              originBusy={originBusy}
              onSaveOrigin={saveOrigin}
              onDeleteApp={deleteApp}
            />
          ) : (
            <AppSettingsView
              appId={draft.appId}
              hasKey={activeSummary?.hasKey ?? false}
              onIssueKey={issueKey}
              onRevokeKey={revokeKey}
              allowedOrigin={activeSummary?.allowedOrigin ?? null}
              originDraft={originDraft}
              onOriginDraftChange={setOriginDraft}
              originBusy={originBusy}
              onSaveOrigin={saveOrigin}
              onDeleteApp={deleteApp}
            />
          )
        ) : draft ? (
          isMobile ? (
            <MobileWorkspaceCards
              draft={draft}
              dirty={dirty}
              busy={busy}
              appLevelIssues={appLevelIssues}
              issuesByTool={issuesByTool}
              thoughtDraft={thoughtDraft}
              thoughtBusy={thoughtBusy}
              thoughtDirty={thoughtDraft.trim() !== (activeSummary?.thought ?? '')}
              onThoughtChange={setThoughtDraft}
              onSaveThought={saveThought}
              onChangeTool={updateTool}
              onRemoveTool={removeTool}
              onAddTool={addTool}
              onAddToolWizard={() => setShowToolWizard(true)}
            />
          ) : (
          <>
            <header className={styles.workspaceHeader}>
              <div className={styles.workspaceHeading}>
                {(dirty || busy) && (
                  <span className={`${styles.badge} ${styles.badgeDirty}`}>
                    {busy ? 'Saving…' : 'Unsaved changes'}
                  </span>
                )}
              </div>

              {appLevelIssues.length > 0 && (
                <ul className="issue-list issue-list-inline">
                  {appLevelIssues.map((issue, i) => (
                    <li key={i}>{issue.message}</li>
                  ))}
                </ul>
              )}
            </header>

            {playgroundSelected ? (
              <div className={`${styles.workspaceBody} ${styles.workspaceBodySingle}`}>
                <section className={`${styles.editorPane} ${styles.editorPaneWide}`}>
                  <Playground appId={draft.appId} tools={draft.tools} />
                </section>
              </div>
            ) : (
              <div className={styles.workspaceBody}>
                <section className={styles.editorPane}>
                  {agentSelected ? (
                    <form className="thought-editor" onSubmit={saveThought}>
                      <div className="thought-header">
                        <span className="micro-label">Agent thought</span>
                        <button
                          type="submit"
                          className="primary"
                          disabled={thoughtBusy || thoughtDraft.trim() === (activeSummary?.thought ?? '')}
                        >
                          {thoughtBusy ? 'Saving…' : 'Save'}
                        </button>
                      </div>
                      <Suspense fallback={<ThoughtEditorFallback />}>
                        <ThoughtEditor value={thoughtDraft} defaultPreview={DEFAULT_THOUGHT} onChange={setThoughtDraft} />
                      </Suspense>
                    </form>
                  ) : selectedTool ? (
                    <ToolForm
                      key={activeToolIndex}
                      tool={selectedTool}
                      issues={issuesByTool.get(activeToolIndex!) ?? []}
                      onChange={(next) => updateTool(activeToolIndex!, next)}
                      onRemove={() => removeTool(activeToolIndex!)}
                    />
                  ) : (
                    <div className={styles.emptyState}>
                      <p className={styles.emptyStateTitle}>No tool selected</p>
                      <p className={styles.emptyStateBody}>
                        Choose a tool from the sidebar, or add a new one to define its parameters.
                      </p>
                      <div className={styles.emptyStateActions}>
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

                <section className={styles.previewPane}>
                  <PreviewPanel app={draft} />
                </section>
              </div>
            )}
          </>
          )
        ) : (
          <div className={`${styles.emptyState} ${styles.workspaceEmpty}`}>
            <p className={styles.emptyStateTitle}>No app selected</p>
            <p className={styles.emptyStateBody}>
              {isMobile
                ? 'Tap the + button to create your first app.'
                : 'Pick an app from the sidebar to edit its tools, or create a new one.'}
            </p>
            {/* Omitted on mobile, not the whole empty state (an earlier
                version hid .workspaceEmpty outright below 860px) — a
                visitor with zero apps at all saw nothing but the FAB
                itself then, with no copy explaining what it does. This
                button would just duplicate MobileNav.tsx's always-visible
                FAB, which is still the sole "new app" entry point there. */}
            {!isMobile && (
              <button type="button" className="primary" onClick={addApp}>
                + New app
              </button>
            )}
          </div>
        )}
        </main>
      }
    >
      {issuedKey && <KeyModal issued={issuedKey} onClose={() => setIssuedKey(null)} />}
      {showAddApp && <AddAppModal onSubmit={createApp} onClose={() => setShowAddApp(false)} />}
      <ToolWizard
        open={showToolWizard}
        existingNames={draft?.tools.map((t) => t.name) ?? []}
        onCreate={addToolFromWizard}
        onClose={() => setShowToolWizard(false)}
      />
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
    </AppShell>
  )
}

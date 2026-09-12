import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { App as AppSchema, Tool } from './schema'
import { DEFAULT_THOUGHT, emptyTool } from './schema'
import { api, ApiError } from './api'
import type { AppSummary, CurrentUser, IssuedKey } from './api'
import { Login } from './Login'
import { fireRegistrationConversion } from './analytics'
import { KeyModal } from './KeyModal'
import { AddAppModal } from './AddAppModal'
import { ConfirmModal } from './ConfirmModal'
import { Sidebar } from './Sidebar'
import { DesktopAppBar } from './DesktopAppBar'
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
import { QuotaProvider } from './QuotaContext'
import { useSheet } from './useSheet'
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
type View =
  | { kind: 'tool'; index: number }
  | { kind: 'agent' }
  | { kind: 'playground' }
  | { kind: 'settings' }
  | { kind: 'appSettings' }
  | { kind: 'preview' }
  | null

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
  preview: false, // desktop-Sidebar-only entry point (YAML button) — no mobile equivalent yet
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

  // draft is the full definition of the app being edited. There is no
  // draft-wide batch "Save" — each tool saves independently via its own
  // explicit Save action (see saveTool/updateAndSaveTool, appendTool,
  // removeTool below) rather than one shared Save committing every tool at
  // once. Unlike before, draft.tools IS an unsaved-changes buffer per tool
  // until that tool's own Save runs — see isToolDirty.
  const [draft, setDraft] = useState<AppSchema | null>(null)
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
  // Lifted up from MobileNav.tsx (which used to own this itself) so
  // MobileWorkspaceCards.tsx's own "Try it in Playground" button can open
  // the exact same sheet MobileBottomBar.tsx's button does, instead of
  // each having its own independent open/close state that could disagree
  // about whether the sheet is showing. MobileNav still renders
  // <PlaygroundSheet> and still owns MobileBottomBar's trigger — this is
  // the one piece of state both call sites now share.
  const mobilePlayground = useSheet()
  // Replaces window.confirm — set to show ConfirmModal, cleared (with or
  // without running the action) on either button. A single slot is enough
  // since only one confirmation is ever in flight at a time.
  const [pendingConfirm, setPendingConfirm] = useState<{
    message: string
    confirmLabel?: string
    destructive?: boolean
    onConfirm: () => void
  } | null>(null)
  // Origin edits save immediately on submit, same as every tool edit now —
  // it's a small list with its own PUT endpoint, and there's no
  // half-finished intermediate state worth protecting against an
  // accidental navigate-away. originDrafts is the
  // list being edited (kept in sync with the server via the effect below);
  // newOriginDraft is the separate "add one more" text field, since the
  // list itself is no longer a single editable string.
  const [originDrafts, setOriginDrafts] = useState<string[]>([])
  const [newOriginDraft, setNewOriginDraft] = useState('')
  const [originBusy, setOriginBusy] = useState(false)
  // Thought edits follow the same immediate-save pattern as origin.
  const [thoughtDraft, setThoughtDraft] = useState('')
  const [thoughtBusy, setThoughtBusy] = useState(false)
  // maxPromptLength edits follow the same immediate-save pattern too.
  // Draft is kept as text (not number) so an empty field can mean "clear
  // the app-specific limit" without fighting a numeric input's own
  // coercion of "" to 0.
  const [maxPromptLengthDraft, setMaxPromptLengthDraft] = useState('')
  const [maxPromptLengthBusy, setMaxPromptLengthBusy] = useState(false)

  const logout = useCallback((message: string | null) => {
    setUser(null)
    setAuthState('anonymous')
    setSummaries(null)
    // Quota clears itself — QuotaProvider resets when authenticated goes
    // false (see QuotaContext.tsx), so there's nothing to null out here.
    setDraft(null)
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

  // Collapses the setBusyState(true)/try/await/catch/finally
  // setBusyState(false) skeleton that saveOrigins and saveThought both
  // repeat verbatim — differing only in which busy setter they used.
  // reportError is closed over rather than a parameter since every call
  // site here wants identical error handling. Tool saves (persistTool,
  // below) don't go through this: they track busy/error per tool index
  // rather than with one shared setter, so they manage that bookkeeping
  // directly instead.
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
    setOriginDrafts(activeSummary?.allowedOrigins ?? [])
    setNewOriginDraft('')
  }, [activeSummary?.appId, activeSummary?.allowedOrigins])

  useEffect(() => {
    setThoughtDraft(activeSummary?.thought ?? '')
  }, [activeSummary?.appId, activeSummary?.thought])

  useEffect(() => {
    setMaxPromptLengthDraft(activeSummary?.maxPromptLength != null ? String(activeSummary.maxPromptLength) : '')
  }, [activeSummary?.appId, activeSummary?.maxPromptLength])

  // Same reasoning as selectAppSettings's own fallback below: rendering the
  // "No app selected" empty state when the user actually already has one or
  // more apps is worse than just picking the first one — most noticeable on
  // mobile, where MobileWorkspaceCards (not a Sidebar list) is the landing
  // screen, so arriving there is otherwise a dead end until the user
  // remembers to open the app picker themselves. Guarded on view?.kind
  // !== 'settings' since that's account-level (SettingsView), not
  // app-scoped, and genuinely has nothing to do with which app is selected.
  useEffect(() => {
    if (draft || !summaries || summaries.length === 0) return
    if (view?.kind === 'settings') return
    selectApp(summaries[0].appId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, summaries, view?.kind])

  // Same shared ConfirmModal MobileWorkspaceCards.tsx's in-progress "new
  // tool" draft uses to ask before discarding local, component-owned state
  // that isn't in draft.tools (and so was never persisted) — message/action
  // supplied by the caller, which decides whether its own local state is
  // dirty enough to ask at all; this just renders the dialog.
  function confirmDiscard(message: string, onConfirm: () => void) {
    setPendingConfirm({ message, confirmLabel: 'Discard', destructive: false, onConfirm })
  }

  // afterSelect: runs after the app finishes loading, instead of the usual
  // "leave Settings/App settings, land in the workspace" default —
  // selectAppSettings uses this to pick a default app and land back in
  // App settings, not the workspace (see its own comment).
  // useCallback so DesktopAppBar.tsx (wrapped in React.memo) doesn't
  // re-render every time App does, just because onSelectApp's identity
  // would otherwise be a fresh closure on every render. No discard
  // confirmation gate anymore — every tool edit saves immediately (see
  // updateTool/removeTool below), so there's never unsaved app state to
  // lose by switching apps.
  const selectApp = useCallback(
    (appId: string, afterSelect: () => void = () => setView(null)) => {
      ;(async () => {
        try {
          const app = await api.getApp(appId)
          setDraft({ appId: app.appId, tools: app.tools ?? [] })
          afterSelect()
        } catch (err) {
          reportError(err)
        }
      })()
    },
    [reportError],
  )

  const addApp = useCallback(() => {
    setShowAddApp(true)
  }, [])

  async function createApp(appId: string) {
    try {
      await api.createApp(appId)
      await refreshSummaries()
      const app = await api.getApp(appId)
      setDraft({ appId: app.appId, tools: app.tools ?? [] })
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
          setView(null)
        } catch (err) {
          reportError(err)
        }
      },
    })
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

  // Returns whether the save succeeded — AppSettingsList.tsx's mobile sheet
  // awaits this to decide whether it's safe to close (see runAction's own
  // comment on why this can't just assume success).
  function saveOrigins(e: React.FormEvent): Promise<boolean> {
    e.preventDefault()
    if (!draft) return Promise.resolve(false)
    return runAction(setOriginBusy, async () => {
      await api.setOrigins(draft.appId, originDrafts)
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

  // An empty field clears the app-specific limit (falls back to the
  // system-wide default); a non-empty field must parse as a positive
  // integer — the backend rejects zero/negative anyway, so this catches
  // the common typo case with an immediate, in-place error rather than a
  // round trip.
  //
  // Returns whether the save succeeded (same reasoning as saveOrigins'
  // Promise<boolean> above) — MaxPromptLengthEditSheet.tsx's mobile sheet
  // awaits this before closing, so a validation failure or a rejected API
  // call doesn't get masked by the sheet sliding away as if it had saved.
  function saveMaxPromptLength(e: React.FormEvent): Promise<boolean> {
    e.preventDefault()
    if (!draft) return Promise.resolve(false)
    const trimmed = maxPromptLengthDraft.trim()
    let value: number | null = null
    if (trimmed !== '') {
      const n = Number(trimmed)
      if (!Number.isInteger(n) || n <= 0) {
        showToast('Max prompt length must be a positive whole number.', 'error')
        return Promise.resolve(false)
      }
      value = n
    }
    return runAction(setMaxPromptLengthBusy, async () => {
      await api.setMaxPromptLength(draft.appId, value)
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
  }

  // Tracks, per tool array index, the last version of that tool actually
  // persisted to the backend (undefined = never saved, e.g. a brand-new
  // blank tool that still fails validation). Positions are stable across
  // edits within a session — add/remove/wizard-create all go through
  // setDraft synchronously, so an index here always lines up with the same
  // slot in draft.tools — which is what lets isToolDirty/saveTool below
  // tell "this tool changed since it was last saved" apart from "this tool
  // was just re-rendered". Keyed on appId so switching apps doesn't confuse
  // one app's saved snapshot for another's.
  const savedToolsRef = useRef<{ appId: string | null; tools: (Tool | undefined)[] }>({
    appId: null,
    tools: [],
  })
  if (draft && savedToolsRef.current.appId !== draft.appId) {
    savedToolsRef.current = { appId: draft.appId, tools: draft.tools.map((t) => t) }
  }
  // Per-tool save/error state, index-keyed — mirrors busy/reportError's
  // shape but scoped to one tool at a time instead of the whole app, since
  // every tool now saves independently rather than through one shared
  // draft-wide save.
  const [toolBusy, setToolBusy] = useState<Set<number>>(new Set())
  const [toolErrors, setToolErrors] = useState<Map<number, string>>(new Map())

  function markToolBusy(index: number, busyState: boolean) {
    setToolBusy((s) => {
      const next = new Set(s)
      if (busyState) next.add(index)
      else next.delete(index)
      return next
    })
  }

  function setToolError(index: number, message: string | null) {
    setToolErrors((m) => {
      const next = new Map(m)
      if (message) next.set(index, message)
      else next.delete(index)
      return next
    })
  }

  // After a tool at removedIndex is spliced out of draft.tools, every
  // index above it shifts down by one — without this, a stale busy/error
  // entry keyed by the old index would silently point at whatever tool
  // slides into that slot next.
  function shiftToolIndicesAfterRemoval(removedIndex: number) {
    setToolBusy((s) => {
      const next = new Set<number>()
      for (const i of s) {
        if (i === removedIndex) continue
        next.add(i > removedIndex ? i - 1 : i)
      }
      return next
    })
    setToolErrors((m) => {
      const next = new Map<number, string>()
      for (const [i, msg] of m) {
        if (i === removedIndex) continue
        next.set(i > removedIndex ? i - 1 : i, msg)
      }
      return next
    })
  }

  // Persists tools[index] — via api.saveToolByID (a single atomic update,
  // rename included) once this tool has an id from a previous save, or
  // api.saveTool (upsert by name) for a brand-new tool that doesn't yet.
  // This replaced an older two-step rename (delete the old name, then
  // saveTool under the new one) that had a real failure window: if the
  // second call failed after the first succeeded, the tool vanished
  // entirely, under neither name. saveToolByID's single request has no such
  // window — see backend/internal/toolschema's saveTool doc comment for the
  // same story on the server side.
  //
  // Either way, the response's toolId is written into both draft.tools
  // (so a subsequent edit of the same tool already carries its id) and
  // savedToolsRef (so isToolDirty sees this tool as clean). Also refreshes
  // the summaries list (tool count etc.) the same way every other mutation
  // here does.
  async function persistTool(appId: string, index: number, tool: Tool) {
    markToolBusy(index, true)
    try {
      const result = tool.id
        ? await api.saveToolByID(appId, tool.id, tool)
        : await api.saveTool(appId, tool)
      const saved = { ...tool, id: result.toolId }
      savedToolsRef.current.tools[index] = saved
      setDraft((d) => {
        if (!d || d.appId !== appId) return d
        const tools = d.tools.slice()
        if (tools[index]?.name === tool.name) tools[index] = saved
        return { ...d, tools }
      })
      setToolError(index, null)
      await refreshSummaries()
    } catch (err) {
      reportError(err)
      setToolError(index, err instanceof Error ? err.message : String(err))
    } finally {
      markToolBusy(index, false)
    }
  }

  // persist:false is for addTool's blank-tool case below — the user still
  // has to fill in name/description before anything is valid to save, so
  // only local state updates and the user's own explicit Save (see saveTool)
  // does the real persisting.
  //
  // persist:true is for two callers that both already have a complete,
  // confirmed tool by the time this runs, so there's no half-finished state
  // to wait out: MobileWorkspaceCards.tsx's isNew ToolEditSheet instance
  // (its own Save button is the one and only place its onChange ever fires)
  // and addToolFromWizard below (the guided wizard is itself a multi-step
  // review). Fixes a real bug in the mobile case: onCreateTool used to be
  // wired straight to a persist:false append, so every mobile-created tool
  // (blank, wizard-built, or AI-generated) looked saved in the UI (it's in
  // draft.tools, the workspace switches to it) but silently never reached
  // the backend — reloading the page, or switching apps and back, made it
  // vanish with no error anywhere.
  function appendTool(tool: Tool, persist: boolean) {
    if (!draft) return
    const tools = [...draft.tools, tool]
    const index = tools.length - 1
    updateDraft({ ...draft, tools })
    setView({ kind: 'tool', index })
    if (persist) persistTool(draft.appId, index, tool)
  }

  function addTool() {
    appendTool(emptyTool(), false)
  }

  function addToolFromWizard(tool: Tool) {
    setShowToolWizard(false)
    appendTool(tool, true)
  }

  // Updates local display state only; persisting happens only when the
  // user explicitly saves (see saveTool below) — this used to feed a
  // 1.2s-after-last-keystroke autosave, which silently dropped edits made
  // just before switching views if the timer hadn't fired yet.
  function updateTool(index: number, next: Tool) {
    if (!draft) return
    const tools = draft.tools.slice()
    tools[index] = next
    updateDraft({ ...draft, tools })
  }

  // Whether tools[index] has local edits not yet persisted — the only
  // signal ToolForm/ToolEditSheet need to enable their own Save button, now
  // that saving is a deliberate action instead of a 1.2s-after-last-
  // keystroke autosave (see saveTool below). undefined in savedToolsRef
  // means "never saved" (e.g. a brand-new tool), which is also dirty.
  function isToolDirty(index: number): boolean {
    if (!draft) return false
    const tool = draft.tools[index]
    const prev = savedToolsRef.current.tools[index]
    if (!tool) return false
    return !prev || JSON.stringify(prev) !== JSON.stringify(tool)
  }

  // Explicit, user-triggered save for tools[index] — replaces the former
  // 1.2s-after-last-keystroke autosave. That debounce silently lost edits
  // whenever a switch to another view (refreshDraftForSwitch) landed inside
  // its window: the switch's own getApp() refetch overwrote draft with the
  // server's still-stale copy before the pending timer ever fired, with no
  // indication anything was lost. A save the user explicitly asks for has
  // no such race — it either finishes (or visibly fails) before the user
  // moves on.
  function saveTool(index: number) {
    if (!draft) return
    const tool = draft.tools[index]
    if (!tool) return
    const toolIssues = issuesByTool.get(index)
    if (toolIssues && toolIssues.length > 0) return
    persistTool(draft.appId, index, tool)
  }

  // Combines updateTool + saveTool for callers whose own UI already gates
  // the commit point (mobile's ToolEditSheet.tsx holds its own local draft
  // across possibly several field edits and only ever calls onChange once,
  // from ITS OWN Save button) — saveTool alone would read draft.tools[index]
  // before the setDraft from updateTool has applied, so this saves `next`
  // directly instead of relying on that state update having landed yet.
  function updateAndSaveTool(index: number, next: Tool) {
    if (!draft) return
    updateTool(index, next)
    persistTool(draft.appId, index, next)
  }

  // Deletes immediately (behind a confirmation, since it's destructive) —
  // "Delete tool" is itself a deliberate, named action, not an in-progress
  // edit someone might want to back out of before it's persisted.
  function removeTool(index: number) {
    if (!draft) return
    const tool = draft.tools[index]
    const toolName = tool?.name || 'this tool'
    const appId = draft.appId
    setPendingConfirm({
      message: `Delete "${toolName}"? This can't be undone.`,
      confirmLabel: 'Delete',
      onConfirm: async () => {
        const tools = draft.tools.filter((_, i) => i !== index)
        updateDraft({ ...draft, tools })
        setView(null)
        markToolBusy(index, true)
        try {
          // Only the backend actually has this tool if it was ever
          // persisted (savedToolsRef) — a brand-new tool deleted before its
          // first save has nothing to delete server-side. Prefer the id
          // once known (matches saveToolByID's addressing) — falls back to
          // name only for a tool saved before this app ever assigned ids.
          const saved = savedToolsRef.current.tools[index]
          if (saved?.id) {
            await api.deleteToolByID(appId, saved.id)
          } else if (saved) {
            await api.deleteTool(appId, saved.name)
          }
          savedToolsRef.current.tools.splice(index, 1)
          shiftToolIndicesAfterRemoval(index)
          await refreshSummaries()
        } catch (err) {
          reportError(err)
          markToolBusy(index, false)
        }
      },
    })
  }

  // Re-fetches draft (and, via refreshSummaries, the thought/origin/key
  // fields selectApp's fetch doesn't cover) before switching sub-views
  // within the same app — so e.g. a Thought edit saved from another tab
  // shows up here without a full app reselect.
  //
  // Guards on unsaved tool edits first: now that tool saves are a
  // deliberate user action (see saveTool) rather than a debounced
  // autosave, there IS real local state a switch could discard —
  // confirmDiscard gives the user a chance to back out instead of silently
  // overwriting draft.tools with refetched server data the moment
  // switchView() below runs.
  function refreshDraftForSwitch(switchView: () => void) {
    if (!draft) {
      switchView()
      return
    }
    const anyDirty = draft.tools.some((_, i) => isToolDirty(i))
    if (anyDirty) {
      confirmDiscard('Discard unsaved tool changes?', () => refreshDraftForSwitch(switchView))
      return
    }
    switchView()
    ;(async () => {
      try {
        // Independent endpoints (app.appId's own tools/fields vs. the
        // summaries list) — no data dependency between them, so run them
        // concurrently instead of paying their latency twice in sequence.
        const [app] = await Promise.all([api.getApp(draft.appId), refreshSummaries()])
        setDraft({ appId: app.appId, tools: app.tools ?? [] })
      } catch (err) {
        reportError(err)
      }
    })()
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

  // Same "needs some app, default to the first one if none selected yet"
  // shape as selectAppSettings above — PreviewPanel.tsx has nothing
  // meaningful to render without a draft to serialize to YAML.
  function selectPreview() {
    if (!draft) {
      if (!summaries || summaries.length === 0) return
      selectApp(summaries[0].appId, () => setView({ kind: 'preview' }))
      return
    }
    refreshDraftForSwitch(() => setView({ kind: 'preview' }))
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
  const previewSelected = view?.kind === 'preview'
  const appLevelIssues = issues.filter((i) => i.toolIndex === null)
  // Whether any tool has a save in flight or a failed save — drives the
  // workspace header's "Saving…" badge below, replacing the old
  // draft-wide dirty/busy pair now that saves happen per tool.
  const anyToolBusy = toolBusy.size > 0
  const anyToolError = toolErrors.size > 0
  // Whether any tool has local edits not yet saved — now a real,
  // meaningful state (saves are a deliberate action, not an autosave), so
  // MobileWorkspaceCards' Tools card dot needs to reflect it, not just
  // busy/error.
  const anyToolDirty = draft ? draft.tools.some((_, i) => isToolDirty(i)) : false

  return (
    <QuotaProvider authenticated={authState === 'authenticated'}>
    <AppShell
      sidebar={
        <>
          <MobileNav
            userEmail={user.email}
            summaries={summaries}
            activeAppId={draft?.appId ?? null}
            tools={draft?.tools ?? null}
            onSelectApp={selectApp}
            onAddApp={addApp}
            onLogout={doLogout}
            onSelectAppSettings={selectAppSettings}
            playground={mobilePlayground}
          />
          <Sidebar
            userEmail={user.email}
            summaries={summaries}
            activeAppId={draft?.appId ?? null}
            tools={draft?.tools ?? null}
            activeToolIndex={activeToolIndex}
            agentSelected={agentSelected}
            playgroundSelected={playgroundSelected}
            settingsSelected={settingsSelected}
            appSettingsSelected={appSettingsSelected}
            previewSelected={previewSelected}
            issuesByTool={issuesByTool}
            onSelectTool={selectTool}
            onSelectAgent={selectAgent}
            onSelectPlayground={selectPlayground}
            onSelectSettings={selectSettings}
            onSelectAppSettings={selectAppSettings}
            onSelectPreview={selectPreview}
            onAddTool={addTool}
            onAddToolWizard={() => setShowToolWizard(true)}
          />
        </>
      }
      main={
        <main className={styles.workspace}>
        {!isMobile && (
          <DesktopAppBar
            summaries={summaries}
            activeAppId={draft?.appId ?? null}
            onSelectApp={selectApp}
            onAddApp={addApp}
          />
        )}
        {settingsSelected ? (
          <SettingsView onLogout={doLogout} />
        ) : appSettingsSelected && draft ? (
          isMobile ? (
            <AppSettingsList
              appId={draft.appId}
              onBack={() => setView(null)}
              hasKey={activeSummary?.hasKey ?? false}
              onIssueKey={issueKey}
              onRevokeKey={revokeKey}
              allowedOrigins={activeSummary?.allowedOrigins ?? []}
              originDrafts={originDrafts}
              onOriginDraftsChange={setOriginDrafts}
              newOriginDraft={newOriginDraft}
              onNewOriginDraftChange={setNewOriginDraft}
              originBusy={originBusy}
              onSaveOrigins={saveOrigins}
              maxPromptLengthDraft={maxPromptLengthDraft}
              onMaxPromptLengthDraftChange={setMaxPromptLengthDraft}
              maxPromptLengthBusy={maxPromptLengthBusy}
              onSaveMaxPromptLength={saveMaxPromptLength}
              systemMaxPromptLength={activeSummary?.systemMaxPromptLength ?? null}
              onDeleteApp={deleteApp}
            />
          ) : (
            <AppSettingsView
              appId={draft.appId}
              hasKey={activeSummary?.hasKey ?? false}
              onIssueKey={issueKey}
              onRevokeKey={revokeKey}
              allowedOrigins={activeSummary?.allowedOrigins ?? []}
              originDrafts={originDrafts}
              onOriginDraftsChange={setOriginDrafts}
              newOriginDraft={newOriginDraft}
              onNewOriginDraftChange={setNewOriginDraft}
              originBusy={originBusy}
              onSaveOrigins={saveOrigins}
              maxPromptLengthDraft={maxPromptLengthDraft}
              onMaxPromptLengthDraftChange={setMaxPromptLengthDraft}
              maxPromptLengthBusy={maxPromptLengthBusy}
              onSaveMaxPromptLength={saveMaxPromptLength}
              systemMaxPromptLength={activeSummary?.systemMaxPromptLength ?? null}
              onDeleteApp={deleteApp}
            />
          )
        ) : previewSelected && draft ? (
          <div className={styles.workspaceBody}>
            <section className={styles.editorPane}>
              <PreviewPanel app={draft} />
            </section>
          </div>
        ) : draft ? (
          isMobile ? (
            <MobileWorkspaceCards
              draft={draft}
              dirty={anyToolDirty || anyToolError}
              busy={anyToolBusy}
              appLevelIssues={appLevelIssues}
              issuesByTool={issuesByTool}
              thoughtDraft={thoughtDraft}
              thoughtBusy={thoughtBusy}
              thoughtDirty={thoughtDraft.trim() !== (activeSummary?.thought ?? '')}
              onThoughtChange={setThoughtDraft}
              onSaveThought={saveThought}
              onChangeTool={updateAndSaveTool}
              onRemoveTool={removeTool}
              onCreateTool={(tool) => appendTool(tool, true)}
              onConfirmDiscard={confirmDiscard}
              onAddToolWizard={() => setShowToolWizard(true)}
              onOpenPlayground={mobilePlayground.onOpen}
            />
          ) : (
          <>
            {/* Only rendered when it actually has something to show — an
                empty header still reserved its full padding/border-bottom
                height, which read as a stray blank band once DesktopAppBar
                was added above it (this header used to be the workspace's
                only top row; now it's a second one stacked under that).
                dirty/busy used to be one draft-wide pair backing a manual
                Save button; now every tool saves on its own, so this shows
                "Saving…" while any tool has a save in flight and surfaces a
                save failure the same way appLevelIssues already does. */}
            {(anyToolBusy || anyToolError || appLevelIssues.length > 0) && (
              <header className={styles.workspaceHeader}>
                <div className={styles.workspaceHeading}>
                  {anyToolBusy && (
                    <span className={`${styles.badge} ${styles.badgeDirty}`}>Saving…</span>
                  )}
                </div>

                {(appLevelIssues.length > 0 || anyToolError) && (
                  <ul className="issue-list issue-list-inline">
                    {appLevelIssues.map((issue, i) => (
                      <li key={i}>{issue.message}</li>
                    ))}
                    {[...toolErrors.entries()].map(([index, message]) => (
                      <li key={`tool-error-${index}`}>
                        {draft?.tools[index]?.name || `tool[${index}]`}: {message}
                      </li>
                    ))}
                  </ul>
                )}
              </header>
            )}

            {playgroundSelected ? (
              <div className={styles.workspaceBody}>
                <section className={styles.editorPane}>
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
                      busy={toolBusy.has(activeToolIndex!)}
                      dirty={isToolDirty(activeToolIndex!)}
                      saveError={toolErrors.get(activeToolIndex!) ?? null}
                      onChange={(next) => updateTool(activeToolIndex!, next)}
                      onSave={() => saveTool(activeToolIndex!)}
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
    </QuotaProvider>
  )
}

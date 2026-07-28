// Orchestrates every app-scoped API call App.tsx makes (create/select/save/
// delete an app, issue/revoke its key, save its origin/thought) plus the
// bookkeeping every one of them shares: routing failures through
// reportError, and refreshing the sidebar's app-summary list after any call
// that changes what it should show. api.ts itself stays a thin,
// logic-free fetch wrapper — this is the "what happens around each call"
// layer, kept out of the component so App.tsx's JSX isn't interleaved with
// it.
import { useCallback, useState } from 'react'
import type { App as AppSchema } from './schema'
import { api } from './api'
import type { IssuedKey } from './api'

export interface UseAppMutationsOptions {
  draft: AppSchema | null
  setDraft: (next: AppSchema | null) => void
  setDirty: (next: boolean) => void
  setActiveToolIndex: (next: number | null) => void
  setAgentSelected: (next: boolean) => void
  setPlaygroundSelected: (next: boolean) => void
  refreshSummaries: () => Promise<void>
  reportError: (err: unknown) => void
  /** Only saveDraft's failure path needs this — unlike origin/thought edits,
   * an unsaved tool draft represents in-progress work worth warning about
   * before it's silently overwritten by a stale confirm() elsewhere. */
  confirmDiscard: () => boolean
}

export interface UseAppMutationsResult {
  busy: boolean
  originBusy: boolean
  thoughtBusy: boolean
  issuedKey: IssuedKey | null
  setIssuedKey: (next: IssuedKey | null) => void
  selectApp: (appId: string) => Promise<void>
  createApp: (appId: string) => Promise<void>
  deleteApp: () => Promise<void>
  saveDraft: () => Promise<void>
  issueKey: (hasKey: boolean) => Promise<void>
  revokeKey: () => Promise<void>
  saveOrigin: (origin: string) => Promise<void>
  saveThought: (thought: string) => Promise<void>
  refreshDraftForSwitch: () => Promise<void>
}

// Resets everything a draft-replacing action (select/create/delete/refresh)
// needs to clear so a stale tool/agent/playground selection from the
// previous app never lingers into the newly loaded one.
function resetSelection(
  opts: Pick<UseAppMutationsOptions, 'setDirty' | 'setActiveToolIndex' | 'setAgentSelected' | 'setPlaygroundSelected'>,
) {
  opts.setDirty(false)
  opts.setActiveToolIndex(null)
  opts.setAgentSelected(false)
  opts.setPlaygroundSelected(false)
}

export function useAppMutations(opts: UseAppMutationsOptions): UseAppMutationsResult {
  const { draft, setDraft, refreshSummaries, reportError, confirmDiscard } = opts

  const [busy, setBusy] = useState(false)
  const [originBusy, setOriginBusy] = useState(false)
  const [thoughtBusy, setThoughtBusy] = useState(false)
  const [issuedKey, setIssuedKey] = useState<IssuedKey | null>(null)

  const selectApp = useCallback(
    async (appId: string) => {
      if (!confirmDiscard()) return
      try {
        const app = await api.getApp(appId)
        setDraft({ appId: app.appId, tools: app.tools ?? [] })
        resetSelection(opts)
      } catch (err) {
        reportError(err)
      }
    },
    [confirmDiscard, setDraft, reportError, opts],
  )

  const createApp = useCallback(
    async (appId: string) => {
      try {
        await api.createApp(appId)
        await refreshSummaries()
        const app = await api.getApp(appId)
        setDraft({ appId: app.appId, tools: app.tools ?? [] })
        resetSelection(opts)
      } catch (err) {
        reportError(err)
      }
    },
    [refreshSummaries, setDraft, reportError, opts],
  )

  const deleteApp = useCallback(async () => {
    if (!draft) return
    if (!confirm(`Delete app "${draft.appId}" and its tools? Its API key is revoked too.`)) return
    try {
      await api.deleteApp(draft.appId)
      await refreshSummaries()
      setDraft(null)
      resetSelection(opts)
    } catch (err) {
      reportError(err)
    }
  }, [draft, refreshSummaries, setDraft, reportError, opts])

  const saveDraft = useCallback(async () => {
    if (!draft) return
    setBusy(true)
    try {
      await api.saveTools(draft.appId, draft.tools)
      opts.setDirty(false)
      await refreshSummaries()
    } catch (err) {
      reportError(err)
    } finally {
      setBusy(false)
    }
  }, [draft, refreshSummaries, reportError, opts])

  const issueKey = useCallback(
    async (hasKey: boolean) => {
      if (!draft) return
      if (hasKey && !confirm('This app already has a key. Issuing a new one revokes the old key immediately. Continue?')) {
        return
      }
      try {
        const issued = await api.issueKey(draft.appId)
        setIssuedKey(issued)
        await refreshSummaries()
      } catch (err) {
        reportError(err)
      }
    },
    [draft, refreshSummaries, reportError],
  )

  const revokeKey = useCallback(async () => {
    if (!draft) return
    if (!confirm(`Revoke the API key for "${draft.appId}"? Connected sites stop working immediately.`)) return
    try {
      await api.revokeKey(draft.appId)
      await refreshSummaries()
    } catch (err) {
      reportError(err)
    }
  }, [draft, refreshSummaries, reportError])

  const saveOrigin = useCallback(
    async (origin: string) => {
      if (!draft) return
      setOriginBusy(true)
      try {
        await api.setOrigin(draft.appId, origin.trim())
        await refreshSummaries()
      } catch (err) {
        reportError(err)
      } finally {
        setOriginBusy(false)
      }
    },
    [draft, refreshSummaries, reportError],
  )

  const saveThought = useCallback(
    async (thought: string) => {
      if (!draft) return
      setThoughtBusy(true)
      try {
        await api.setThought(draft.appId, thought.trim())
        await refreshSummaries()
      } catch (err) {
        reportError(err)
      } finally {
        setThoughtBusy(false)
      }
    },
    [draft, refreshSummaries, reportError],
  )

  // Re-fetches draft (and, via refreshSummaries, the thought/origin/key
  // fields selectApp's fetch doesn't cover) before switching sub-views
  // within the same app — so e.g. a Thought edit saved from another tab
  // shows up here without a full app reselect. Gated by the same
  // confirmDiscard() every other draft-replacing action here uses: if
  // there are unsaved local edits, ask before overwriting them with the
  // server's copy, rather than either silently discarding or silently
  // skipping the refresh.
  const refreshDraftForSwitch = useCallback(async () => {
    if (!draft || !confirmDiscard()) return
    try {
      const app = await api.getApp(draft.appId)
      setDraft({ appId: app.appId, tools: app.tools ?? [] })
      opts.setDirty(false)
      await refreshSummaries()
    } catch (err) {
      reportError(err)
    }
  }, [draft, confirmDiscard, setDraft, refreshSummaries, reportError, opts])

  return {
    busy,
    originBusy,
    thoughtBusy,
    issuedKey,
    setIssuedKey,
    selectApp,
    createApp,
    deleteApp,
    saveDraft,
    issueKey,
    revokeKey,
    saveOrigin,
    saveThought,
    refreshDraftForSwitch,
  }
}

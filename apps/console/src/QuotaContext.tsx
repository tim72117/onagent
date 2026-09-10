import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { api } from './api'
import type { Quota } from './api'

// Single source of truth for the signed-in user's quota standing, shared by
// everything that displays it (SettingsView, AccountSheet) and everything
// that needs to act on it (Playground, which refuses to open a connection
// the backend would just reject with a 429 — see playground.go's ResolveApp
// handshake gate).
//
// This used to be a lone useState in App.tsx, fetched once when authState
// became 'authenticated' and never again, then passed down as a prop. Two
// problems that fixed: the displayed numbers went stale the moment the user
// actually spent any tokens (every prompt in Playground moves them), and
// Playground — which lives at the end of two separate render paths
// (App.tsx's desktop workspace and MobileNav.tsx's PlaygroundSheet) — would
// have needed the prop threaded through both to see them at all.
interface QuotaContextValue {
  quota: Quota | null
  // Re-fetches and returns the fresh value, so a caller that must decide
  // something *now* (Playground gating a connection) can await it rather
  // than reading `quota` and racing its own setState. Failures resolve to
  // null rather than throwing: quota is informational chrome for most
  // callers, and a transient fetch failure must not break them (the backend
  // enforces the real limit regardless — see quota.Check's fail-open
  // handling for the mirror image of this decision).
  refresh: () => Promise<Quota | null>
}

const QuotaContext = createContext<QuotaContextValue>({
  quota: null,
  refresh: async () => null,
})

export function useQuota(): QuotaContextValue {
  return useContext(QuotaContext)
}

// Derives "is this account out of tokens" from a Quota, matching
// quota.Check's own `used < limit` test (quota.go) exactly, so the frontend
// never disagrees with the backend about who is over. A disabled quota
// service (QUOTA_ENABLED=false) reports enabled:false with no limit/used at
// all, which is not "over quota" — it's "no quota to be over".
export function isOverQuota(quota: Quota | null): boolean {
  if (!quota?.enabled) return false
  if (typeof quota.limit !== 'number' || typeof quota.used !== 'number') return false
  return quota.used >= quota.limit
}

export function QuotaProvider({
  // Gates the initial fetch the same way App.tsx's own effect did — there
  // is no quota to read before the user is signed in, and asking anyway
  // just produces a 401 to swallow.
  authenticated,
  children,
}: {
  authenticated: boolean
  children: React.ReactNode
}) {
  const [quota, setQuota] = useState<Quota | null>(null)

  const refresh = useCallback(async (): Promise<Quota | null> => {
    try {
      const next = await api.getQuota()
      setQuota(next)
      return next
    } catch {
      // Swallowed, including a 401: quota is informational-only for most
      // consumers, and a real session expiry is still caught by the next
      // app-list or save call, which do funnel through logout.
      setQuota(null)
      return null
    }
  }, [])

  useEffect(() => {
    if (!authenticated) {
      setQuota(null)
      return
    }
    void refresh()
  }, [authenticated, refresh])

  return <QuotaContext.Provider value={{ quota, refresh }}>{children}</QuotaContext.Provider>
}

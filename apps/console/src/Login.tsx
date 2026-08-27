import { useEffect, useState } from 'react'
import { api, ApiError, BASE } from './api'
import type { CurrentUser } from './api'
import { offerToSavePassword } from './credentials'
import styles from './Login.module.css'

type Mode = 'login' | 'register'

// Maps backend/internal/googleauth's callback failure reasons (its
// fail() helper's "reason" strings) to copy a user can act on. Falls back
// to a generic message for any reason not listed here, so a new failure
// mode added on the backend never renders as a blank/undefined string.
function googleErrorMessage(reason: string): string {
  switch (reason) {
    case 'google_access_denied':
      return 'Google sign-in was cancelled.'
    case 'email_not_verified':
      return "Your Google account's email isn't verified. Verify it with Google, then try again."
    case 'state_mismatch':
    case 'missing_state':
      return 'Google sign-in session expired. Please try again.'
    default:
      return 'Google sign-in failed. Please try again.'
  }
}

// Login gates the editor behind a real account (backend/internal/session):
// email + password, either signing in to an existing one or registering a
// new one. Success sets a session cookie the browser attaches automatically
// on subsequent requests — there's no token for this component to hand
// back, just the confirmed user.
export function Login({
  initialError,
  onSuccess,
}: {
  initialError: string | null
  onSuccess: (user: CurrentUser) => void
}) {
  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(initialError)
  const [busy, setBusy] = useState(false)
  // Starts hidden — only shown once the backend confirms Google sign-in is
  // actually configured for this deployment (see api.getAuthConfig). This
  // avoids flashing a button that would just 404 on click for self-hosters
  // who never set GOOGLE_OAUTH_CLIENT_ID.
  const [googleEnabled, setGoogleEnabled] = useState(false)

  useEffect(() => {
    let cancelled = false
    api.getAuthConfig().then((cfg) => {
      if (!cancelled) setGoogleEnabled(cfg.googleSignIn)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Google's redirect flow can't hand back an in-memory error the way
  // api.login()'s thrown ApiError does — the whole page navigated away and
  // back — so backend/internal/googleauth's failure redirect encodes it in
  // the URL instead (?error=<reason>). Picked up once on mount and then
  // stripped from the address bar so a page refresh doesn't keep re-showing
  // a stale error.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const reason = params.get('error')
    if (reason) {
      setError(googleErrorMessage(reason))
      params.delete('error')
      const rest = params.toString()
      window.history.replaceState(null, '', window.location.pathname + (rest ? `?${rest}` : ''))
    }
  }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!email.trim() || !password) return
    setBusy(true)
    setError(null)
    try {
      const user = mode === 'login' ? await api.login(email, password) : await api.register(email, password)
      // Fire-and-forget: onSuccess should proceed immediately either way,
      // this is a best-effort nudge to the browser's password manager.
      void offerToSavePassword(email, password)
      onSuccess(user)
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message)
      } else {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit} id="login-form" name="login-form">
        <div className="sidebar-brand login-brand">
          <span className="sidebar-mark" aria-hidden="true">
            ⌘
          </span>
          <span className="sidebar-brand-name">Console</span>
        </div>
        <p className="login-copy">
          {mode === 'login'
            ? 'Sign in to manage your apps, tools, and API keys.'
            : 'Create an account to start defining apps and tools.'}
        </p>
        <label className="field">
          <span className="micro-label">Email</span>
          <input
            type="email"
            name="email"
            id="login-email"
            autoFocus
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Enter your email"
          />
        </label>
        <label className="field">
          <span className="micro-label">Password</span>
          <input
            type="password"
            name="password"
            id="login-password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={mode === 'register' ? 'At least 8 characters' : 'Enter your password'}
          />
        </label>
        {error && <p className="login-error">{error}</p>}
        <button type="submit" className="primary login-submit" disabled={busy || !email.trim() || !password}>
          {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>
        {googleEnabled && (
          <>
            <div className={styles.divider} role="separator">
              or
            </div>
            {/* Plain <a>, not a fetch()/onClick handler: this has to be a
                full top-level navigation so the browser actually leaves the
                SPA and follows Google's redirect chain — see
                backend/internal/googleauth's package doc for why this can't
                be a fetch()-based flow. */}
            <a href={`${BASE}/auth/google/start`} className={styles.google}>
              <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
                <path
                  fill="#4285F4"
                  d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615Z"
                />
                <path
                  fill="#34A853"
                  d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18Z"
                />
                <path
                  fill="#FBBC05"
                  d="M3.964 10.706A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.706V4.962H.957A9.001 9.001 0 0 0 0 9c0 1.452.348 2.827.957 4.038l3.007-2.332Z"
                />
                <path
                  fill="#EA4335"
                  d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.962L3.964 7.294C4.672 5.167 6.656 3.58 9 3.58Z"
                />
              </svg>
              Continue with Google
            </a>
          </>
        )}
        <button
          type="button"
          className="login-switch"
          onClick={() => {
            setMode(mode === 'login' ? 'register' : 'login')
            setError(null)
          }}
        >
          {mode === 'login' ? "Don't have an account? Create one" : 'Already have an account? Sign in'}
        </button>
      </form>
    </div>
  )
}

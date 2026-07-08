import { useEffect, useState } from 'react'
import { api, ApiError } from './api'
import type { CurrentUser } from './api'
import { Login } from './Login'

type Status = 'checking' | 'anonymous' | 'ready' | 'approving' | 'approved' | 'error'

// CliAuthPage is what a browser lands on when `atp login --web` opens it.
// The URL only ever carries one thing — an opaque session id from
// POST /console/cli-auth/start (see backend/internal/cliauth's package
// doc) — never the CLI's actual redirect target. That's registered
// server-side, ahead of time, by the CLI itself; this page never reads or
// controls it, which is what makes a malicious link unable to redirect a
// freshly minted token anywhere an attacker chose. (This is the
// browser-redirect variant of CLI auth — see docs/cli-device-flow-design.md
// for the alternative device-code flow, and
// docs/oauth-third-party-clients-design.md for what this would need to
// become to support third-party clients, not just our own atp CLI.)
export function CliAuthPage() {
  const [status, setStatus] = useState<Status>('checking')
  const [user, setUser] = useState<CurrentUser | null>(null)
  const [cliName, setCliName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const id = new URLSearchParams(window.location.search).get('id') ?? ''

  useEffect(() => {
    if (!id) {
      setStatus('error')
      setError('This sign-in link is missing its session id.')
      return
    }

    api
      .getCliAuthName(id)
      .then(({ name }) => {
        setCliName(name)
        return api.me()
      })
      .then((u) => {
        setUser(u)
        setStatus('ready')
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          setStatus('anonymous')
          return
        }
        setStatus('error')
        setError(
          err instanceof ApiError && err.status === 404
            ? 'This sign-in link has expired or was already used. Run the CLI command again.'
            : err instanceof Error
              ? err.message
              : String(err),
        )
      })
  }, [id])

  async function approve() {
    setStatus('approving')
    setError(null)
    try {
      const { redirectUri } = await api.approveCliAuth(id)
      setStatus('approved')
      const url = new URL(redirectUri)
      url.searchParams.set('code', id)
      window.location.href = url.toString()
    } catch (err) {
      setStatus('ready')
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err))
    }
  }

  if (status === 'checking') {
    return <div className="connecting">Loading…</div>
  }

  if (status === 'anonymous') {
    return (
      <Login
        initialError={null}
        onSuccess={(u) => {
          setUser(u)
          setStatus('ready')
        }}
      />
    )
  }

  if (status === 'error') {
    return (
      <div className="login-screen">
        <div className="login-card">
          <p className="login-error">{error}</p>
        </div>
      </div>
    )
  }

  if (status === 'approved') {
    return (
      <div className="login-screen">
        <div className="login-card">
          <p className="login-copy">Signed in. You can close this tab and return to your terminal.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="sidebar-brand login-brand">
          <span className="sidebar-mark" aria-hidden="true">
            ⌘
          </span>
          <span className="sidebar-brand-name">Console</span>
        </div>
        <p className="login-copy">
          The <strong>{cliName}</strong> CLI wants to sign in as <strong>{user?.email}</strong>.
        </p>
        {error && <p className="login-error">{error}</p>}
        <button type="button" className="primary login-submit" disabled={status === 'approving'} onClick={approve}>
          {status === 'approving' ? 'Approving…' : 'Approve'}
        </button>
      </div>
    </div>
  )
}

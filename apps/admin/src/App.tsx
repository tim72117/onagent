import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from './api'
import type { PlanInfo, UserSummary } from './api'

export default function App() {
  const [me, setMe] = useState<string | null>(null)
  const [checking, setChecking] = useState(true)

  // On load, see if an admin session cookie is already valid — skips the
  // login screen on refresh. A 401 just means "show login", not an error.
  useEffect(() => {
    api
      .me()
      .then((u) => setMe(u.email))
      .catch(() => setMe(null))
      .finally(() => setChecking(false))
  }, [])

  if (checking) return <div className="center muted">Loading…</div>
  if (!me) return <Login onLoggedIn={setMe} />
  return <Dashboard adminEmail={me} onLoggedOut={() => setMe(null)} />
}

function Login({ onLoggedIn }: { onLoggedIn: (email: string) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const u = await api.login(email, password)
      onLoggedIn(u.email)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Login failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="center">
      <form className="card login" onSubmit={submit}>
        <h1>onagent admin</h1>
        <p className="muted">Operator sign-in. Separate from developer accounts.</p>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <div className="error">{error}</div>}
        <button type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}

function Dashboard({ adminEmail, onLoggedOut }: { adminEmail: string; onLoggedOut: () => void }) {
  const [total, setTotal] = useState<number | null>(null)
  const [users, setUsers] = useState<UserSummary[]>([])
  const [plans, setPlans] = useState<PlanInfo[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [usersRes, plansRes] = await Promise.all([api.listUsers(), api.listPlans()])
      setTotal(usersRes.total)
      setUsers(usersRes.users)
      setPlans(plansRes)
    } catch (err) {
      // A 401 here means the session expired mid-session — bounce to login.
      if (err instanceof ApiError && err.status === 401) {
        onLoggedOut()
        return
      }
      setError(err instanceof ApiError ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [onLoggedOut])

  useEffect(() => {
    void load()
  }, [load])

  const changePlan = async (userId: number, tier: string) => {
    try {
      await api.setUserPlan(userId, tier)
      // Re-fetch so the derived limit/usage columns reflect the new plan
      // (the allowance comes from the plan, not a stored per-row copy).
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to change plan')
    }
  }

  const logout = async () => {
    try {
      await api.logout()
    } finally {
      onLoggedOut()
    }
  }

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <h1>onagent admin</h1>
          <span className="muted">{adminEmail}</span>
        </div>
        <button className="ghost" onClick={logout}>
          Sign out
        </button>
      </header>

      <section className="stats">
        <div className="stat card">
          <div className="stat-num">{total ?? '—'}</div>
          <div className="stat-label">Total users</div>
        </div>
      </section>

      {error && <div className="error banner">{error}</div>}

      <section className="card">
        <div className="section-head">
          <h2>Users</h2>
          <button className="ghost" onClick={() => void load()} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Email</th>
                <th>Plan</th>
                <th>Usage (this period)</th>
                <th>Change plan</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td className="muted">{u.id}</td>
                  <td>{u.email}</td>
                  <td>
                    {u.planName}
                    {u.quotaOverride != null && <span className="badge" title="Manual per-user override">override</span>}
                  </td>
                  <td className={u.used >= u.limit ? 'over' : ''}>
                    {u.used} / {u.limit}
                  </td>
                  <td>
                    <select value={u.tier} onChange={(e) => void changePlan(u.id, e.target.value)}>
                      {plans.map((p) => (
                        <option key={p.tier} value={p.tier}>
                          {p.name} ({p.monthlyPrompts}/mo)
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
              {users.length === 0 && !loading && (
                <tr>
                  <td colSpan={5} className="muted center-cell">
                    No users yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

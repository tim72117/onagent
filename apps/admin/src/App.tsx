import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from './api'
import type { IntegrityResponse, PlanInfo, SchemaCheck, UserSummary } from './api'

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

type Tab = 'users' | 'schema'

function Dashboard({ adminEmail, onLoggedOut }: { adminEmail: string; onLoggedOut: () => void }) {
  const [tab, setTab] = useState<Tab>('users')

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

      <nav className="tabs">
        <button className={tab === 'users' ? 'tab active' : 'tab'} onClick={() => setTab('users')}>
          Users
        </button>
        <button className={tab === 'schema' ? 'tab active' : 'tab'} onClick={() => setTab('schema')}>
          Schema check
        </button>
      </nav>

      {tab === 'users' && <UsersTab onLoggedOut={onLoggedOut} />}
      {tab === 'schema' && <SchemaCheckTab onLoggedOut={onLoggedOut} />}
    </div>
  )
}

function UsersTab({ onLoggedOut }: { onLoggedOut: () => void }) {
  const [total, setTotal] = useState<number | null>(null)
  const [users, setUsers] = useState<UserSummary[]>([])
  const [plans, setPlans] = useState<PlanInfo[]>([])
  const [integrity, setIntegrity] = useState<IntegrityResponse | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [usersRes, plansRes, integrityRes] = await Promise.all([
        api.listUsers(),
        api.listPlans(),
        api.checkIntegrity(),
      ])
      setTotal(usersRes.total)
      setUsers(usersRes.users)
      setPlans(plansRes)
      setIntegrity(integrityRes)
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

  return (
    <>
      <section className="stats">
        <div className="stat card">
          <div className="stat-num">{total ?? '—'}</div>
          <div className="stat-label">Total users</div>
        </div>
      </section>

      {error && <div className="error banner">{error}</div>}

      {integrity && (
        <section className="card">
          <div className="section-head">
            <h2>
              Data integrity{' '}
              <span className={integrity.healthy ? 'badge ok' : 'badge bad'}>
                {integrity.healthy ? 'healthy' : 'attention needed'}
              </span>
            </h2>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Check</th>
                  <th>Rows</th>
                  <th>What it means</th>
                </tr>
              </thead>
              <tbody>
                {integrity.checks.map((c) => (
                  <tr key={c.key}>
                    <td>
                      {c.label}
                      {/* An "info" check is reported for auditability, not as a
                          failure — it has an expected non-zero count. */}
                      {!c.ok && c.severity !== 'info' && (
                        <span className={c.severity === 'critical' ? 'badge bad' : 'badge warn'}>
                          {c.severity}
                        </span>
                      )}
                    </td>
                    <td className={!c.ok && c.severity === 'critical' ? 'over' : ''}>{c.count}</td>
                    <td className="muted">{c.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

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
    </>
  )
}

// SchemaCheckTab compares every migrated table's GORM struct definitions
// against the live database — see db.CheckTable's doc comment on the
// backend for what this catches (a column or primary key renamed on one
// side and not the other) that a hand-maintained schema.sql alone wouldn't
// surface until someone went looking for it.
function SchemaCheckTab({ onLoggedOut }: { onLoggedOut: () => void }) {
  const [tables, setTables] = useState<SchemaCheck[] | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.checkSchema()
      setTables(res.tables)
    } catch (err) {
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

  const problemCount = (tables ?? []).filter((t) => !t.ok).length

  return (
    <>
      {error && <div className="error banner">{error}</div>}

      <section className="card">
        <div className="section-head">
          <h2>Schema check</h2>
          <button className="ghost" onClick={() => void load()} disabled={loading}>
            {loading ? 'Checking…' : 'Recheck'}
          </button>
        </div>
        {tables !== null && (
          <p className="muted">
            {problemCount === 0
              ? `All ${tables.length} tables match their struct definitions.`
              : `${problemCount} of ${tables.length} tables have drifted from their struct definitions.`}
          </p>
        )}
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Table</th>
                <th>Status</th>
                <th>Missing columns</th>
                <th>Extra columns</th>
                <th>Primary key</th>
              </tr>
            </thead>
            <tbody>
              {(tables ?? []).map((t) => (
                <tr key={t.table}>
                  <td>{t.table}</td>
                  <td>
                    <span className={`status-dot ${t.ok ? 'status-ok' : 'status-error'}`} />
                    {t.ok ? 'OK' : 'Drifted'}
                  </td>
                  <td className={t.missingColumns?.length ? 'error-cell' : 'muted'}>
                    {t.missingColumns?.length ? t.missingColumns.join(', ') : '—'}
                  </td>
                  <td className={t.extraColumns?.length ? 'error-cell' : 'muted'}>
                    {t.extraColumns?.length ? t.extraColumns.join(', ') : '—'}
                  </td>
                  <td className={t.primaryKeyMismatch ? 'error-cell' : 'muted'}>
                    {t.primaryKeyMismatch
                      ? `expected (${t.primaryKeyMismatch.expected.join(', ')}), actual (${t.primaryKeyMismatch.actual.join(', ')})`
                      : '—'}
                  </td>
                </tr>
              ))}
              {(tables === null || tables.length === 0) && !loading && (
                <tr>
                  <td colSpan={5} className="muted center-cell">
                    No data yet.
                  </td>
                </tr>
              )}
              {loading && tables === null && (
                <tr>
                  <td colSpan={5} className="muted center-cell">
                    Checking…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}

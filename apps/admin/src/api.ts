// Client for the backend's /admin/api/* endpoints (backend/internal/
// adminconsole). Auth is a SEPARATE session cookie from the developer
// console (backend/internal/adminauth, cookie "admin_session"): every call
// sends credentials: 'include', and the backend's CORS layer echoes the
// request Origin for /admin/* (main.go withCORS) so a credentialed
// cross-origin response is accepted in dev. A 401 means the admin session
// is missing/expired; callers drop back to the login screen.

export interface AdminUser {
  email: string
}

// One row of the user table. Mirrors quota.UserSummary on the backend.
export interface UserSummary {
  id: number
  email: string
  tier: string
  planName: string
  limit: number
  used: number
  quotaOverride?: number
  createdAt: string
}

export interface UsersResponse {
  total: number
  users: UserSummary[]
}

export interface PlanInfo {
  tier: string
  name: string
  monthlyPrompts: number
}

// Same resolution strategy as the console's api.ts BASE: an explicit
// VITE_ADMIN_API_URL for local dev against a separately-running backend,
// falling back to the serving origin (correct in production, where the
// admin SPA is embedded same-origin under /admin).
export const BASE: string = import.meta.env.VITE_ADMIN_API_URL ?? window.location.origin

export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request(method: string, path: string, body?: unknown): Promise<Response> {
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      credentials: 'include',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new ApiError(0, `Cannot reach the backend at ${BASE}. Is it running?`)
  }
  if (!res.ok) {
    const text = (await res.text()).trim()
    throw new ApiError(res.status, text || res.statusText)
  }
  return res
}

export const api = {
  login: (email: string, password: string): Promise<AdminUser> =>
    request('POST', '/admin/api/login', { email, password }).then((r) => r.json()),

  logout: (): Promise<void> => request('POST', '/admin/api/logout').then(() => undefined),

  me: (): Promise<AdminUser> => request('GET', '/admin/api/me').then((r) => r.json()),

  listUsers: (): Promise<UsersResponse> => request('GET', '/admin/api/users').then((r) => r.json()),

  listPlans: (): Promise<PlanInfo[]> => request('GET', '/admin/api/plans').then((r) => r.json()),

  setUserPlan: (userId: number, tier: string): Promise<void> =>
    request('PUT', `/admin/api/users/${userId}/plan`, { tier }).then(() => undefined),
}

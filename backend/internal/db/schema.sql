-- Schema for the onagent backend's own state: registered apps,
-- their tool definitions, and API key hashes. Replaces the earlier
-- filesystem-backed design (backend/tools/*.yaml + backend/apps/*.json) —
-- see internal/toolschema and internal/auth, which now read/write through
-- this database instead of the filesystem.
--
-- Applied once at startup by db.Open (idempotent: every statement is
-- CREATE ... IF NOT EXISTS), not by a separate migration tool — the schema
-- is small and stable enough that a hand-rolled migration runner would be
-- more machinery than the problem warrants.

CREATE TABLE IF NOT EXISTS users (
    id            BIGSERIAL PRIMARY KEY,
    email         TEXT NOT NULL,
    password_hash TEXT NOT NULL, -- bcrypt
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness: "Dev@Example.com" and "dev@example.com" must
-- collide at signup, not create two accounts that can never both log in
-- with the "same" address a human would type.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));

CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY, -- opaque random token; also the cookie value
    user_id    BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);

-- Long-lived bearer tokens for CLI/API access, distinct from the
-- browser-only session cookie above: a user can hold several (one per
-- machine/CI context), each independently named and revocable, unlike a
-- session which is single-use-until-logout. See internal/usertoken.
CREATE TABLE IF NOT EXISTS user_tokens (
    id           BIGSERIAL PRIMARY KEY, -- what Revoke/List address a token by; token_hash itself is never exposed to a caller
    token_hash   TEXT NOT NULL,         -- sha256 hex of the plaintext token
    user_id      BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name         TEXT NOT NULL,         -- human label, e.g. "laptop" — helps tell tokens apart when revoking
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ            -- updated on each successful Verify; NULL until first use
);

CREATE INDEX IF NOT EXISTS user_tokens_user_id_idx ON user_tokens (user_id);

-- Same rationale as apps_api_key_hash_idx: token_hash must stay globally
-- unique so two tokens can never collide onto the same user by accident,
-- but it's an indexed lookup column (Verify's WHERE clause), not the
-- primary key a caller addresses a token by.
CREATE UNIQUE INDEX IF NOT EXISTS user_tokens_token_hash_idx ON user_tokens (token_hash);

-- Backs the browser-redirect CLI login flow (onagent login --web): a
-- short-lived, single-use, opaque handoff between the CLI's local
-- callback server and the console page the user approves in. The id
-- itself (32 random bytes) is the only thing that ever appears in the
-- browser's URL — the real redirect_uri never does, which is what makes a
-- malicious link unable to redirect a freshly minted token anywhere: an
-- attacker has no way to get their own redirect_uri associated with a
-- session id, since that association only happens server-side, in
-- response to the CLI's own POST /console/cli-auth/start call.
CREATE TABLE IF NOT EXISTS cli_auth_sessions (
    id           TEXT PRIMARY KEY,       -- opaque, what appears in URLs
    redirect_uri TEXT NOT NULL,          -- validated (loopback-only) at creation; never re-derived from anything client-supplied afterward
    name         TEXT NOT NULL,          -- token label, e.g. the CLI's hostname
    token        TEXT,                   -- the plaintext usertoken, set once approved; cleared the instant /exchange returns it (single collection)
    approved     BOOLEAN NOT NULL DEFAULT false,
    expires_at   TIMESTAMPTZ NOT NULL,   -- ~10 minutes from creation
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS apps (
    app_id         TEXT PRIMARY KEY,
    owner_id       BIGINT REFERENCES users (id) ON DELETE CASCADE, -- NULL only for apps migrated before multi-user existed
    api_key_hash   TEXT,              -- sha256 hex, NULL until a key is issued
    allowed_origin TEXT,              -- exact Origin header a connection must present; NULL = no site configured yet, so every WS handshake for this app is rejected (fail-closed) — see ws.Handler.ServeHTTP
    thought        TEXT,              -- per-app want agent system prompt; NULL = use the platform default (want_tools.go's defaultThought)
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ALTER ... ADD COLUMN IF NOT EXISTS so this stays idempotent for databases
-- created before these columns existed (CREATE TABLE IF NOT EXISTS above is
-- a no-op against an existing table and would silently skip new columns
-- otherwise).
ALTER TABLE apps ADD COLUMN IF NOT EXISTS allowed_origin TEXT;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS owner_id BIGINT REFERENCES users (id) ON DELETE CASCADE;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS thought TEXT;

CREATE INDEX IF NOT EXISTS apps_owner_id_idx ON apps (owner_id);

-- One active key per app in this design (Issue overwrites), but a key must
-- still be globally unique — two apps can never end up authenticating as
-- each other because of a hash collision or a bug that copies a row.
CREATE UNIQUE INDEX IF NOT EXISTS apps_api_key_hash_idx
    ON apps (api_key_hash) WHERE api_key_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS tools (
    app_id      TEXT NOT NULL REFERENCES apps (app_id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    description TEXT NOT NULL,
    parameters  JSONB NOT NULL, -- toolschema.ParameterSchema, serialized
    returns     JSONB,          -- toolschema.ParameterSchema, serialized; NULL if undeclared
    kind        TEXT NOT NULL DEFAULT 'action', -- toolschema.ToolKind: "action" (default) or "query"
    position    INTEGER NOT NULL, -- preserves declaration order within an app
    PRIMARY KEY (app_id, name)
);

-- CREATE TABLE IF NOT EXISTS is a no-op against an already-existing table,
-- so a column added after the table's first deployment (like `kind` above)
-- needs its own idempotent migration here — this runs on every startup
-- (see internal/db.Open), so it must stay safe to re-run indefinitely.
ALTER TABLE tools ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'action';

-- Subscription tier + billing-cycle anchor per user. One row per user,
-- written at signup (session.Register) with just a tier; readers still
-- treat a missing row as the default (free) tier so a user created before
-- this table existed, or by any path that skips the insert, is never
-- rejected for lack of a row. The prompt allowance is NOT stored here — it
-- is derived from the tier's plan at query time (internal/quota.PlanFor),
-- so changing a plan's number applies to every user on that tier with no
-- migration. monthly_quota is an OPTIONAL per-user override (NULL for
-- almost everyone) that wins over the plan value when set — the manual
-- "grant this one user more" lever. Period boundaries are DERIVED from
-- started_at at query time, not reset by a scheduled job — that is what
-- avoids a reset-boundary race on a mutable counter.
CREATE TABLE IF NOT EXISTS subscriptions (
    user_id       BIGINT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    tier          TEXT NOT NULL DEFAULT 'free', -- 'free' | 'pro' | ... ; free text, not an enum, so a new tier needs no migration
    monthly_quota INTEGER,                       -- OPTIONAL per-user override of the tier plan's allowance; NULL = use the plan value (internal/quota.PlanFor)
    started_at    TIMESTAMPTZ NOT NULL DEFAULT now(), -- billing-cycle anchor: the "day of month" this user's period boundary is computed from, mirroring Stripe's billing_cycle_anchor
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- monthly_quota was NOT NULL in the table's first version (it held the
-- actual allowance). It's now an optional override, so relax the constraint
-- for databases created under the old definition. Idempotent: DROP NOT NULL
-- is a no-op if the column is already nullable.
ALTER TABLE subscriptions ALTER COLUMN monthly_quota DROP NOT NULL;

-- Append-only usage ledger: one row per billable event (today, one
-- WebSocket `prompt` that reached inference.Service.Complete). Current
-- usage for a period is always COMPUTED from this table
-- (COUNT(*) WHERE app_id IN owner's apps AND created_at >= period_start),
-- never kept as a running counter — see the design doc (section 3) for why
-- this sidesteps the reset-boundary race a mutable counter would need to
-- guard against.
CREATE TABLE IF NOT EXISTS usage_events (
    id         BIGSERIAL PRIMARY KEY,
    app_id     TEXT NOT NULL REFERENCES apps (app_id) ON DELETE CASCADE, -- attribution matches inference.Request.AppID, already threaded through ws.Session.handlePrompt
    event_id   TEXT NOT NULL,                   -- caller-supplied idempotency key (the WebSocket RequestID); prevents double-counting on retry, mirroring Stripe's meter event identifier
    kind       TEXT NOT NULL DEFAULT 'prompt',  -- 'prompt' today; room for 'tool_call' or token-based units later without a schema change
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotency: the same event_id must never be counted twice, even if a
-- client retries a request whose response it never saw (e.g. a dropped
-- WebSocket write). Scoped per-app rather than globally unique, matching
-- how RequestID is only unique within one session/app's own traffic.
CREATE UNIQUE INDEX IF NOT EXISTS usage_events_app_id_event_id_idx
    ON usage_events (app_id, event_id);

-- The query this whole design exists to make fast: "how much has this app
-- used since some timestamp." Every enforcement point (ws.Handler.ServeHTTP
-- at handshake, ws.Session.handlePrompt per message) filters on exactly
-- these two columns together.
CREATE INDEX IF NOT EXISTS usage_events_app_id_created_at_idx
    ON usage_events (app_id, created_at);

-- ── Admin back-office (internal/adminauth, apps/admin) ────────────────────
-- The admin console is a DELIBERATELY SEPARATE system from the developer-
-- facing accounts above. admin_users is its own identity table, unrelated
-- to users: an admin is not a users row with a flag, so no vulnerability in
-- the public users/session flow can ever escalate into admin access. The
-- first admin is seeded from ADMIN_BOOTSTRAP_EMAIL/PASSWORD at startup (see
-- main.go); there is no API path that promotes a user to admin.
CREATE TABLE IF NOT EXISTS admin_users (
    id            BIGSERIAL PRIMARY KEY,
    email         TEXT NOT NULL,
    password_hash TEXT NOT NULL, -- bcrypt, same scheme as users.password_hash
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS admin_users_email_lower_idx ON admin_users (lower(email));

-- Admin browser sessions, separate from the developer `sessions` table and
-- carried in a separate cookie (adminauth.CookieName = "admin_session") so
-- the two session systems never overlap: holding a developer session grants
-- nothing here, and vice versa.
CREATE TABLE IF NOT EXISTS admin_sessions (
    id            TEXT PRIMARY KEY, -- opaque random token; also the cookie value
    admin_user_id BIGINT NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
    expires_at    TIMESTAMPTZ NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_sessions_admin_user_id_idx ON admin_sessions (admin_user_id);

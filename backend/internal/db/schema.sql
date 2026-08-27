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
    password_hash TEXT, -- bcrypt; NULL for an account that has never set a password (OAuth-only, e.g. Google)
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- password_hash was NOT NULL in the table's first version (every account
-- was email/password). Google sign-in can create an account with no
-- password at all, so this relaxes the constraint for databases created
-- under the old definition. Idempotent: DROP NOT NULL is a no-op if the
-- column is already nullable.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- Case-insensitive uniqueness: "Dev@Example.com" and "dev@example.com" must
-- collide at signup, not create two accounts that can never both log in
-- with the "same" address a human would type.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));

-- One row per (provider, external account) a user has linked — kept
-- separate from `users` rather than a users.google_id column so adding a
-- second provider (GitHub, Apple, ...) later needs no users schema change,
-- and one user can link more than one provider. provider_email is stored
-- for display/debugging only; the actual identity match is always
-- (provider, provider_user_id), never email — an OAuth provider's email can
-- change, but its subject id doesn't.
CREATE TABLE IF NOT EXISTS identities (
    id                BIGSERIAL PRIMARY KEY,
    user_id           BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    provider          TEXT NOT NULL,   -- 'google' today; room for more without a schema change
    provider_user_id  TEXT NOT NULL,   -- the provider's stable subject id (Google's `sub` claim)
    provider_email    TEXT,            -- provider's email at link time, display-only
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS identities_user_id_idx ON identities (user_id);

-- The lookup Verify does on every OAuth callback, and what stops one
-- provider account from ever linking to two different users.
CREATE UNIQUE INDEX IF NOT EXISTS identities_provider_provider_user_id_idx
    ON identities (provider, provider_user_id);

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
    app_id           TEXT NOT NULL REFERENCES apps (app_id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    description      TEXT NOT NULL,
    parameters       JSONB NOT NULL, -- toolschema.ParameterSchema, serialized
    returns          JSONB,          -- toolschema.ParameterSchema, serialized; NULL if undeclared
    kind             TEXT NOT NULL DEFAULT 'action', -- toolschema.ToolKind: "action" (default) or "query"
    backend_dispatch JSONB,          -- toolschema.BackendDispatch, serialized; NULL if this tool dispatches to the browser (the default)
    position         INTEGER NOT NULL, -- preserves declaration order within an app
    PRIMARY KEY (app_id, name)
);

-- CREATE TABLE IF NOT EXISTS is a no-op against an already-existing table,
-- so a column added after the table's first deployment (like `kind` above)
-- needs its own idempotent migration here — this runs on every startup
-- (see internal/db.Open), so it must stay safe to re-run indefinitely.
ALTER TABLE tools ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'action';
ALTER TABLE tools ADD COLUMN IF NOT EXISTS backend_dispatch JSONB;

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
-- (COUNT(*) WHERE owner_id = ... AND created_at >= period_start), never
-- kept as a running counter — see the design doc (section 3) for why this
-- sidesteps the reset-boundary race a mutable counter would need to guard
-- against.
--
-- owner_id, not just app_id, is what usage is billed against: a ledger has
-- to outlive the thing it bills for. app_id alone made deleting an app
-- cascade its whole usage history away, so delete-app/recreate-app reset
-- the month's quota to zero — free, unlimited, self-service. See the
-- owner_id backfill and the FK change below.
CREATE TABLE IF NOT EXISTS usage_events (
    id         BIGSERIAL PRIMARY KEY,
    app_id     TEXT REFERENCES apps (app_id) ON DELETE SET NULL, -- attribution matches inference.Request.AppID, already threaded through ws.Session.handlePrompt; NULL once the app is deleted, but the row (and its owner_id) survives
    owner_id   BIGINT REFERENCES users (id) ON DELETE CASCADE,   -- who this is billed to; denormalized from apps.owner_id at write time so the ledger no longer depends on the app still existing
    event_id   TEXT NOT NULL,                   -- caller-supplied idempotency key (the WebSocket RequestID); prevents double-counting on retry, mirroring Stripe's meter event identifier
    kind       TEXT NOT NULL DEFAULT 'prompt',  -- 'prompt' today; room for 'tool_call' or token-based units later without a schema change
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotent migration for databases created before owner_id existed. The
-- backfill resolves each existing row's owner through the app it was
-- recorded against; rows whose app is already gone stay NULL (that history
-- is unrecoverable — it was cascade-deleted before this column existed).
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS owner_id BIGINT REFERENCES users (id) ON DELETE CASCADE;

UPDATE usage_events ue
   SET owner_id = a.owner_id
  FROM apps a
 WHERE a.app_id = ue.app_id
   AND ue.owner_id IS NULL;

-- Drop the original ON DELETE CASCADE on app_id (and its NOT NULL) so
-- deleting an app no longer takes the billing record with it. Postgres has
-- no ALTER CONSTRAINT for this, so the constraint is dropped and re-added
-- by name; the DO block keeps that idempotent across restarts, since this
-- file re-runs on every boot (see internal/db.Open).
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.referential_constraints
         WHERE constraint_name = 'usage_events_app_id_fkey'
           AND delete_rule = 'CASCADE'
    ) THEN
        ALTER TABLE usage_events DROP CONSTRAINT usage_events_app_id_fkey;
        ALTER TABLE usage_events
            ADD CONSTRAINT usage_events_app_id_fkey
            FOREIGN KEY (app_id) REFERENCES apps (app_id) ON DELETE SET NULL;
        ALTER TABLE usage_events ALTER COLUMN app_id DROP NOT NULL;
    END IF;
END $$;

-- Idempotency: the same event_id must never be counted twice, even if a
-- client retries a request whose response it never saw (e.g. a dropped
-- WebSocket write). Scoped per-app rather than globally unique, matching
-- how RequestID is only unique within one session/app's own traffic.
CREATE UNIQUE INDEX IF NOT EXISTS usage_events_app_id_event_id_idx
    ON usage_events (app_id, event_id);

-- The query this whole design exists to make fast: "how much has this OWNER
-- used since some timestamp." Every enforcement point (ws.Handler.ServeHTTP
-- at handshake, ws.Session.handlePrompt per message) filters on exactly
-- these two columns together — and does so without joining apps, which is
-- what lets the count survive an app deletion.
CREATE INDEX IF NOT EXISTS usage_events_owner_id_created_at_idx
    ON usage_events (owner_id, created_at);

-- Kept for per-app reporting (and for the idempotency index's prefix); the
-- billing path itself no longer uses it.
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

-- Backs internal/sessionstore.Store, a want types.SessionStore
-- implementation (see want doc/guide-custom-session-store-2026-08.md) that
-- persists each WebSocket session's conversation history across process
-- restarts/redeploys, replacing want's own default (in-memory-until-Stop,
-- or its opt-in local .jsonl adapter — neither of which onagent used
-- before this table). session_id is want's own key (WantService's
-- sessionKeyFor, prefixed "WS-" as Orchestrator.AgentID) — no FK to
-- anything else here, since a session can outlive the app/user it was
-- opened under and its history should still be loadable.
--
-- app_id scopes every read/write to the app the session belongs to (see
-- docs/sessionstore-architecture-review-2026-08-14.md's #1/#3): without it,
-- Load(sessionID) has no access control at all beyond session_id staying
-- unguessable, and a caller with no valid SessionID (sessionKeyFor's ""
-- fallback — see want.go) would share one persisted history across every
-- such caller, not just one in-memory orchestrator. No FK for the same
-- reason session_id has none — an app can be deleted while its past
-- session history should still exist for audit/debugging.
CREATE TABLE IF NOT EXISTS agent_experiences (
    id         BIGSERIAL PRIMARY KEY,
    session_id TEXT NOT NULL,
    app_id     TEXT NOT NULL,
    exp_id     TEXT NOT NULL, -- want's per-Experience uuid, deduplicated below so a redelivered Append is a no-op
    data       JSONB NOT NULL, -- types.Experience, serialized
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotent for a database that already created this table before app_id
-- existed (this feature has never shipped to a real deployment, but a local
-- dev database may have run schema.sql before this column was added).
ALTER TABLE agent_experiences ADD COLUMN IF NOT EXISTS app_id TEXT NOT NULL DEFAULT '';

-- Load orders by id (insertion order) and always filters by app_id too, so
-- this index covers Load's WHERE + ORDER BY in one pass; also the natural
-- place to dedupe Append (app_id is redundant in the unique key itself,
-- since one session_id only ever belongs to one app_id, but including it
-- keeps this index self-sufficient for the dedupe check without a second
-- lookup against session_id alone).
CREATE UNIQUE INDEX IF NOT EXISTS agent_experiences_session_id_exp_id_idx
    ON agent_experiences (session_id, exp_id);
CREATE INDEX IF NOT EXISTS agent_experiences_app_id_session_id_id_idx
    ON agent_experiences (app_id, session_id, id);

-- Superseded by the (app_id, session_id, id) index above — Load now always
-- filters on app_id too, so this session_id-only index is dead weight on a
-- database that ran schema.sql before app_id existed. Safe to drop
-- unconditionally: nothing else queries by session_id alone.
DROP INDEX IF EXISTS agent_experiences_session_id_id_idx;

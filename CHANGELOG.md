# Changelog

All notable changes to this project are documented here, one entry per git
tag. Format loosely follows [Keep a Changelog](https://keepachangelog.com/);
versioning follows semver conventions for a pre-1.0 project (see
`.claude/skills/version-tagging`: a breaking change bumps minor, not patch,
until 1.0).

## v0.2.13

No breaking changes — patch release. One admin-only API field
(`GET /admin/api/users`' `tier`) gains a new possible value (`""`), but
that endpoint has no caller outside this repo's own `apps/admin`, which is
updated in the same commit.

- Fix the admin user list fabricating a "free" tier for accounts with no
  `subscriptions` row at all. Traced from a real report of an account's
  usage never incrementing in production: `ListUsers`'
  `COALESCE(sub.tier, 'free')` and `COALESCE(sub.started_at, now())` made
  such an account look like a normal free-tier account whose billing
  period was, in reality, being recomputed to start "right now" on every
  admin page load — permanently hiding any real usage it had ever
  accumulated. `ListUsers` now reports `Tier == ""` for these accounts
  instead (`backend/internal/quota/admin.go`); enforcement
  (`ownerStanding`/`StandingFor`) is untouched, since an account actively
  using the product is a different situation from a historical one with
  no row at all. The admin UI shows these as an unselected plan dropdown
  and "—" for plan/usage rather than a misleading `0/100`.
- Add `CGO_ENABLED=0` to `release-claude-skill.yml`'s binary builds — the
  first CI-built `linux-amd64` binary linked dynamically against the
  runner's libc, which `release-onagent.yml` already avoids for its own
  binaries.

## v0.2.12

No breaking changes — patch release. Adds a new, independently-versioned
npm package and a manual-only CI workflow; doesn't touch the onagent CLI's
existing flags/behavior, the backend's HTTP/WebSocket API, or any database
schema.

- Publish `@onagent/claude-skill` on npm (`npx claude-skill-onagent`),
  packaging the `onagent-cli-setup` Claude Code skill with 5 bundled
  `onagent` CLI binaries (Windows, Intel/Apple Silicon macOS, Linux
  amd64/arm64), stripped with the same `-trimpath -ldflags="-s -w"`
  `release-onagent.yml` uses. Verified end-to-end locally: `npm pack`,
  `npx` install, `login --web`, and `list-apps` against production all
  succeed.
- Remove `.claude/skills/onagent-cli-setup/` (the repo-root vendored copy
  of this skill) and gitignore it — `packages/claude-skill/skill/SKILL.md`
  is now the sole copy and source of truth.
- Add `.github/workflows/release-claude-skill.yml`, a manual-only
  (`workflow_dispatch`) publish workflow mirroring
  `release-bridge-sdk.yml`'s structure: builds all 5 binaries, checks the
  version isn't already published, then `npm publish`.
- Switch `release-claude-skill.yml` and `release-bridge-sdk.yml` to npm
  Trusted Publishing (OIDC) — `@onagent/claude-skill`'s first real publish
  hit npm's 2FA-required error once "disallow bypass 2FA tokens" was
  enabled on the package; OIDC needs no stored token at all. `NPM_TOKEN`
  stays for now since `@onagent/bridge`'s Trusted Publisher isn't
  configured yet.
- Fix Google OAuth's post-login redirect landing on the marketing site
  instead of the console SPA — it pointed at `consoleOrigin+"/"` instead
  of `consoleOrigin+"/app"` (where the console is actually mounted).
- Add `VITE_DISABLE_ANALYTICS` (`apps/console/.env.example`) to skip
  loading gtag.js entirely during local console testing, so neither page
  views nor the registration conversion event pollute real GA4/Ads
  numbers. Defaults to sending, matching production.
- Restructure the console's login page: a new `LoginCard` shell (modeled
  on tripace/web's own) renders the brand mark and a greeting above the
  form card as its own small hero, shared by `Login.tsx` and
  `CliAuthPage.tsx`'s three inline states instead of each hand-rolling
  the same markup. Also drops a stale sidebar hint about API keys.
- Fix inaccurate claims on the pricing page: quota is 100 prompts per
  *account* per month shared across all that account's apps, not per
  app (`backend/internal/quota` sums usage by `owner_id`); removed
  "local development needs no API key" (the WebSocket handshake rejects
  any missing/invalid token unconditionally, no dev-mode bypass exists).
- Redesign the landing page's hero demo around a merchant admin flow
  (deleting sold-out stock, listing a new product with variants) with a
  click-to-front window swap between the terminal and the mock admin
  panel; fix several places the English and Traditional Chinese landing
  pages had drifted out of sync (a feature card's copy, a placeholder
  WebSocket URL, a case-study card's tool-call sequence).
- Update the docs page's Claude Code skill section for the npm-packaged
  skill above — it previously described a Windows-only bundled binary
  that no longer reflects how the skill is actually installed.

## v0.2.11

No breaking changes — patch release. Purely additive pages and one
display-only admin column; no existing route, API shape, or behavior
changes.

- Add `/privacy/` and `/terms/` as real `apps/landing` build entries
  (registered in `vite.config.ts`'s `rollupOptions.input`, matching every
  other page in that directory), linked from every landing page's footer
  (`/`, `/zh-tw/`, `/pricing/`, `/zh-tw/pricing/`) and listed in
  `sitemap.xml`. Needed to satisfy Google's OAuth consent screen publish
  flow, which requires a privacy policy and terms of service link once any
  listed link is present, and requires their domain to be on the
  authorized-domains allowlist.
- Add a "Created" column to the admin console's user table
  (`apps/admin/src/App.tsx`) — `quota.UserSummary.CreatedAt` was already
  returned by `GET /admin/api/users`, just never rendered.
- Fix `pricing/index.html` and `zh-tw/pricing/index.html` pointing at
  `docs/subscription-usage-quota-design.md`, a design doc deleted in v0.2.6
  once its "already implemented" claims were verified against the code —
  both now point at `backend/internal/quota`, the actual implementation.

## v0.2.10

No breaking changes — patch release. Purely additive `<script>` tags on
static HTML entry points; no existing behavior changes.

- Add the same Google tag (`gtag.js`, `AW-18416841975` / `G-MP4CK0P8JF`)
  used by `apps/console` to all four `apps/landing` entry points (`/`,
  `/docs/`, `/pricing/`, `/zh-tw/`) — page views on the marketing site
  itself were previously untracked; only the console (post-registration)
  was recording anything.
- Resolve a stash-pop conflict in `.gitignore` left over from a prior
  session (both sides excluded `marketing/`; kept the version without
  the now-stale `/fb-page-tools/` rule, since `fb-page-tools` moved
  under `marketing/` already).

## v0.2.9

No breaking changes — patch release. Per this project's breaking-change
judgment (`.claude/skills/version-tagging/override.md`), Google Sign-In is
a purely additive, opt-in capability (disabled unless
`GOOGLE_OAUTH_CLIENT_ID` is set) and the schema change only widens an
existing constraint; nothing an existing deployment or caller depends on
changes shape or behavior.

- Add "Sign in with Google" to the developer console, alongside the
  existing email/password login — a standard server-side OAuth 2.0
  authorization-code flow (`backend/internal/googleauth`), not the
  JS-SDK/One-Tap popup flow, so it fits the console's existing
  cookie-session model with zero new frontend dependencies. Signing in
  with a Google account whose email matches an existing email/password
  account links the two (same user, both login methods work afterward)
  rather than creating a duplicate account; a brand-new Google sign-in
  creates a passwordless account. Requires `GOOGLE_OAUTH_CLIENT_ID` /
  `GOOGLE_OAUTH_CLIENT_SECRET` / `GOOGLE_OAUTH_REDIRECT_URL` — unset by
  default, so existing deployments are unaffected until an operator
  opts in (see the new `backend/.env.example` and the updated
  `deploy/update-secret-manager.sh` / `deploy-cloudrun.yml`).
- Widen `users.password_hash` to nullable and add a new `identities`
  table (`(provider, provider_user_id)`, unique-indexed) to back the
  account-linking above — both additive, idempotent schema changes
  (`ALTER COLUMN ... DROP NOT NULL`, `CREATE TABLE IF NOT EXISTS`); no
  existing row or query is affected.
- Add `backend/.env.example` documenting every environment variable
  `cmd/server -h` accepts, so a new contributor's `.env` doesn't
  silently miss one (README now points to it instead of a bare env-var
  table).
- Split `apps/console/src/{Login,SchemaEditor}.module.css` out of the
  single global `style.css` into per-component CSS Modules — the first
  steps of an incremental migration off one shared stylesheet; no visual
  change.
- Reorganize `docs/` into `audit-*` (security/functional/stability,
  undated, continuously updated), `research-*`, and `refactor-*` (dated,
  one-shot snapshots), codified in a new `.claude/skills/doc-file-format`.
  Splits the old mixed `project-audit.md` into `audit-security.md` and
  `audit-functional.md`, pulls the real stability/concurrency findings out
  of the old stability-triage doc into a new `audit-stability.md`, folds
  `project-health-review-2026-07-22.md`'s still-relevant findings into the
  audit files and removes it, and renames the remaining research/refactor
  docs with their original dates.
- Add Google Ads conversion tracking for new console registrations —
  fires a GA4 `sign_up` event and a Google Ads conversion event exactly
  once per genuine new account (not on every login), from both signup
  paths: email/password (`Login.tsx`) and Google sign-in, the latter
  needing `LoginOrCreateWithGoogle` (`internal/session`, `internal/*`-only)
  to additionally return whether it just created a new account, so
  `internal/googleauth`'s callback can append `?new=1` to its success
  redirect — the only signal available once the browser lands back on
  the console with a session cookie already set.
- Exclude `marketing/` (an independent git repo, pushed separately to
  `github.com/tim72117/marketing`, nested in this checkout for
  convenience) from this repo's own tracking.

## v0.2.7

No breaking changes — patch release. Landing page copy only; no code,
API, schema, or CLI behavior changed.

- Rewrite the landing page's hero copy, meta/OG/Twitter descriptions, and
  "Why onagent" feature cards (English and Traditional Chinese) to lead
  with outcomes — "give your product AI in minutes, no LLM agent system to
  build" — instead of implementation details (tool schema generation,
  TypeScript codegen, per-app allowlisting). The three feature cards now
  read as the three real pain points of self-building an agent: no LLM
  infrastructure to build, AI that actually drives the UI, and being ready
  to serve real customers (accounts/keys/quotas) instead of staying a
  single-user demo.
- Update `sitemap.xml`'s `lastmod` for `/` and `/zh-tw/` to reflect the
  content change above.

## v0.2.6

No breaking changes — patch release. Per this project's breaking-change
judgment (`.claude/skills/version-tagging/override.md`), none of this
release's changes are externally visible: the new `agent_experiences` table
and `app_id` column are purely additive (`CREATE TABLE IF NOT EXISTS`,
`ADD COLUMN IF NOT EXISTS`), `newInferenceService`'s new `*gorm.DB`
parameter is an `internal/*`-only signature change, and `onagent version`
is a brand-new CLI subcommand that doesn't touch any existing flag or
default behavior.

- Add a database-backed `sessionstore.Store` implementing want's
  `types.SessionStore` against Postgres, so a WebSocket session's
  conversation history survives a process restart instead of living only
  in the orchestrator's memory. Scoped to `app_id` from the start —
  `Store.ForApp(appID)` returns a store bound to one app, so two apps
  sharing the same `sessionID` never see each other's history, and a
  caller with no valid `SessionID` doesn't leak into a shared history
  either. See `docs/sessionstore-architecture-review-2026-08-14.md` for
  the remaining known gaps (no cleanup/retention mechanism, dangling
  tool_use recovery, sync write latency, write-quota guarding, and three
  upstream `want` proposals).
- Upgrade the `want` dependency to `v0.4.0` — the released tag containing
  the `types.SessionStore` interface and its `SessionStoreErrorMessage`
  event (the previous pin was a pseudo-version pointing at the commit that
  introduced the interface, before it was tagged).
- Add `onagent version` / `onagent --version` / `onagent -v` to the CLI,
  printing a build-time-injected version string (`-X main.version=<tag>`,
  wired into `release-onagent.yml`). Local `go build`/`go run` leaves it at
  the `dev` fallback since there's no tag to derive it from there.
- Audit and clean up `docs/`: removed sections describing already-fixed
  issues (cross-tenant tool leakage, missing panic recovery, per-app
  SessionStore isolation) from `project-audit.md` and
  `project-health-review-2026-07-22.md`; merged
  `known-issues-want-dependency.md` into `improvement-backlog-2026-07-24.md`
  (only remaining item: orchestrator throughput serialization); deleted
  three docs describing already-completed or superseded work
  (`subscription-usage-quota-design.md`, `thought-markdown-editor-design.md`,
  and the user's own removal of
  `secret-sync-without-ai-exposure-2026-07-26.md`); translated
  `security-and-transport.md` to Chinese; condensed
  `third-party-backend-tool-integration-discussion-2026-08-07.md` from a
  432-line transcript to a concept summary (all its concepts remain
  unimplemented); corrected environment variable names and the Secret
  Manager list in `deployment.md`.

## v0.2.5

No breaking changes — patch release. Landing page (`apps/landing`) SEO
fixes only; no `internal/*`, CLI, HTTP/WebSocket API, or database change.

- Add `favicon.svg` and wire `<link rel="icon">` into all five pages
  (index, zh-tw/index, docs, pricing, zh-tw/pricing).
- Add `<link rel="canonical">` to all five pages, each pointing at its own
  canonical URL.
- Add Open Graph (`og:type`, `og:title`, `og:description`, `og:url`,
  `og:locale` on the zh-tw pages) and Twitter Card meta tags to all five
  pages, reusing each page's existing title/description copy.
  `og:image` intentionally omitted — no image asset exists yet to point
  it at.
- Audited `sitemap.xml`/`robots.txt` and confirmed every listed URL
  resolves (200) on the live production site; the local `apps/landing/dist/`
  build artifact was stale (missing the `pricing/` pages) but this never
  affected production, since `deploy-cloudrun.yml`'s Docker build always
  rebuilds `apps/landing` from source rather than using a locally
  committed `dist/`.

## v0.2.4

No breaking changes — patch release. `backend/internal/db.Open` now returns
`*gorm.DB` instead of `*sql.DB`, and every `internal/*` database-access
package's `New()`/`NewRegistry()` constructor now takes `*gorm.DB` instead
of `*sql.DB` (adminauth, auth, cliauth, quota, session, toolschema,
usertoken) — but per this project's breaking-change judgment
(`.claude/skills/version-tagging/override.md`: onagent is an app, not a
library other repos import, and every one of these packages lives under
`internal/`, which Go's compiler already makes unreachable from outside this
module), this doesn't count as breaking — no external caller could ever
have depended on these signatures. No env var, CLI flag, HTTP/WebSocket API
shape, or SDK-facing type changed; the database schema only gained a new
nullable column. Schema management itself is unchanged — still
hand-maintained `internal/db/schema.sql` applied via idempotent
`CREATE`/`ALTER` statements, not GORM `AutoMigrate`. See
`docs/backend-gorm-migration-2026-08-11.md` for the full rationale and
per-package migration approach (regression-test-first: each package's
existing `//go:build integration` test was re-run unmodified after its
rewrite).

Also:
- Add BackendDispatch: a tool can now route its calls to the developer's own
  backend over outbound HTTP (`toolschema.Tool.BackendDispatch`: `Endpoint`,
  `TimeoutMS`) instead of only ever dispatching to the connected browser
  page. New `tools.backend_dispatch` JSONB column. Deliberately minimal PoC
  scope for now: no request signing, no retry, no async/callback mode — see
  `docs/backend-dispatch-integration-guide-2026-08-10.md` for the
  third-party-facing contract and current limitations, and
  `docs/backend-tool-dispatch-design-2026-08-08.md` for the full design this
  was scoped down from.
- Add `LICENSE`: Business Source License 1.1 (converts to Apache 2.0 four
  years after each version's publication).
- Rewrite `README.md` to describe onagent accurately as a third-party
  integration target, with a working Quick Start.
- Add an admin "Schema check" tab comparing GORM struct definitions against
  the live database schema.

## v0.2.3

No breaking changes — patch release.

- Fix `apps/console/package-lock.json` missing a resolved entry for
  `@floating-ui/dom` (transitive dep of `@tiptap/extension-placeholder`,
  added in v0.2.2). `npm install` didn't catch the drift locally since
  `node_modules` already had it from an earlier install; `npm ci` (used by
  the Dockerfile's `console-build` stage) rejected it with `EUSAGE`,
  breaking the public release image build. Verified fixed against the
  actual Dockerfile stage, not just a local rebuild.
- Add `.claude/skills/npm-ci-lockfile-check` documenting this failure mode
  and how to distinguish it from a genuine cross-platform issue.
- Exclude the repo-root `tmp/` scratch directory from git.

## v0.2.2

No breaking changes — patch release. No public Go symbols or exported APIs
removed/renamed/changed; `apps/console` is a standalone app, not a published
package.

- console's Agent thought field is now a Tiptap-based WYSIWYG Markdown
  editor (bold/heading/lists render as you type), replacing the plain
  `<textarea>`. `value`/`onChange` still carry a plain Markdown string —
  storage format and what the LLM reads are unchanged.
- Fix a real data-corruption bug (found via testing before shipping):
  `@tiptap/markdown`'s serializer unconditionally backslash-escaped
  markdown-syntax characters and HTML-entity-encoded `<`, `>`, `&` in every
  plain-text run on every edit, silently corrupting untouched thought
  content (e.g. `user_id` → `user\_id`) since it's persisted verbatim as the
  LLM's raw system prompt. Patched via
  `apps/console/src/tiptapMarkdownEscapeFix.ts`.
- `apps/console` gains real test infrastructure (vitest + jsdom) for the
  first time.
- `release-image.yml` now triggers on tag push (matching
  `deploy-cloudrun.yml`/`release-onagent.yml`) instead of GitHub Release
  publish, which silently never fired since `release-onagent.yml`'s
  release-creation step uses `GITHUB_TOKEN`, and GitHub Actions doesn't
  chain-trigger workflows off `GITHUB_TOKEN`-caused events.
- Three architecture-discussion docs added under `docs/`, exploring
  integration scenarios not yet supported: third-party frontend
  integration, backend-side tool calling, and team-based collaborative app
  editing.

## v0.2.1

- Upgrade want v0.2.0 → v0.3.0: fixes real session-storage data corruption
  (cache aliasing across sessions; a stalled drain-timer bug that could
  permanently stall a session's writes). No changes to the `SetupWith`
  surface onagent depends on.
- Remove the `WantSettings` type (redundant double-translation of
  `want/config.Settings`) in favor of using `*config.Settings` directly.
- Remove the `configs/settings.json` file-config layer and `SETTINGS_FILE`
  env var — confirmed this file was never created, committed, or mounted by
  any real deployment.
- `AI_MOCK_SCENARIO` now actually wired up (previously declared but never
  read); documented in `-h`.
- Add `release-bridge-sdk.yml`: manual-only (`workflow_dispatch`) npm
  publish workflow for `@onagent/bridge`.
- `release-image.yml` now fires on GitHub Release publish instead of a
  `release-v*` tag-push prefix.

## v0.2.0

**Breaking:**
- `github.com/tim72117/want` upgraded v0.1.0 → v0.2.0. want's own
  `Orchestrator.Submit`/`Resume` signatures changed:
  `Submit(userPrompt string) string` → `(string, error)`;
  `Resume(agentID string)` → `error` (new `ErrOrchestratorStopped` after
  `Orchestrator.Stop()`).
- `inference.Service` gained a new method, `CloseSession(sessionID string)`.
  Any external implementation of this interface must add it to keep
  compiling.

Per-session want orchestrators (object-level isolation, not throughput):
`WantService` replaces its single shared `*orchestrator.Orchestrator` (one
mutex serializing every `Complete()` call) with one orchestrator per
SessionID, built lazily and reused across that session's prompts, released
via the new `CloseSession`. want still resolves every LLM provider through
its own process-wide `GlobalEngine`, so this gives per-session
AgentID/Role/Toolbox/history isolation and resource reclamation — not
additional inference throughput.

Also:
- `internal/ws` gets its first tests (`Session.writeMessage` is now a
  replaceable field; `interactionTimeout` is now a var).
- Mount `ADMIN_BOOTSTRAP_EMAIL`/`PASSWORD` in `deploy-cloudrun.yml` — both
  secrets existed in Secret Manager but were never referenced, so the admin
  back-office had no account to log in with on any past deploy.
- Split `deploy-cloudrun.yml` into build and deploy jobs.
- Add `.claude/skills/version-tagging`.

## v0.1.1

Fix a `ServeMux` panic introduced in v0.1.0's CORS refactor: the admin API
sub-mux and the admin SPA's static assets were both registered at the
literal pattern `/admin/`, which Go's `ServeMux` panics on at registration
time. The container panicked before `http.ListenAndServe`, so Cloud Run's
startup probe correctly kept the broken revision off live traffic (no live
impact). Fixed by mounting the admin sub-mux at `/admin/api/` instead. Adds
`TestFullMuxAssembly_DoesNotPanic`, reproducing `main()`'s actual mux-build
sequence end to end.

Also: removed `setup-nightly-sql-shutdown.sh` (the schedule it configured
was cancelled); added `agent_roles_test.go` acceptance test for the want
v0.1.0 upgrade; three research docs (no code changes).

## v0.1.0

want SDK upgrade (v0.0.2 → v0.1.0): adopts want v0.1.0's
`types.ToolProvider` interface, replacing the old append-only,
first-match-wins `types.GlobalRegistry` — closes a cross-tenant tool
leakage bug where one app's LLM could see another app's tools. Tool
declarations now resolve live from `toolschema.Registry` on every call, so
a saved tool edit takes effect on the very next prompt with no restart.

CORS origin allowlist split by audience: `ALLOWED_ORIGINS` used to be
`anyOf`'d across the developer-app allowlist, the console origin, and the
admin origin, so a third-party developer app's origin could ride cookies
meant only for this project's own console/admin frontends. Renamed and
split: `APP_ORIGINS` (developer apps, `/ws` only) vs. `ALLOWED_ORIGIN`
(this project's own console/admin frontends).

**Deployment note:** `deploy-cloudrun.yml`'s env vars had to be updated to
match the rename before/at the next deploy.

## v0.0.8

**Security fix:** `usage_events.app_id` was `ON DELETE CASCADE`, and quota
usage was counted by joining `usage_events` back to `apps` — deleting an app
therefore erased its own billing history, letting any user reset their
monthly quota to zero on demand (self-service, unlimited, free). The usage
ledger now carries its own `owner_id`, denormalized at write time;
`app_id`'s foreign key changed to `ON DELETE SET NULL`. New integration
test (`TestDeletingAnAppKeepsItsUsageLedger`) pins the fix.

Also: new `GET /admin/api/integrity` endpoint and a "Data integrity" panel
in the admin console, listing pass/fail for a small set of checks
(`usage_events_without_owner`, `apps_without_owner`,
`orphaned_usage_events`, `subscriptions_without_user`), built as an
extensible registry.

## v0.0.7

Self-service quota visibility + reliability hardening:
- `GET /console/quota` + console sidebar usage display.
- Panic recovery across `backend/` (top-level HTTP middleware plus explicit
  `recover()` in `ws.Session.handlePrompt` and both ping-loop goroutines) —
  previously any unrecovered panic took the whole process down.
- Fix spurious "context canceled" quota-check warnings on WS handshake.

Also: `Dockerfile.release` + GHCR publish workflow for the public release
image; `@onagent/bridge` gains `defineTool`/`ToolEntry`/`toToolRecord`
(array-based tool registration with typed handlers); landing site pricing
page + mobile nav redesign; docs accuracy pass against actual SDK/CLI/
backend behavior.

## v0.0.6

Landing site SEO groundwork: `sitemap.xml` (with hreflang alternates) and
`robots.txt`; swapped the default language (root now serves English,
Chinese moved to `/zh-tw/`).

## v0.0.5

Fixes a broken production deploy from v0.0.4:
- Startup no longer `os.Exit(1)` when no admin is bootstrapped — it was
  taking down the whole service over a missing admin login.
- Fixed a `CONSOLE_ORIGIN` dead-code bug where the production fail-fast
  guard could never trigger, silently misconfiguring the deployed console's
  Playground origin.
- Finished the atp→onagent rename (CLI bearer token prefix `atp_` →
  `onagent_`).

## v0.0.4

Fix the release workflow so the onagent CLI build actually runs — the
atp→onagent rename had left `release-onagent.yml` referencing the old
`cmd/atp` path, which made the v0.0.3 build fail. Same feature set as
v0.0.3.

## v0.0.3

- Subscription quota system: per-user monthly prompt allowance, plan
  definitions, handshake + per-prompt enforcement, SDK `quota_exceeded`.
- Separate admin back-office (`/admin`): own identity system, env-seeded
  first admin, view user count and set user plans.
- CLI renamed `atp` → `onagent`.
- `/docs/` page fix and console/landing build symmetry.

## v0.0.2

Fix `/docs/` 404: the landing hero links to `/docs/`, but it was never a
Vite build entry, so the built bundle had no `/docs/` page. Also drop
`apps/console`'s custom `outDir` in favor of the default `dist/`, matching
`apps/landing` — local console development now uses the Vite dev server
instead of embedding a local build.

## v0.0.1

Fix Docker build: the `console-build` stage must override `outDir` back to
`dist`.

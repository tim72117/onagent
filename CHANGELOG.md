# Changelog

All notable changes to this project are documented here, one entry per git
tag. Format loosely follows [Keep a Changelog](https://keepachangelog.com/);
versioning follows semver conventions for a pre-1.0 project (see
`.claude/skills/version-tagging`: a breaking change bumps minor, not patch,
until 1.0).

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

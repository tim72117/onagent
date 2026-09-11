# Changelog

All notable changes to this project are documented here, one entry per git
tag. Format loosely follows [Keep a Changelog](https://keepachangelog.com/);
versioning follows semver conventions for a pre-1.0 project (see
`.claude/skills/version-tagging`: a breaking change bumps minor, not patch,
until 1.0).

## v0.5.2

No breaking changes.

- Add `/showcase/` — a React SPA on the landing site with two live
  AgentBridge-integration demos: `/showcase/marketing` (the existing
  analysis widget, moved off the homepage modal onto its own page) and
  `/showcase/support`, a salon-booking assistant with real
  `check_availability`/`get_my_appointments`/`book_appointment` tool
  calls visualized in a phone-framed chat panel over a live weekly
  schedule. `backend/cmd/server/web.go`'s `mountLanding` gains
  SPA-fallback handling for `/showcase/*`, the same pattern
  `mountConsole` already uses for `/app/*`. Added to `public/sitemap.xml`.
  Showcase's plain CSS was since migrated to CSS Modules, and the support
  demo's mobile layout was redesigned (schedule card and chat panel
  stacked vertically instead of side-by-side) with a per-browser
  10-prompt usage cap matching the marketing demo's own.
- Fix `adminconsole`'s `schemaCheck` endpoint reporting the `tools` table
  as "Drifted" (expected `(app_id, name)`, actual `(id)`) — its own
  `toolsFull` reference struct still declared the pre-migration composite
  primary key after `tools.id` became the table's surrogate key.

- `quota.Plan` gains a new admin-only tier, `TierUltra` ("Ultra",
  10,000,000 tokens/month). Assignable only via the admin console's `PUT
  /admin/api/users/{userId}/plan` (behind `withAdmin`) — the
  developer-facing console has no tier-selection surface at all, so this
  introduces no self-service path to it. Appears automatically in `GET
  /admin/api/plans`, which reads the plan table directly rather than
  hardcoding tier names.
- A whole-project audit pass recorded its findings in `docs/audit-
  security.md`, `docs/audit-stability.md`, and `docs/audit-functional.md`
  (six parallel agents across backend core logic, auth/quota/session,
  concurrency, security, the console frontend, and SDK/protocol
  consistency; every high-severity finding re-verified by reading the
  code directly). No code changed as part of this pass — see those files
  for the findings themselves, including an unfixed SSRF via
  `backendDispatch.endpoint`, a quota bypass via an omitted `requestId`,
  and a `BackendDispatch` silent-overwrite bug (the same class of bug as
  the tool `kind` fix in v0.5.0 below, not yet fixed for this field).

## v0.5.0

Fixes:

- Fix a silent data-loss bug: any tool's `kind` (action/query) was dropped
  by the console's frontend `Tool` type and overwritten back to the
  backend's `action` default on every save — including a tool that was
  correctly `query` via the CLI or a hand-written `tool.yaml`. A `query`
  tool's whole purpose is to feed the page's real answer back into the
  model's reasoning (see `toolschema.Tool.Kind`'s doc comment); silently
  downgrading it to `action` made the page's response invisible to the
  model with no error anywhere, discovered via a real Playground
  reproduction where a weather-lookup tool always told the model
  "executed successfully" instead of the actual (even fabricated
  placeholder) data. `apps/console/src/schema.ts`'s `Tool` type now
  carries `kind`, `ToolForm.tsx`/`ToolEditSheet.tsx` expose it as an
  editable "Query tool" field, and `aiToolGenerator.ts`/
  `tool-builder-tools.yaml` round-trip it through AI-generated tools too.
  `backend/internal/toolschema.Tool.BackendDispatch` has the identical
  silent-overwrite exposure and is not yet fixed — see
  `docs/audit-functional.md`'s 2026-09-11 entry.
- Fix `apps/landing/zh-tw/pricing/index.html` missing its Google Tag
  Manager snippet entirely — every other landing page (the English
  pricing page, the Traditional Chinese homepage) had it; this one page
  was never sending analytics.

Playground (console):

- Playground no longer always fails a query tool with no mock effect
  registered — it now fabricates a schema-shaped placeholder value from
  the tool's `returns` schema (clearly labeled "fabricated" in the
  transcript, distinct from a real failure) so a developer can still test
  how the model reasons about a query tool's data without wiring up a
  real page or one of the built-in mock templates.
- Add a persistent, always-visible tool-call timeline above the
  transcript: each tool call becomes an icon (tap to see its full
  arguments/result/error in a bottom sheet), consecutive calls are joined
  by a connector line, and a pulsing dot marks in-flight inference —
  reads left-to-right as the conversation's tool-activity history instead
  of being buried in the transcript's own text lines.
- Add a "Reset context" button: starts a genuinely fresh conversation
  (a brand-new backend session, not just clearing the visible transcript)
  by reconnecting under a new session id instead of the developer's
  usual stable one — old conversation history stays exactly where it was
  under the old session id, untouched.
- Add an account quota gate: Playground now checks the signed-in user's
  quota before opening a connection at all (not just after the backend's
  own handshake-time rejection, which reached the browser as an
  undifferentiated failed-connection error with no explanation) and shows
  an explicit "you've used this month's tokens" notice instead of a bare
  "Disconnected" status. Backed by a new shared `QuotaContext`
  (`apps/console/src/QuotaContext.tsx`) that replaces the one-shot
  `quota` fetch/prop `App.tsx` used to thread through `MobileNav.tsx` to
  `AccountSheet.tsx`/`SettingsView.tsx` — quota now also refreshes after
  every completed turn, not only once at page load.
- Add a collapsible "what is this" help popover and move it (along with
  the connection-status pill and Reset context) into the mobile sheet's
  own close-button row, so a phone user sees them without scrolling.
  `ThoughtEditor.tsx`'s platform-default-prompt popover adopts the same
  pattern, fixing a real bug where its trigger did nothing once the
  Thought field already had text (the popover used to only render while
  the field was still empty). Both popovers share a new
  `usePopoverPlacement.ts` hook that picks which side to open toward
  based on the trigger's position, so neither can render off-screen.

## v0.4.2

Fixes:

- Fix mobile console: creating a tool via `MobileWorkspaceCards.tsx`'s
  "+ New tool" (blank, ToolWizard-built, or AI-generated) looked saved in
  the UI — it appeared in the tools list and the workspace switched to it —
  but silently never reached the backend. Reloading the page, or switching
  apps and back, made it vanish with no error anywhere. `onCreateTool` used
  to be wired to `App.tsx`'s local-state-only `appendTool`; it's now wired
  to the same append to persist immediately as `addToolFromWizard` (both
  now share one `appendTool(tool, persist)` helper — see Internal below).
- The AI tool generator ("Generate with AI") used to wait out its full 30s
  timeout and report a generic timeout error whenever the model responded
  with plain text instead of calling `propose_tool` (e.g. asking a
  clarifying question because the description was too vague). It now
  surfaces that text immediately below the input so the developer can see
  why nothing was proposed and try a clearer description.

UX:

- The four field-editor sheets nested inside a tool's edit sheet
  (`ToolNameSheet`, `ToolDescriptionSheet`, `ToolParametersSheet`,
  `ToolReturnsSheet`) relabel their save button from "Save" to "Done" — it
  only ever wrote the field back into the parent `ToolEditSheet`'s own
  local draft, not to the backend; "Save" was misleading about what tapping
  it actually did. The parent sheet's own header button (the one that does
  reach the backend) is unchanged.

Internal:

- Extract the WebSocket handshake/dispatch logic `Playground.tsx` and
  `aiToolGenerator.ts` had each implemented separately into a shared
  `apps/console/src/playgroundProtocol.ts` module. The two callers still
  each own their connection's lifecycle (`Playground.tsx` keeps one stable,
  reconnect-persistent connection per app; `aiToolGenerator.ts` opens and
  closes a fresh one per "Generate" click) — `playgroundProtocol.ts` is
  deliberately agnostic to that difference.
- `backend/internal/console/playground.go`: the tool-builder app now gets a
  random suffix appended to its session id on every connection
  (`PG-<userID>-tool-builder-<hex>`, via a new `randomSuffix()` helper),
  instead of the stable `PG-<userID>-<appID>` every other Playground
  session gets. Each "Generate" click is meant to be an independent,
  stateless request; without this, every past attempt's turns accumulated
  into one ever-growing conversation, wasting tokens and risking
  accumulated context nudging the model away from tool-builder's own
  instruction to always call `propose_tool`.
- `aiToolGenerator.ts`'s exported `generateToolFromDescription` now returns
  `Promise<GenerateResult>` (`{kind:'tool',tool}` or
  `{kind:'message',text}`) instead of `Promise<Tool>`, to carry the
  plain-text-reply case above. Its only caller, `AiToolGeneratorSheet.tsx`,
  is updated in the same change; this module isn't consumed outside
  `apps/console`.
- Merge `docs/known-issues-pending-discussion.md` into `docs/audit-
  functional.md` (its two confirmed, tracked findings) and a new
  `docs/notes-product-ideas.md` (its two open, undecided proposals); delete
  the original file and fix the resulting stale links in
  `backend/internal/db/schema_integration_test.go`,
  `backend/internal/quota/quota.go`, and
  `backend/internal/quota/quota_integration_test.go`.

## v0.4.1

Breaking changes:

- `tools.id BIGSERIAL` is now the table's primary key; `(app_id, name)`
  is downgraded to a `UNIQUE` constraint (existing rows are backfilled
  automatically). `toolschema.Registry.SaveTool(appID string, tool Tool)
  error` is now `SaveTool(appID string, tool Tool) (id int64, err error)`
  — every caller must handle the new return value. `Registry.Create
  (appID string, ownerID int64) error` gains a required third parameter,
  `public bool` (pass `false` for the previous behavior). A new method,
  `Registry.DeleteToolByID(appID string, id int64) error`, is added
  alongside the existing name-based `DeleteTool`.
- Console REST: `PUT /console/apps/{appId}/tools/{toolName}` now returns
  `{..., "toolId": number}` in addition to the existing `appSummary`
  fields (additive, not itself breaking for a JSON consumer) — but the
  matching `PUT`/`DELETE /console/apps/{appId}/tools/id/{toolId}` routes
  are new, and a tool's rename must go through them once the tool has a
  `toolId` (see "Why" below); repeatedly calling the name-based route to
  edit an existing tool no longer renames it in place. `POST
  /console/apps` accepts an optional `"public": boolean` field (defaults
  to `false`, matching the schema's existing default — no behavior change
  for an existing caller that omits it).
- `onagent app create` gains `-public`; `apiClient.createApp(appID
  string)` is now `createApp(appID string, public bool)`.

Why: renaming a tool used to mean deleting the row under its old
`(app_id, name)` key and inserting a new one under the new name — the
only two operations a name-only primary key allows. If the insert failed
after the delete had already committed (a network blip, a validation
error on the new name), the tool vanished from the app entirely, under
neither its old nor new name, with no trace. `tools.id` gives
`Registry.SaveTool` an identity to update in place: `UPDATE tools SET
name = ?, ... WHERE id = ?` changes the name atomically, with no window
where the tool doesn't exist. The console editor picks up a tool's id
from its first save's response and uses the new id-based routes for
every subsequent edit; the CLI's `tool create` (a hand-authored
`tool.yaml` has no id to give) keeps using the name-based route, which
still upserts by name exactly as before — this only changes what happens
when the console (not the CLI) edits an existing tool's name.

Other fixes:

- Fix the console editor's tool-save autosave silently dropping edits
  made just before switching to another view. It used to save 1.2s after
  the last keystroke; if a switch to a different sub-view (Thought,
  Playground, another tool) landed inside that window, the switch's own
  re-fetch overwrote local state with the server's still-stale copy
  before the pending timer ever fired — no error, no indication anything
  was lost. Tool edits now save only on an explicit Save action (both the
  desktop `ToolForm` and the mobile `ToolEditSheet` already had, or now
  have, their own Save button/gesture), and switching views while a tool
  has unsaved edits now asks for confirmation before discarding them.
- `backend/internal/console/tool-builder-tools.yaml`: brought back in
  sync with the `thought` actually live on the local dev deployment,
  which had drifted ahead of the checked-in copy (a prior direct edit,
  never written back to the repo) — restores prompt guidance that had
  been lost from this file: parameters/returns objects must always
  include an explicit `"type"` even with zero properties, every JSON
  Schema `"type"` value must be lowercase, and a fixed-choice string
  parameter should use `"enum"` rather than prose description.
- `docs/ai-tool-builder-design-2026-09-09.md` is removed — its content
  (the AI tool builder's design) is now fully superseded by the actual
  implementation (`aiToolGenerator.ts`, `AiToolGeneratorSheet.tsx`,
  `tool-builder-tools.yaml`) and its own doc comments; stale references
  to this file in `aiToolGenerator.ts`, `AiToolGeneratorSheet.tsx`, and
  `docs/known-issues-pending-discussion.md` were updated to point at the
  actual source files instead.
- `docs/known-issues-pending-discussion.md`: records two confirmed,
  not-yet-fixed issues found while working on this release — `onagent
  tool list`'s output (a full `App`: `appId`/`tools[]`/`thought`) cannot
  actually be piped into `onagent tool create` (which reads a single
  `Tool`, no wrapper) despite both commands' own doc comments claiming a
  round trip works; and `aiToolGenerator.ts` hand-rolls its own WebSocket
  protocol handling (hello/ack/prompt/tool_call/tool_result) instead of
  reusing `Playground.tsx`'s already-working implementation, which is
  judged to be the root cause that let the `tool_call`/`tool_query`
  mismatch bug (fixed in v0.4.0) go unnoticed until it shipped.

## v0.4.0

Breaking changes:

- `quota.Plan.MonthlyPrompts` (an int counting prompts per period) is
  replaced by `quota.Plan.MonthlyTokens` (an int counting LLM tokens per
  period, summed from `usage_events.total_tokens`) — the field was
  renamed, not just its meaning changed, so any code referencing
  `MonthlyPrompts` fails to compile. `subscriptions.monthly_quota` (the
  per-user override column) keeps its existing name and type but is now
  interpreted as a token count instead of a prompt count.
- `inference.NewWant`'s signature gains a required fourth parameter,
  `quotaSvc *quota.Service` — any existing caller passing three arguments
  fails to compile. Pass `nil` to disable in-`Complete` usage recording
  (matching a nil `quota.Service`'s existing no-op behavior elsewhere).
- `quota.Service.Record` no longer deduplicates by `(app_id, event_id)` —
  the `ON CONFLICT DO NOTHING` it used to run is gone. A caller that
  relied on retrying the same `RequestID` being a safe no-op will now
  insert (and get summed into quota) a second row instead. This is
  deliberate: `WantService.Complete` now records one row per provider
  round-trip within a single prompt, all sharing that prompt's
  `RequestID`, and those rows must all count — see `quota.Record`'s doc
  comment.
- `quota.UserSummary.Used` (admin API JSON field `used`) keeps its name
  and type but changes meaning: it used to be a `COUNT(*)` of billable
  prompts in the current period, and is now a `SUM(usage_events.
  total_tokens)`. Any consumer that displayed this number as-is now shows
  a token count instead of a prompt count, silently.
- `quota.Service.Check(ctx context.Context, appID string)` is now
  `Check(ctx context.Context, userID int64)` — it no longer resolves a
  standing from the app's owner, but takes the billable user directly.
  Every caller (`ws.APIKeyResolver.ResolveApp`, `ws.Session.
  handlePrompt`, `console.playgroundResolver.ResolveApp`) was updated to
  pass the same userID it bills to `Record` — see "Other fixes" below for
  why this mattered.
- `apps.allowed_origin TEXT` (single origin) is replaced by
  `apps.allowed_origins TEXT[]` (multiple origins); existing rows are
  migrated automatically and the old column dropped. Follows through the
  whole stack: `auth.Store.SetOrigin(appID, origin string)` →
  `SetOrigins(appID string, origins []string)`, `auth.Store.OriginFor` →
  `OriginsFor` (returns `[]string`), `auth.VerifyResult.AllowedOrigin
  string` → `AllowedOrigins []string`. Console REST: `PUT /console/apps/
  {appId}/origin` request body `{"origin": string}` → `{"origins":
  [string, ...]}`; the `appSummary` response's `allowedOrigin string` →
  `allowedOrigins []string`. `onagent` CLI: `set-origin` renamed to `app
  origin set` (still takes one origin on the command line, sent as a
  one-element array).
- `apps.owner_id` is now `NOT NULL` (existing NULL-owner rows are
  backfilled to a fixed user id by the migration) — any code path that
  wrote an `apps` row without an owner now fails at the database level
  instead of silently creating an orphaned app. `onagent save-tools` (the
  old command; see the CLI rename below) could previously do this; its
  replacement always requires an existing, owned app.
- `ws.AppResolver.ResolveApp`'s return signature gains a `userID int64`
  (inserted between `sessionID` and `ok`) — both implementations
  (`ws.APIKeyResolver`, `console.playgroundResolver`) and `ws.NewSession`
  (new 8th parameter, `userID int64`) were updated; any other
  implementation of this interface fails to compile.
- `toolschema.Registry.Save(app *App) error` (replace an app's entire
  tool set in one call) is removed, replaced by `Registry.SaveTool(appID
  string, tool Tool) error` (upsert one tool by name, leaving the app's
  other tools untouched) and `Registry.DeleteTool(appID, name string)
  error`. Console REST: `PUT /console/apps/{appId}/tools` (replace the
  whole array) is removed, replaced by `PUT /console/apps/{appId}/tools/
  {toolName}` (upsert one tool; the body's `name` must match the URL) and
  `DELETE /console/apps/{appId}/tools/{toolName}`.
- `onagent` CLI's command tree is restructured into `<resource> <verb>`
  form; every old command name is removed outright (running it prints
  usage and exits non-zero, it does not alias to the new name):
  `list-apps`→`app list`, `create-app`→`app create`,
  `set-origin`→`app origin set`, `set-thought`→`app thought set`,
  `issue-key`→`key issue`, `get-tools`→`tool list`. `save-tools`→`tool
  create` is also a semantic change, not just a rename: the old command
  read a whole-app YAML file (`appId`/`thought`/`tools[]`) and replaced
  every tool on the app; the new command reads a single tool's YAML file
  and upserts just that one tool. New commands with no old equivalent:
  `app delete`, `key revoke`, `tool delete`.
- Console REST handlers now decode request bodies with
  `DisallowUnknownFields()` — an unrecognized JSON field used to be
  silently ignored and is now rejected with `400 Bad Request`. Applies to
  every endpoint that takes a body (`register`, `login`, `createApp`,
  `setOrigin`, `setThought`, the new `saveTool`/`deleteTool`,
  `issueToken`, `startCliAuth`).

Also new in this release, not breaking: `toolschema.App.Public` /
`apps.public` (new column, default `false`) lets an app's owner mark it
public, so any signed-in user can try it from the console's Playground
(`console.ownedOrPublicApp`) — REST management endpoints (edit/delete/
key/origin) remain owner-only regardless of this flag. And the
AI-assisted tool builder feature itself (`AiToolGeneratorSheet.tsx`,
`aiToolGenerator.ts`, `backend/internal/console/tool-builder-tools.yaml`)
— see "Other fixes" below for the bug that shipped with it.

Why the quota model changed: prompt count was a poor proxy for actual LLM
cost once a single prompt could trigger a variable number of internal
provider round-trips (tool-calling loops), each with very different token
weight. The free tier's allowance is now 100,000 tokens/month (`quota.
plan.go`), enforced and displayed via the same `usageSince` SUM query
everywhere (quota checks, the console's own usage display, and the admin
user list) so there is exactly one place that number can drift out of
sync.

Fixes a real bug found while building this: a prompt's token usage used
to be recorded exactly once, after `WantService.Complete` returned
successfully. A prompt that triggered a tool-calling round trip could
have its usage silently lost — real, billable tokens the LLM had already
produced — whenever the caller's WebSocket connection closed while
`ws.Session.AskInteraction` was still waiting on a `tool_result` (this
cancels `ctx`, making `Complete` return an error instead of a `Result`,
so the one recording call site was never reached). Usage is now recorded
inside `Complete` itself, the instant each round-trip's usage event
arrives, using a `context.Background()` write that isn't tied to the
caller's connection lifetime — so tokens already spent are never lost to
a subsequently-cancelled turn.

Other fixes:

- Fix a real bug in the AI-assisted tool builder feature ("Generate with
  AI" in the mobile console): `aiToolGenerator.ts` only listened for a
  `tool_query` WebSocket message, but its one tool (`propose_tool`) is
  fire-and-forget — its acknowledgement is never reasoned about further,
  so it's correctly declared `kind: action`, not `query` — meaning the
  backend actually sends `TypeToolCall` ("tool_call"), never
  `TypeToolQuery`. The frontend never saw the message and always timed
  out after 30s, even when the LLM successfully proposed a tool. Fixed to
  listen for `tool_call`, matching what `protocol/message.go` actually
  sends for an action-kind tool; also corrected
  `backend/internal/console/tool-builder-tools.yaml`, which had
  documented the wrong `kind: query` and was the source of the mistaken
  assumption in the first place.
- Fix `quota.Service.Check` checking the wrong user (see the breaking
  `Check` signature change above): for a Public app, a visitor was gated
  against the **app owner's** standing instead of their own — meaning a
  visitor could exhaust their own quota and keep using any Public app for
  free (nobody was checking them), while the owner could be wrongly
  blocked by usage that wasn't theirs.
- Fix a real bug in `onagent` CLI's `set-origin` command: it sent
  `{"origin": "<value>"}` (a singular string field) to the backend, but
  `console.go`'s handler only reads `{"origins": [...]}` (a plural array
  field) — Go's JSON decoder silently ignores unknown fields, so the
  request always decoded to an empty `origins` list. The backend then
  genuinely updated the row (clearing `allowed_origins` to empty), so
  `RowsAffected == 1` and the CLI printed a false "success" message while
  actually wiping out the app's allowed origin instead of setting it.
- The `tool-builder` platform-internal app's tool definition is checked
  into the repo as `backend/internal/console/tool-builder-tools.yaml`
  (previously only pushed ad hoc via `onagent save-tools`, with no
  version-controlled source).
- Console: the "Generate with AI" tool-creation flow's UI text is now in
  English (previously Traditional Chinese), matching the rest of the
  console's UI language.
- Console: the account/settings usage display now shows only the
  backend-computed usage percentage (`quota.usedPercent`, e.g. "33% used
  this month") instead of a raw token count against the plan limit —
  intentionally not surfacing the specific token allowance number in this
  UI.
- Admin console: removed the "Tokens (this period)" column, which
  duplicated the adjacent "Usage (this period)" column once both derived
  from the same token-sum figure; the remaining usage column now formats
  large numbers with thousands separators.
- Landing pages (English and Traditional Chinese): pricing copy no longer
  states a specific prompt-count allowance for the Free plan (stale after
  the token-based quota change), replaced with "a small monthly usage
  allowance for testing."
- `docs/ai-tool-builder-design-2026-09-09.md`: corrected its own
  `propose_tool` YAML example (`kind: query` → `kind: action`) and
  runtime notes, which had documented the wrong assumption that caused
  the `tool_call`/`tool_query` bug above in the first place; the app's
  own per-user provisioning ("Ownership"/"Hiding it from the normal app
  list") remains un-implemented, and provisioning `tool-builder` itself
  is still a manual step (no code loads its YAML file automatically).
- `apps/landing/docs/index.html` (and its Traditional Chinese landing
  page's terminal demo): every CLI command reference updated to the new
  `onagent app|key|tool <verb>` command tree (see the CLI breaking change
  above) — `list-apps`→`app list`, `create-app`→`app create`,
  `set-origin`→`app origin set`, `set-thought`→`app thought set`,
  `issue-key`→`key issue`, and the `save-tools`/`get-tools` sections
  rewritten for the new single-tool-per-file semantics (`tool create`/
  `tool list`), including new `app delete`/`key revoke`/`tool delete`
  rows in the command reference table. This page was the primary
  external-facing integration guide and had not been updated when the
  CLI command tree changed.
- `docs/backend-dispatch-integration-guide-2026-08-10.md`,
  `docs/deployment.md`, `docs/known-issues-pending-discussion.md`:
  updated stale `save-tools`/`issue-key` command references and YAML
  examples to match the new CLI command tree and single-tool file shape.

## v0.3.5

No breaking changes — patch release. Desktop console layout changes; no
programmatic interface affected (`Sidebar`/`DesktopAppBar` are internal to
`apps/console`, not exported for reuse).

- **Desktop app switching moved from the sidebar into a dropdown above the
  workspace** (`DesktopAppBar.tsx`, new) — mirrors `MobileTopBar.tsx`'s
  "current app name + chevron" trigger, opening a dismissible popover
  (click-outside/Escape to close) instead of a bottom sheet. Renders the
  same `AppList.tsx` the sidebar used to render directly, so row markup/
  status dots/the "+ New app" button are unchanged; only the surrounding
  chrome differs. `Sidebar.tsx` no longer renders `AppList` itself.
- **YAML preview split out of the tool editor into its own workspace view**
  — `PreviewPanel.tsx` used to render permanently in the tool editor's
  right-hand pane; it's now reached via a new "YAML" item in the sidebar
  (next to "Settings", desktop-only for now — see `View`'s new `'preview'`
  kind) and takes over the full workspace width when open. The tool
  editor, Agent Thought, and Playground panes are single-column now that
  nothing needs the second column; the two-column
  `.workspaceBody`/`.editorPane` grid and its `<1100px` collapse rule were
  removed as dead weight (`App.module.css`).
- **Sidebar nav items gained icons** — Thought, Playground, Settings
  (renamed from "App settings"), YAML, and each tool row now show a small
  line icon before their label (`AgentNav.tsx`, `Sidebar.tsx`,
  `ToolList.tsx`, via new shared `.itemMain`/`.itemIcon` classes in
  `SidebarNav.module.css`). Tool rows all share one generic wrench icon for
  now — the frontend `Tool` type still has no `kind` field to distinguish
  action vs. query tools with different icons (tracked in
  `docs/audit-functional.md`).
- **`workspaceHeader` (the "Unsaved changes" badge / validation-error
  strip above the tool editor) no longer reserves space when it has
  nothing to show** — previously always rendered with its full padding
  even when empty, which read as a stray blank band once `DesktopAppBar`
  was added above it as a second top row.
- Fixed a stale `@media (max-width: 1100px)` rule in `style.css` for
  `.thought-textarea`'s mobile min-height: its justifying comment
  referenced the two-column `.editorPane`/`.workspaceBody` grid removed by
  this same release, and 1100px no longer corresponded to any real layout
  transition. Now keyed off 860px (the console's actual mobile
  breakpoint), matching where `.thought-textarea` (shared by the desktop
  Agent Thought editor and the mobile `ThoughtEditSheet`'s loading
  skeleton) actually needs a viewport-relative height floor.
- New `--space-1` through `--space-8` spacing tokens (`style.css`, 4px
  steps) — formalizes the 16px/14px-16px/24px values already most common
  across `*.module.css`; only newly-touched files (`PlaygroundSheet`,
  `AppSettingsView`, `DesktopAppBar`, `SidebarNav`) adopt them so far, not
  a full sweep.
- Fixed `PlaygroundSheet.module.css`'s mobile Playground view running its
  status badge, hint copy, transcript, and message input flush to the
  screen edges — its `.body` had no left/right padding of its own
  (desktop's equivalent gets it from `App.module.css`'s `.editorPane`);
  added `--space-4` padding plus the existing `--safe-bottom` inset
  (stacked additively, not replaced).
- Centered `AppSettingsView.module.css` on desktop (`margin: 0 auto`,
  matching the tool editor/Playground/YAML views' single-column
  centering) — it previously hugged the workspace's left edge under the
  new `DesktopAppBar` row.
- Performance: `DesktopAppBar` wrapped in `React.memo`, and `selectApp`/
  `addApp`/`withDiscardConfirm` (`App.tsx`) wrapped in `useCallback`, so
  the app-picker no longer re-renders on every unrelated keystroke
  elsewhere in the console (tool/Thought/origin edits). `refreshDraftForSwitch`
  now fetches the switched-to app and refreshes the sidebar's app-summary
  list concurrently (`Promise.all`) instead of sequentially, since neither
  depends on the other.

## v0.3.4

No breaking changes — patch release. Follow-up fixes to the mobile
console layout added in v0.3.0.

- Fix a real bug: `ThoughtEditSheet`/`ToolEditSheet` could render
  obscured by the fixed `MobileTopBar`/`MobileBottomBar` instead of
  covering the full screen. Both live inside
  `MobileWorkspaceCards.module.css`'s `.root`, which sets
  `-webkit-overflow-scrolling: touch` for its own momentum scrolling — a
  long-standing WebKit/iOS Safari quirk traps a `position: fixed`
  descendant of such a container as if positioned relative to that
  scrolling ancestor instead of the real viewport. `PlaygroundSheet`
  never hit this only because its parent (`MobileNav.tsx`) doesn't use
  that property, not because `BottomSheet.tsx` itself was fine.
  `BottomSheet.tsx` now portals every sheet to `document.body`, so this
  can't recur regardless of which caller's DOM subtree declares it.
- Fix a related real bug the portal fix above exposed: tapping a row in
  `ToolEditSheet.tsx` (Name/Description/Parameters/Returns) could open
  the corresponding field sheet underneath, not on top of, the row list
  — its fields were real and fillable (programmatically), but invisible
  and untappable, reading as "the fields don't respond." Every
  `BottomSheet` shares the same fixed z-index (30/31) and is portaled to
  `document.body`; `ToolEditSheet` nests four more always-mounted
  `BottomSheet`s as children (`ToolNameSheet`/`ToolDescriptionSheet`/
  `ToolParametersSheet`/`ToolReturnsSheet`), and with identical z-index
  across all of them, which one visually won was decided by portal
  commit order among `document.body`'s children — not guaranteed to
  track actual nesting. Added `SheetDepthContext` so each `BottomSheet`
  knows how many `BottomSheet` ancestors it has and computes a z-index
  strictly above its parent's, regardless of portal/commit order.
- `BottomSheet.tsx` now locks `document.body` scroll while any sheet is
  open — without it, a touch-scroll gesture that ran out of room inside
  a sheet's own content fell through to the page underneath, scrolling
  the fixed top/bottom bars along with it.
- `ThoughtEditSheet.module.css`'s `.body` was `overflow: hidden` instead
  of `overflow-y: auto`, silently clipping content that ran past the
  visible area instead of letting it scroll.
- `ToolNameSheet`/`ToolDescriptionSheet`/`OriginEditSheet` switched from
  `autoFocus` to a ref+effect gated on `open` — `BottomSheet` keeps every
  sheet always-mounted for its close transition, so `autoFocus` (which
  fires at mount time) was popping the mobile keyboard the moment the
  *parent* sheet mounted, well before the user actually opened that
  specific field.
- `App.tsx` now auto-selects the first app once the list loads and none
  is selected yet, mirroring `selectAppSettings`'s own existing fallback
  — mobile's landing screen is the workspace itself (not a `Sidebar` list
  to click), so with no app selected it dead-ended on "No app selected"
  until the user manually opened the app picker.
- `AppSettingsList.tsx`'s mobile header no longer embeds the app name
  next to the back arrow ("App settings" instead of `"<appId>" settings`).
- `ToolWizard.tsx`'s mobile view no longer shows a "Cancel" button in its
  footer — mobile already has `SheetHeader`'s ✕ close button, making
  Cancel a second, redundant way to back out.
- `apps/console/index.html`'s viewport meta now disables pinch/double-tap
  zoom (`maximum-scale=1.0, user-scalable=no`).
- `ToolEditSheet.tsx`'s Name/Description/Parameters/Returns row sheets
  each used to save straight back into `draft.tools` the moment their own
  Save was pressed, autosaving after every single field instead of once
  per editing session. `ToolEditSheet` now holds its own local draft;
  each row sheet's Save only updates that, and `ToolEditSheet` gained its
  own header Save that's the one point committing everything at once.
- "+ New tool" no longer appends an empty tool to `draft.tools`
  immediately — it stays local to `ToolEditSheet` (a dedicated `isNew`
  instance) until its own Save actually adds it, so it can't show up
  mid-creation in the Tools list, and Delete is hidden entirely (nothing
  yet exists to delete). Closing it with unsaved edits now asks to
  discard, via a new `App.tsx` `confirmDiscard` helper reusing the
  existing shared `ConfirmModal`.
- A tool's name can no longer be saved empty. It's the tool's actual
  identifier (the LLM calls it by this string) and half of the backend's
  `app_id`+`name` primary key, not just a display label — `ToolNameSheet`
  and `ToolEditSheet`'s own Save both now block on `TOOL_NAME_RE`, not
  just "changed from the original." Previously, clearing the name and
  tapping Save appeared to succeed (the sheet closed) while `App.tsx`'s
  autosave silently refused to persist it, leaving the tool permanently
  stuck dirty with nothing explaining why.
- Fix a real bug: a long tool description (or allowed-origin URL) forced
  its row wider than the screen instead of truncating with an ellipsis,
  which — combined with `overflow-y: auto` implicitly forcing
  `overflow-x` to `auto` too — made the whole row list horizontally
  scrollable, so every row (including ones with short text, like "Delete
  tool") could appear shifted/clipped depending on scroll position. The
  row's label+value wrapper needed `min-width: 0` for its `white-space:
  nowrap`/`text-overflow: ellipsis` to actually take effect, instead of
  forcing the flex item wider to fit the unwrapped text
  (`ToolEditSheet.module.css`, `AppSettingsList.module.css`).
- Fix the on-screen keyboard covering the focused field instead of the
  sheet scrolling to reveal it. `apps/console/index.html`'s viewport
  meta gained `interactive-widget=resizes-content`, so the browser
  shrinks the layout viewport (and with it, every fullscreen
  `position: fixed` `BottomSheet`) around the keyboard instead of leaving
  it full-height with the keyboard just overlaid on top. A new
  `focusField.ts` helper additionally scrolls the focused input into view
  once `visualViewport`'s `resize` event confirms the keyboard has
  actually finished opening (`ToolNameSheet`/`ToolDescriptionSheet`/
  `OriginEditSheet`).

## v0.3.3

No breaking changes — patch release.

- Fix `onagent` CLI: `-console` (used by `login --web` to pick which
  origin to open in the browser) now defaults to whatever `-api` resolved
  to, instead of always defaulting to the deployed production console
  regardless of `-api`. Previously, `onagent login --web -api
  http://localhost:8081` silently opened the real
  `https://onagent.shuttle.tools` console instead of the local one — a
  confusing failure mode since nothing indicated why login appeared to
  work against the wrong environment. `-console <url>` still overrides
  explicitly when the console front-end truly lives somewhere other than
  `-api`'s origin. Updated `packages/claude-skill/skill/SKILL.md`'s
  onagent-cli-setup skill to describe the new default-inheritance
  behavior.
- Fix admin console's "Schema check" page permanently reporting the
  `tools` table as drifted in production: its reference struct
  (`toolsFull` in `backend/internal/adminconsole/schema_check.go`) was
  never updated when `source_template` was added to the `tools` table
  (v0.3.0's ToolWizard work), so the live database's real column looked
  like an undeclared "extra column" to the checker. No database change —
  the column already existed; only the check's own reference struct was
  out of date.
- Add favicon fallbacks (`favicon.ico`, `favicon-32x32.png`,
  `apple-touch-icon.png`) alongside the existing SVG favicon across all
  landing pages, since some crawlers and surfaces (e.g. search-result
  favicon display) don't reliably resolve an SVG-only `<link rel="icon">`.

## v0.3.2

No breaking changes — patch release. Follow-up fix to the mobile console
layout added in v0.3.0.

- Fix a real regression: `ToolWizard.tsx` (the guided "Build one step by
  step" tool-creation flow) rendered permanently visible on desktop with
  no way to close it. v0.3.0 made this component always-mounted (so its
  mobile full-screen-sheet variant can animate closed instead of just
  unmounting), gating desktop visibility with a scoped `.overlay
  {display:none}` / `.overlayOpen {display:flex}` pair composed onto the
  same element as the shared global `.modal-overlay {display:flex}` class
  (`KeyModal`/`AddAppModal`/`ConfirmModal` all reuse that same class for
  their own centered-dialog look). Both rules have identical specificity
  (one class selector each), so which one won was decided entirely by
  Vite's CSS chunk ordering, not by `open`'s value — that ordering placed
  `.modal-overlay`'s `display:flex` last, so the wizard was visible from
  the moment the app loaded regardless of state. `.overlay`/`.panel` no
  longer share the global `.modal-overlay`/`.modal` classes at all — they
  now fully duplicate the handful of declarations those provided, so
  there's no competing global rule left for chunk order to accidentally
  favor.

## v0.3.1

No breaking changes — patch release. Follow-up fixes to the mobile
console layout added in v0.3.0.

- Fix a real crash: switching apps could throw
  `TypeError: null is not an object (evaluating
  'this.commandManager.commands')` deep inside Tiptap and unmount the
  entire React tree (`#root` going blank). `ThoughtEditor.tsx`'s
  content-sync effect updates the Tiptap editor whenever its `value` prop
  changes; switching apps updates that value around the same time this
  component can be unmounting/remounting (the mobile/desktop branch swap,
  or `ThoughtEditSheet` closing), and if the effect ran after
  `@tiptap/react`'s own cleanup had already called `editor.destroy()` on
  that instance, calling `.commands.setContent()` on it threw — `destroy()`
  nulls out the editor's internal `commandManager` but the `editor`
  reference itself stays truthy, so the effect's existing `!editor` guard
  didn't catch it. Now also checks `editor.isDestroyed`.
- `AppPickerSheet.tsx`'s app list rows were sized for a dense,
  mouse-driven desktop sidebar (`padding: 6px 8px`, `font-size: 13px` —
  under a real touch target) despite being this app's sole touch entry
  point for switching apps on mobile. `AppList.tsx` gained an optional
  `rowClassName` prop so this sheet can size up its own rows without
  affecting the shared component's desktop-sidebar/`AgentNav`/`ToolList`
  callers.
- `MobileWorkspaceCards.module.css`'s Agent Thought summary card gained a
  bit more bottom padding around its (line-clamped) preview text so a
  full two lines doesn't read as crowding the card's bottom edge.

## v0.3.0

Breaking change — minor bump. Console (`apps/console`) gains a full mobile
layout for the first time; the only user-visible removal is the PreviewPanel
JSON/TypeScript preview tabs (see below). No breaking changes to any
programmatic interface (no other package or test imports the removed
`codegen.ts` exports or the changed `Sidebar`/`ThoughtEditor` component
props).

- **New mobile layout end-to-end** — this console had no mobile-specific
  interaction layer before. Adds a fixed top bar (app picker + account
  avatar, `MobileTopBar.tsx`) and bottom bar (Playground entry,
  `MobileBottomBar.tsx`), a card-stack workspace (`MobileWorkspaceCards.tsx`,
  Agent Thought + Tools as tappable summary cards instead of the desktop's
  sidebar-driven navigation), and a full-screen bottom-sheet component
  family for every edit surface: `BottomSheet.tsx`/`SheetHeader.tsx` (the
  shared shell) plus `AccountSheet`, `AppPickerSheet`, `KeyEditSheet`,
  `OriginEditSheet`, `ThoughtEditSheet`, `ToolEditSheet` (itself a
  settings-style list opening `ToolNameSheet`/`ToolDescriptionSheet`/
  `ToolParametersSheet`/`ToolReturnsSheet`), and `PlaygroundSheet`. Editing
  sheets disable backdrop-tap-to-close so a stray tap can't discard an
  in-progress edit. `ToolWizard.tsx` (the guided tool-creation flow) is
  full-screen on mobile and a centered dialog on desktop from one shared
  DOM structure, CSS-only.
- **Account Settings and per-app settings split into two distinct concepts**
  — previously conflated. Account-level plan/usage/sign-out now lives in
  `SettingsView.tsx` (desktop) reached via the sidebar avatar; per-app
  key/origin/delete now has its own nav entry, rendered as a flat form on
  desktop (`AppSettingsView.tsx`) and a native-list-style screen with edit
  sheets on mobile (`AppSettingsList.tsx`).
- **Removed the PreviewPanel "LLM tool JSON" and "TypeScript" preview
  tabs** — `PreviewPanel.tsx` now shows YAML only. These let a developer
  copy the generated JSON-schema or TypeScript-types shape for a tool
  straight from the console UI; that capability is gone. `codegen.ts`'s
  corresponding `toLLMTools`/`toLLMToolsJSON`/`LLMTool`/`toTypeScript`/
  `writeInterface`/`tsType`/`pascalCase` were removed as dead code once
  nothing called them.
- **Workspace autosave replaces the manual Save button** — tool edits
  (`draft.tools`) now save 1.2s after the last edit instead of requiring an
  explicit click; the workspace header shows only an "Unsaved changes" /
  "Saving…" badge now (app name, tool count, and the key-issued badge were
  also dropped from that header as visual clutter once Save's button moved
  out).
- **Desktop `Sidebar.tsx` split into focused sub-components** — `AppList`,
  `AgentNav`, `ToolList`, `SidebarFooter`, sharing `SidebarNav.module.css`;
  `Sidebar.tsx` itself is now an assembly shell. `SidebarFooter`'s avatar
  now correctly pins to the bottom of the viewport (a `height` chain gap
  through `AppShell`'s new sidebar grid column previously left it sitting
  right under whatever content was above it instead).
- **`ThoughtEditor.tsx` reduced to just its editor content** — no longer
  renders its own `<form>`/header/Save button (removed `busy`/`dirty`/
  `onSave` props); callers (`App.tsx` desktop, `ThoughtEditSheet.tsx`
  mobile) now each wrap it with their own header/Save, which was needed to
  stop a nested `<form>` (invalid HTML) once the mobile sheet needed its
  own submit handling.
- **`App.tsx`'s five independent view booleans merged into one
  discriminated union** (`activeToolIndex`/`agentSelected`/
  `playgroundSelected`/`settingsSelected`/`appSettingsSelected` → a single
  `View` state) — those were mutually exclusive by hand-discipline only,
  with every view-switching function responsible for clearing the other
  four; a new `VIEW_HAS_MOBILE_ENTRY_POINT` exhaustive lookup table (keyed
  by `View`'s own kind) replaces a one-off hardcoded check for which views
  need clearing on resize-to-mobile, so the compiler now flags a future
  view kind added without updating it.
- **`runAction` helper collapses eight copies of the same
  `setBusy(true)/try/await/catch/finally` skeleton** across `saveDraft`,
  `addToolFromWizard`, `removeTool`, `saveOrigin`, `saveThought`; a new
  `useSheet()` hook does the same for what had been seven independent
  `useState(false)` + two-closure pairs behind every sheet's open/close
  toggle.
- Fixed several real bugs surfaced while building the above:
  - `ConfirmModal`'s `z-index: 10` sat below any open bottom sheet
    (`z-index: 31`) — a confirm dialog opened from inside a sheet (e.g.
    deleting a tool from `ToolEditSheet`) rendered fully hidden and
    unclickable. Raised to `z-index: 40`.
  - `index.html`'s viewport meta was missing `viewport-fit=cover`, which
    silently made every `env(safe-area-inset-*)` in this app's mobile CSS
    resolve to `0` on iOS — the floating "new app" button and the bottom
    bar's safe-area padding had never actually been doing anything. Fixed,
    and centralized the insets into shared tokens
    (`--safe-top`/`--safe-bottom`/`--safe-left`/`--safe-right`,
    `--mobile-topbar-h`/`--mobile-bottombar-h` in `style.css`) so the fixed
    top/bottom bar heights aren't restated as magic numbers in four
    different files.
  - The floating "new app" button's position didn't account for
    `--mobile-bottombar-h` including the safe-area inset — on a phone with
    a home indicator it overlapped the bottom bar by as much as that
    inset.
  - `OriginEditSheet`'s save closed the sheet unconditionally right after
    firing the request, so a failed save looked identical to a successful
    one; `onSaveOrigin` now returns whether it actually succeeded and the
    sheet only closes on `true`.
  - `ToolNameSheet`/`ToolDescriptionSheet` compared a trimmed draft against
    the saved value to enable Save, but submitted the untrimmed draft — a
    trailing space enabled Save yet still failed the backend's name
    validation right after. Both now submit the trimmed value.
  - `#root`'s height switched from `100vh` to `100dvh`, avoiding the
    mismatch between the two on mobile browsers whose address bar can
    show/hide.
- `ToolForm.tsx`'s "Delete tool" button moved from the header to a
  bottom danger zone (matching `AppSettingsView.tsx`'s own).
- Several more components migrated from global class names to CSS Modules
  (`KeyModal`, `LoginCard`, `Playground`, `Toast`, `ToolForm`), with
  `style.css` shrinking accordingly.

## v0.2.21

No breaking changes — patch release. Landing-page UI and internal
analysis/chart logic only; `mountMarketingDemo`'s exported signature and
its returned `{ openCode }` API are unchanged.

- Move the marketing-demo widget's ~80 `md-demo-*`/`md-sheet-*`/`t-*`
  styles into a real Shadow DOM (new `widget.css.js`, injected via
  `attachShadow` in `mountMarketingDemo`) instead of relying on class-name
  convention to avoid colliding with the host page's own styles — the
  widget's CSS can no longer leak onto the page, and the page's CSS can no
  longer bleed into the widget.
- Replace the mobile layout's `@media (max-width: 720px)` breakpoint
  overrides with a JS-driven `.is-mobile` class (toggled via
  `matchMedia` in `widget.js`). The old approach was fragile — whether an
  override actually won depended on its position in the stylesheet's
  source order relative to the base rule it was meant to override, not on
  which one was "the mobile one," and one such override (the input's
  16px iOS-zoom-prevention font-size) had silently gone dead this way.
  `.is-mobile <selector>`'s higher specificity makes source order stop
  mattering.
- Fix background-page scroll leaking through on iOS Safari while the demo
  modal is open (`overflow: hidden` alone doesn't stop it there —
  needs `position: fixed` on `body` with scroll position saved/restored).
- Fix the demo's composer input auto-zooming the whole page on focus on
  iOS Safari (font-size was under the 16px threshold that triggers it).
- Fix `closeDemo`'s `history.back()` navigating away from the site
  entirely (not just closing the modal) for a visitor who landed directly
  on a `#try-demo=<id>` deep link — there's no prior same-site history
  entry for `back()` to land on in that case. Switched to
  `history.replaceState`, which only edits the current entry.
- Add `viewport-fit=cover` and `env(safe-area-inset-*)`-based padding so
  the modal doesn't render under the notch/Dynamic Island or home
  indicator on notched iPhones.
- Fix the Data tab's data-preview table: it could overflow its container
  horizontally (a flex-child `min-width: auto` default) and, on
  desktop, its `<thead>`'s `position: sticky` never actually stuck  —
  the intended scroll container (`.md-demo-data-scroll`) never received a
  bounded height to overflow against, so the whole Data view scrolled as
  one block instead.
- Fix `analysis.js`: `trend()` had no guard against a non-numeric
  variable (unlike `correlation`/`regression`/`ranking`, which already
  return an honest `insufficient_numeric_data` error for that case) —
  a bad variable silently produced a `NaN`-filled series. Also, all four
  methods' numeric checks used `typeof x === 'number'`, which doesn't
  exclude `NaN`/`Infinity` — a single bad value could silently poison an
  entire correlation matrix, regression, ranking, or trend series instead
  of triggering the intended failure path; switched to `Number.isFinite`.
  `ranking`'s negative `topN` also silently returned "all but the last N"
  items instead of an empty result (`Array.prototype.slice(0, negative)`
  counts from the end) — now clamped to 0.
- Fix `charts.js`: `barChart` didn't handle negative values (regression
  coefficients can be negative) — bars for negative values rendered with
  inverted/off-chart height instead of drawing below a zero baseline.
  `lineChart([])` threw a real exception instead of rendering blank,
  reachable whenever `trend()` produces an empty series.
- Fix a latent memory leak: `mountMarketingDemo`'s mobile
  `matchMedia` listener was never removed on its (currently unreachable
  in production, but present) re-mount path.

## v0.2.20

No breaking changes — patch release. Landing-page UI only; no public API
affected.

- Add a first-pass mobile layout for the marketing-demo widget (the
  "Marketing analytics assistant" case card's live demo), modeled on a
  bottom-sheet pattern: at ≤720px, the chat panel becomes the permanent
  full-screen surface (scenario blurb and quick-test questions now open
  as the first entries in the chat log itself, rather than a separate
  fixed block), and the Data/Code views open as sheets that slide up over
  it instead of replacing it. Desktop is unaffected — it keeps the
  original three-tab sidebar (Analysis/Data/Code) and side-panel chat.
- Fix a real layout-breaking bug on the Traditional Chinese page
  (`zh-tw/index.html`) specifically: its `@media (max-width: 720px)`
  block had fallen out of sync with the English page's own copy of the
  same rules (two separate `.md-demo-chat` selectors instead of one
  merged rule), so opening the Data sheet on mobile collapsed the chat
  panel's `flex-direction`/`position` back to browser defaults — visible
  as the input row rendering squeezed at the top of the screen instead of
  pinned to the bottom. Both pages' mobile CSS now match exactly.
- Simplify the widget's copy and navigation: shorten the scenario
  paragraph, drop the now-inaccurate "these aren't mockups — they're
  runnable examples under `examples/`" line (the live example now lives
  under `apps/landing/src/marketing-demo/`, not `examples/`), shorten nav
  labels ("分析畫面"/"資料狀況" → "分析"/"資料"), and add small line
  icons to the Data and Code entry points.
- Update `apps/landing/public/sitemap.xml`'s `lastmod` for `/` and
  `/zh-tw/` to reflect today's content changes.

## v0.2.19

No breaking changes — patch release. Purely additive CD wiring; no
public API affected.

- Wire an optional `LANDING_ANALYSIS_API_KEY` GitHub Actions secret into
  the `apps/landing` Docker build stage, so the marketing-demo widget's
  AgentBridge connection can point at a real, production-issued API key
  instead of always showing "not live yet". Injected via BuildKit
  `--secret` (same pattern already used for `GH_PAT`) so the value never
  lands in the image's layer history; the build stage writes it to
  `.env.production.local` for Vite to pick up (this is a browser-facing
  app key, so it's expected to end up embedded in the built JS bundle —
  the secret mount only keeps it out of layer history along the way).
  The secret is genuinely optional: a build run without it still
  succeeds, verified with a `--no-cache` build with no `--secret` flag.
- Update `docs/deployment.md` to document the new secret (Dockerfile
  build steps, GitHub Actions secrets list, and the env/secrets
  reference table) — it previously only mentioned `GH_PAT`.

## v0.2.18

No breaking changes — patch release. Lockfile-only change; no source
code or public API affected.

- Fix `apps/landing`'s Docker build failing at the `npm ci` step. The
  committed `package-lock.json` was generated with npm 11 (local dev),
  but the Dockerfile's `landing-build` stage runs on `node:22-alpine`
  (npm 10) — that version mismatch made npm 10 throw internally while
  resolving `@onagent/bridge`'s entry, surfaced as a misleading "no
  lockfile found" error even though the file was present and valid.
  Regenerated inside a `node:22-alpine` container so the committed
  lockfile matches what the actual build environment can read;
  `@onagent/bridge` now resolves to its published registry version
  (0.0.2) instead of a local workspace link. Verified end-to-end in a
  fresh container: `npm ci` installs cleanly (0 vulnerabilities per
  `npm audit`) and `npm run build` produces the same output as before.

## v0.2.17

No breaking changes — patch release. The only new export
(`apps/landing/src/analytics.js`'s `installClickTracking`) is additive;
nothing existing was removed or renamed.

- Add a live marketing-analysis demo widget (`apps/landing/src/
  marketing-demo/`) to both landing pages, as a modal off the "Marketing
  analytics assistant" case card — 6 real analysis methods (frequency,
  cross-table, correlation, regression, trend, ranking) run against 120
  rows of mock campaign data, with canvas charts and a real AgentBridge
  chat connection, not a scripted preview. Bilingual UI (English/
  Traditional Chinese) via a small `strings.js` lookup table; the
  underlying dataset values stay plain English on both pages so every
  table/chart renderer doesn't need a second value-translation layer.
- Connection config (WS URL / app ID / API key) now comes from
  `VITE_ANALYSIS_WS_URL`/`VITE_ANALYSIS_APP_ID`/`VITE_ANALYSIS_API_KEY`
  (see `apps/landing/.env.example`) instead of being hardcoded, so local
  dev and production each point at their own backend without editing the
  widget's source.
- Add declarative click tracking for the landing site
  (`apps/landing/src/analytics.js`'s `installClickTracking`) — an
  element marked `data-track="event[:value]"` fires a GA4 event through
  one delegated listener, mirroring the pattern already used in
  `apps/console`.
- Fix three `analysis.js` bugs: `trend()` compared against stale
  hardcoded month keys that no longer matched the dataset's month
  values (always returned an empty series); `correlation()`/
  `regression()` fabricated a zero correlation/R² when the AI picked a
  non-numeric variable for a numeric-only slot, indistinguishable from
  a genuine zero result; `ranking()` could throw on a non-numeric
  metric variable instead of failing gracefully. All three now return
  an honest `error` field the widget renders as a plain message.
- A failed prompt now surfaces as a chat-log bubble with a retry
  button, instead of a line of text under the input box that's easy to
  miss; chat history (messages and result cards) now persists to
  `localStorage` and replays on reload.
- Delete `examples/analysis` (the old Vue 3 survey-analysis demo this
  new widget replaces).

## v0.2.16

No breaking changes — patch release. `analytics.ts`'s exported function
signatures (`fireRegistrationConversion`, `installClickTracking`) are
unchanged; only their internal implementation changed.

- Migrate GA4/Ads tracking from hardcoded `gtag.js` calls to a Google Tag
  Manager container (`GTM-MXMK83XR`). Console and all six landing pages
  used to load `gtag.js` directly and call `gtag()` with the GA4 property,
  Ads account, and the registration conversion's tag/label all hardcoded
  inline — changing any tracking config meant editing and redeploying this
  repo. Both now load the GTM container instead; `analytics.ts` no longer
  calls `gtag()` at all — it pushes plain events onto `window.dataLayer`
  (`sign_up` for a registration, `tool_creation_method_selected:<method>`
  for the wizard-vs-blank-form click tracking), and the container's own
  tags/triggers/variables decide which GA4/Ads config actually fires.
- The container's tags (GA4 config, Ads config, Ads conversion tracking
  for `sign_up`, GA4 event for `tool_creation_method_selected`) were
  verified end-to-end via GTM's Preview mode against a local console
  instance before landing — a real registration correctly fired the Ads
  conversion tag. This mattered because the two live onagent Search
  campaigns bid on "Maximize Conversions" / "Target Spend" using this
  account's primary conversion goals, which include the registration
  conversion.
- Add `marketing/gtm-tools/` (a new sibling to `marketing/google-ads-tools/`,
  both gitignored from this repo) — read-only Tag Manager API query
  tooling used to inspect and confirm the container's tag/trigger/variable
  setup during this migration, and to reproduce that inspection if the
  container needs changing again.

## v0.2.15

No breaking changes for any external consumer — patch release.
`ws.Handler`'s `Auth *auth.Store` field was replaced with `Resolver
AppResolver` and `NewHandler`'s signature changed to match, but
`internal/ws` has exactly one caller (`backend/cmd/server/main.go` and
`backend/internal/console/console.go`, both updated in the same change) and
is unreachable from outside this module by Go's own `internal/` visibility
rule, so there's no external code this could break.

- Fix Playground tool calls always failing with "no connected page for
  session ... (it may have disconnected)". Root cause: Playground
  reimplemented its own simplified WebSocket protocol with no `tool_result`
  round trip and never registered an `inference.RegisterAsker`, so any
  `ToolKindAction`/`ToolKindQuery` tool call had nothing to answer it.
  Playground now reuses `internal/ws.Session` wholesale via a new
  `ws.AppResolver` interface — `APIKeyResolver` for the real Agent Bridge
  SDK path, `playgroundResolver` for Playground's session-cookie +
  ownership auth — so connection management, ping/pong, and
  `AskInteraction`/`tool_result` correlation are shared code instead of two
  implementations that could drift.
- Add the guided tool-creation wizard (`ToolWizard.tsx`): a step-by-step
  flow (Template → Name → Description → Parameters → Returns) for building
  a tool from a template or from scratch, as an alternative to the flat
  form editor.
- Add a Playground mock for a tool built from the wizard's `click_button`
  or `fill_form` templates: a human tester can click a mock button or type
  into a mock field, and a matching `tool_call` triggers the exact same
  effect and reports back whether it genuinely took hold (`ok:false`, not
  a fabricated success, for anything the mock has no real target for).
  Mocks are implemented as one `useXxxMock()` hook per template
  (`playgroundMocks/`) behind a shared `render()`/`invoke()` interface, so
  adding a future template's mock doesn't require touching
  `Playground.tsx`. Each mock's button labels / field names come from the
  tool's own parameter `enum` (editable in the console) rather than a
  hardcoded list.
- Since a mock reads a tool call's arguments by a literal parameter name
  (e.g. `click_button`'s `label`), renaming or removing that parameter in
  the console would silently break the mock. `SchemaEditor` now accepts
  `lockedPropertyNames` to prevent renaming/removing/un-requiring those
  specific parameters (in both the flat form and the wizard), while type,
  description, and enum options stay freely editable.
- Fix a tool built from a zero-parameter wizard template (e.g. "Click a
  fixed button") producing a bare `{"type":"object"}` with no `properties`
  key at all — ambiguous JSON Schema that hung the vLLM tool-calling
  grammar generator with no error or response.
  `ParameterSchema.MarshalJSON` now always includes an explicit
  `"properties"` key (as `{}` when there are none) for every JSON encode
  of an object-type schema.
- Add a declarative click-tracking mechanism
  (`apps/console/src/analytics.ts`'s `installClickTracking`): an element
  marked with `data-track="event[:value]"` fires a GA4 event through one
  delegated listener, so adding or removing an analytics point is a JSX
  attribute change, not a new `fire*()` function and call site. Wired up
  on the two "create a tool" entry points (guided wizard vs. blank form)
  to see which one developers reach for.
- Add a `source_template` column recording which wizard template (if any)
  a tool was built from — purely informational for display and mock
  dispatch, never read by validation or inference.
- Bump `@onagent/claude-skill` to 0.0.3: `onagent-cli-setup`'s SKILL.md was
  missing the `set-thought` and `get-tools` CLI commands entirely from its
  instruction list, and didn't document that `save-tools` never sends a
  `tools.yaml`'s `thought` field (by design — it lets one `tools.yaml`
  apply to multiple apps without clobbering each app's own thought), not a
  bug. Docs-only; no CLI behavior changed.

## v0.2.14

No breaking changes — patch release. `quota.Record`'s signature is
unchanged; the dedup mechanism removed was an internal implementation
detail, not part of its contract.

- Fix Playground prompts silently not counting against quota. Root cause:
  `Playground.tsx` sent `requestId: String(nextId.current)` — a counter
  that resets to 0 on every page reload — and `Quota.Record`'s idempotency
  key (`sessionID+":"+requestId`) collided with a previous page load's
  event for the same user+app, so a real new prompt got a real inference
  response but was silently absorbed by `usage_events`' unique index via
  `ON CONFLICT DO NOTHING`.
- `Playground.tsx` now uses `crypto.randomUUID()` for `requestId`, and the
  dedup mechanism is removed at its root rather than patched at the one
  caller that tripped it: `usage_events_app_id_event_id_idx` is dropped
  (`schema.sql`) and `quota.Record` no longer has an `ON CONFLICT` clause.
  `eventID` is kept as a column for audit purposes only. Neither
  Playground nor `packages/bridge`'s real SDK ever resends an
  already-sent `requestId`, so this isn't expected to introduce real
  double-counting — revisit once Stripe billing lands.
- `Quota.Check`/`Quota.Record` failures in `playground.go` are now logged
  (`slog.Error`) instead of silently discarded.
- Add `docs/known-issues-pending-discussion.md`, recording the full
  incident and a remaining open question (should `requestId` be
  caller-supplied at all).

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

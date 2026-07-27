# Known issues in the `want` dependency

This platform's backend delegates real inference to `want`
(`github.com/tim72117/want`, source at `/Users/caitingyu/Documents/want`), a
separate library. Some limitations live in `want` itself, not in this
repo's code — fixing them means editing `want`, not `backend/`. Tracked here
so they aren't rediscovered from scratch.

## Editing a tool's schema doesn't take effect — FIXED in want v0.1.0

**Was:** a developer edits an existing tool's schema in the console and
saves; the LLM kept seeing the original, first-registered version of the
schema for the rest of the process's lifetime. Root cause was `want`'s
(pre-v0.1.0) `types.GlobalRegistry.Declarations` being append-only, with tool
lookup resolving a name to its **first** matching declaration.

**Fix:** want v0.1.0 removed `types.GlobalRegistry`/`types.RegisterTool`
entirely in favor of a `types.ToolProvider` interface the caller injects
(`orchestrator.Setup`/`SetupWith`'s toolbox parameter). This repo's
`appToolProvider` (`backend/internal/inference/agent_roles.go`) implements
that interface by reading `toolschema.Registry` live on every single call —
there is no snapshot to go stale, so a schema edit needs no re-registration
step at all. Verified by `TestToolProvider_SchemaEditTakesEffectWithoutRestart`
(`backend/internal/inference/agent_roles_test.go`), which replaced an earlier
version of the same test that reproduced this exact bug against want v0.0.2.

## Single shared orchestrator serializes every user's every turn — PARTIALLY ADDRESSED in want v0.2.0

**Was:** `WantService.Complete()` held one mutex for the entire duration of
each call (including the wait for the LLM's response, up to 90s), because
there was exactly one `*orchestrator.Orchestrator` instance for the whole
backend process, with `orch.AgentID`/`orch.Role`/`orch.Toolbox` swapped
per-call to fake per-session/per-app isolation.

**What changed:** want v0.2.0 added `Orchestrator.Stop()`, closing the gap
that made running one `*orchestrator.Orchestrator` per session unsafe (no
way to release a stopped session's dispatch goroutine — it would leak
forever). `WantService` (`backend/internal/inference/want.go`) now keeps one
orchestrator per SessionID, built lazily and released via
`inference.Service.CloseSession` when the owning WS connection or
Playground run closes.

**What did NOT change:** want v0.2.0 still resolves every `RunAgent` call's
LLM provider through its own process-wide `internal.GlobalEngine`
(`orchestrator.InitializeWithConfig` overwrites it, and this repo now calls
that exactly once for the process's lifetime — see `want.go`'s package doc
comment for why calling it per-session would be unsafe). Every session's
orchestrator therefore still shares the same underlying provider and its
`provider.NewRequestQueue(1, ...)` — concurrency 1, backend-wide. **This
change gives per-session object-level isolation (AgentID/Role/Toolbox/
conversation history, correctly isolating content — matching what the old
design already achieved), and lets a closed session's resources actually be
reclaimed — it does not give additional inference throughput.** Multiple
users' turns still queue behind each other one at a time.

**Status:** the throughput half of this issue remains open. Fixing it would
require `want` exposing a way to build independent providers/queues per
orchestrator (not just per-process), or this repo running multiple `want`
processes — either is a larger change than the object-isolation work above.

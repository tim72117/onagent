# TODO: same-user multi-turn scenario

Not implemented yet. Captured here so the requirement isn't lost — deferred
during the session that built this tool ("這個先等等") in favor of the
multi-app `-config` grouping work, which shipped first.

## The gap

`runRepeatNonce` (main.go) does exactly one round trip per virtual user:
connect → hello/ack → one prompt → one `assistant_message` → disconnect.
There is no support today for one virtual user sending several prompts in
sequence on the *same* WebSocket connection/session — i.e. no simulation of
a real multi-turn conversation.

## Why it matters

This is a different risk surface than what's already covered:

- **Already covered**: multiple *different* sessions (different
  connections, possibly different apps via `-config` groups) running
  concurrently, checked for content cross-talk between them.
- **Not covered**: a *single* session's own conversation state staying
  correct across several sequential turns, especially when those turns are
  interleaved with *other* sessions' turns on the backend's shared,
  serialized orchestrator (see `docs/project-audit.md`'s A1 — `WantService`
  holds one mutex across `orch.AgentID`/`orch.Role`, swapped per call and
  relying entirely on that mutex for safety). A multi-turn scenario is what
  would actually exercise that swap-under-contention path; a one-shot
  scenario never does, no matter how many concurrent *sessions* it runs.

## Rough shape, fitting the existing `-config` design

Should slot into the same `group`/`scenario` mechanism already in main.go,
not become a separate flag or code path:

- Add a `"scenario": "multi_turn"` value alongside the existing
  `"repeat_nonce"` default.
- Add a `"turns"` field to `group` (e.g. `"turns": 5`), read only by the
  `multi_turn` scenario — `repeat_nonce` ignores it.
- New `runMultiTurn(s spec, wsURL string, timeout time.Duration, turns int) userResult`:
  same connect/hello/ack as `runRepeatNonce`, then loop `turns` times,
  each iteration sending a fresh nonce and waiting for its
  `assistant_message` *on the same connection* before sending the next —
  never closing/reconnecting between turns. Assert each turn's response
  contains that turn's own nonce, same substring check as today.
- Reporting: per-user result should probably become "N/turns succeeded"
  rather than a single ok/fail, since a partial run (turn 3 of 5 fails) is
  itself an interesting, distinct outcome worth surfacing — not just
  pass/fail for the whole user.

No changes needed to `flatten`/`main`'s dispatch loop — a `spec` already
carries `scenario`, threading a `turns` value through it (from `group`) is
the only structural addition beyond the new scenario function itself.

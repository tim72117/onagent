# SSE transport alongside WebSocket — 2026-10-22

**Status:** first version shipped in v0.7.5 / `@onagent/bridge` 0.2.0
(API-key path only), verified end to end in a real browser (Chrome 155,
cross-origin). Deferred items below are deliberately not done yet — most
importantly, SSE is only reliable on a single backend instance.

## Why

Some client networks can't hold a WebSocket open — corporate proxies and
middleboxes that strip or refuse the `Upgrade` handshake are the usual
cause. Server-Sent Events are plain HTTP and get through where a WebSocket
doesn't. This adds SSE as an **additional** transport; WebSocket is
unchanged and stays the SDK default.

## Protocol

SSE is server→client only, so the upstream is ordinary HTTP POST. Message
shapes are unchanged — every message is the same `protocol.Envelope` JSON a
WebSocket frame carries. No new message types.

| | WebSocket | SSE |
|---|---|---|
| Connect | `GET /ws?token=` (upgrade) | `GET /sse?token=` → `text/event-stream` |
| Session id | in `ack` | first event is a named `session` event: `{"sessionId": "..."}` (also still in `ack`) |
| client → server (`hello`, `prompt`, `tool_result`) | same socket | `POST /sse/{sessionId}`, body = one Envelope, answers `202` |
| server → client (`ack`, `tool_call`, `tool_query`, `assistant_message`, `error`) | same socket | default SSE events, `data:` = one Envelope |
| Liveness | WS ping/pong (30s / 60s) | `: ping` comment line every 30s; a failed write ends the session |
| Session end | socket closes | the GET's request context ends, or a write fails |

**Auth.** The GET runs the exact same `APIKeyResolver` as `/ws` — token,
app enabled, per-app allowed origin, quota — so SSE is never more permissive
than WebSocket. A POST is authorized by its `sessionId` (128-bit
`crypto/rand`, delivered only over a stream that passed the resolver) plus an
`Origin` match against the origin that stream was authorized for. A wrong
origin and an unknown session both get the identical `404` — same body,
and the caller's own `Origin` echoed in `Access-Control-Allow-Origin` in
both cases. The echo matters: without it a browser hides the response and
`fetch` reports a network error, which the SDK deliberately doesn't retry,
so "session gone → resend and reconnect" could never trigger. This is the
same trust level as the api key itself, which also travels in a URL.

A resolver may return a fixed session id instead of `""` (the
`AppResolver` contract allows it; Playground's does). A second stream
under an id that's already live gets `409` rather than silently taking over
the first one's routing and inference asker. Only a real body-size overflow
is answered `413`; any other body-read failure is `400`.

**CORS.** The stream and each POST echo the authorized origin in
`Access-Control-Allow-Origin`. The SDK POSTs as `text/plain`, which keeps
each POST a CORS "simple" request with no preflight (the server reads the raw
body and ignores the content type), so there is no `OPTIONS` route. This
costs nothing in safety: the POST's `Origin` is still checked against the
stream's, and browsers always send `Origin` on a cross-origin POST. A stream
request with no `Origin` is refused (`403`) before the resolver runs — every
POST is bound to the stream's origin, so such a stream could never be used.

## Backend (`backend/internal/ws`)

`Session` was already transport-agnostic in its logic (`handlePrompt`,
quota, `AskInteraction`/`pendingCalls` correlation by `requestId`) but held a
concrete `*websocket.Conn` for reading and keepalive. Changed so both
transports share one `Session`:

- `Session.conn` removed. Outbound already went through `writeMessage`; the
  transport now supplies it.
- New `newSession(...)` / `Session.close()` / `Session.handleRaw(ctx, raw)`:
  construction + asker registration, teardown (`UnregisterAsker`,
  `infer.CloseSession`), and the single inbound entry point.
- WS-specific reading and ping/pong moved to `runConn(ctx, conn)`;
  `NewSession` keeps its signature, so `Handler` and Playground are
  untouched.
- `sse.go`: `SSEHandler` with `Stream` (GET) and `Message` (POST), and an
  in-memory `sessionId → session` map so a POST can find its stream.

Notable details:

- Inbound messages are dispatched under the **stream's** context, not the
  POST's — `handlePrompt` runs on its own goroutine and outlives the POST
  that delivered it.
- A `tool_result` on its own POST unblocks an in-flight `AskInteraction`
  exactly as a WS frame does; nothing about query-tool correlation changed.
- After the GET handler returns, writes are refused (a `closed` flag under
  `Session.writeMu`) — a late `send()` from a still-running `handlePrompt`
  must not touch a finished `ResponseWriter`.
- `Cache-Control: no-transform` and `X-Accel-Buffering: no` keep
  intermediaries from buffering events.
- `cmd/server/main.go`: routes mounted next to `/ws`;
  `withLegacyDomainRedirect` now exempts `/sse*` the same way it exempts
  WebSocket upgrades (a 301 turns a POST into a GET, and a redirected stream
  would mint sessions the legacy host's POSTs can't find).

## SDK (`packages/bridge`)

- New options: `transport: "ws" | "sse" | "auto"` (default `"ws"`) and
  `sseUrl` (default: `url` with `ws(s)://`→`http(s)://`, trailing
  `/ws`→`/sse`, query string kept; an underivable URL throws at
  construction). A query string on an explicit `sseUrl` is kept too — the
  per-session POST URL is built with `URL`, not string concatenation.
- Internally `AgentBridge` now talks to a small `Transport` interface
  (`WsTransport`, `SseTransport`); hello, queueing, reconnect/backoff,
  visibility handling and tool dispatch stay in `AgentBridge` and are shared.
- `SseTransport` chains its POSTs so they can't overtake each other (a
  WebSocket never reorders; a prompt must never land before its hello).
- `EventSource`'s own auto-retry is suppressed (closed on `error`): each
  retry would be a new server session nobody said hello on. The bridge's own
  backoff + reconnect, which does re-hello, takes over — same as a WS close.
- A failed POST is handled by what's known about whether the server acted
  on it — resending is only safe when it definitely didn't:
  - **`404` (session gone), or the transport closed before the POST went
    out:** not delivered. The server answers 404 before dispatching
    anything. The transport closes and reconnects; a **prompt** is resent on
    the next session, ahead of anything queued after it (a separate retry
    list, flushed first). `hello` is resent by every connection anyway, and a
    `tool_result` belongs to the dead session, so neither is retried.
  - **Any other non-2xx (e.g. `413` over the size limit):** the server
    refused the message itself; resending would be refused identically,
    forever. Reported via `onError`, not retried; the session stays up.
  - **No response (network error):** the server may already have received
    it and started inference, so resending risks running the prompt and its
    tools twice. Reported via `onError`, not retried. The stream's own error
    event handles a lost connection.
  A failed **`hello`** is never reported or left alone: without it no ack
  arrives and everything queued behind it would wait forever, so any hello
  failure closes the transport and reconnects.
- **Timeouts.** A stream that hasn't delivered its `session` event *and*
  a first envelope (normally the ack) within 15s is closed and reconnected
  — a proxy that buffers event streams would otherwise leave the bridge
  connected but silent forever. Each POST is aborted after 10s: sends are
  serialized, so one hung POST would hold up every message behind it,
  including `tool_result`s the server stops waiting for after 20s. A timed-
  out POST is reported (fate unknown, so not resent) and the session is
  restarted.
- **`"auto"`.** The WebSocket API hides why a handshake failed, so "never
  opened" can mean a network that blocks WebSocket — or a backend that's
  down (mid-deploy) or refusing this app (403 disabled, 429 over quota).
  Only the first is a reason to switch, and the only way to tell is to try
  SSE, which only gets through if the server is up and accepting us:
  - After **3 consecutive** WebSocket attempts that never opened, SSE is
    tried as a **trial**.
  - If the SSE trial fails to open too, the problem was the server, not the
    wire: back to WebSocket, count reset.
  - Once an SSE connection actually opens, the bridge **commits** to SSE.
    After 10 minutes committed, its next reconnect tries WebSocket once; if
    that fails it goes straight back to SSE.
  Closes the bridge caused itself (page hidden, `close()`) and attempts made
  while `navigator.onLine` is false don't count toward the 3.
- **Stale callbacks.** Every transport callback is tied to the transport it
  came from. A replaced transport can still fire — a WebSocket's close event
  arrives asynchronously, possibly after a quick hide/show already connected
  a new one — and acting on it would mark the live connection not ready and
  open yet another, orphaning the live one. (This race existed in the
  WebSocket code before SSE; the transport refactor is what made it simple
  to close.) The one exception is a POST-failure report, which is acted on
  regardless — a prompt lost by an old transport still has to be resent on
  the new one, and is sent immediately if the new session is already up.

## Decisions taken for v1

- **Scope: API-key path only.** `/ws`'s real SDK path gets an SSE twin; the
  console Playground does not (see Deferred).
- **Reconnect = new session.** A dropped stream is not resumed; the new
  stream gets a new `sessionId` and the SDK says hello again. Same as a
  WebSocket reconnect today. No `Last-Event-ID` (see Deferred).

## Deferred

### 1. Multiple instances (most important before relying on SSE in production)

WebSocket has no routing problem: one connection carries both directions,
so whichever instance accepted it handles everything. With SSE the GET
stream and each POST are **separate requests** and may be load-balanced to
**different Cloud Run instances**. A POST reaching an instance that doesn't
hold its session gets `404` → the SDK treats the stream as lost and
reconnects (a resent prompt survives, but a `tool_result` for an in-flight
query does not, and that query times out). Under multiple instances this
fails often enough to be unusable. Options:

- **(a) Cloud Run session affinity** — cookie-based, documented as
  best-effort; cheap to turn on, not a guarantee. Note the SDK's POSTs are
  cross-origin `fetch` without credentials, so an affinity cookie would not
  be sent as-is; this would also need `credentials: "include"` and matching
  `Access-Control-Allow-Credentials`, which changes the CORS model.
- **(b) `max-instances=1`** — simplest and fully correct; gives up
  horizontal scaling for the whole service, not just SSE.
- **(c) Cross-instance forwarding** — e.g. Postgres `LISTEN/NOTIFY` (or
  Redis pub/sub) carrying an inbound envelope to the instance holding the
  stream. Robust, but real engineering: a channel per session or a shared
  channel with filtering, delivery guarantees, and cleanup.

Until one of these is chosen, SSE is only reliable on a single instance.

### 2. Playground over SSE

`console/playground.go` reuses `ws.Session` through `ws.Handler` with its
own `playgroundResolver` (cookie auth, console-origin allowlist, stable
`PG-<userID>-<appID>` session id). An SSE twin would need: an SSE handler
parameterized by that resolver, credentialed CORS
(`credentials: "include"` on both `EventSource` and the POSTs, matching the
console's existing `siteCORS`), and a decision about the stable session id —
two simultaneous Playground tabs for the same app would collide on one
`sessionId` key in the SSE session map, so one tab's POSTs would land on the
other's stream. (The WS path already has a milder form of this: both tabs
register the same id with `inference.RegisterAsker`, so the later one wins
query-tool questions — but each tab's own frames still reach its own
`Session`.)

### 3. Resume after reconnect (`Last-Event-ID`)

Would need event ids on every envelope, a per-session replay buffer, and a
grace period during which a dropped session (and its want orchestrator, and
any in-flight `AskInteraction`) is kept alive waiting for a reconnect. Only
worthwhile if reconnects mid-prompt prove common in practice.

### 4. Detecting a dead client on a half-open connection

The server notices a gone SSE client only when a heartbeat write fails. A
client that loses its network without closing TCP (a phone dropping off
wifi, say) leaves the connection half-open: `: ping` writes keep succeeding
into the kernel send buffer until TCP retransmission gives up, which can
take many minutes. Until then the `Session`, its asker registration and its
want orchestrator all stay alive. The WebSocket path doesn't have this
problem — a missed pong expires its 60s read deadline — but SSE is one-way,
so nothing comes back to time out on.

Fix: have the SDK POST a keepalive on an interval, and end a session that
hasn't received any POST for some multiple of it. That's a new upstream
message type (or a dedicated endpoint), so it's a protocol change; best
done together with item 1, since a keepalive POST has the same
which-instance-holds-the-session problem as every other POST.

## Other notes

- Cloud Run's request timeout cuts long-lived streams exactly as it cuts
  WebSockets; the SDK reconnects either way.
- Browsers allow ~6 concurrent HTTP/1.1 connections per origin; an SSE
  stream holds one. Not an issue over HTTP/2.

## Testing

Both transports are checked against one identical end-to-end scenario
(`internal/ws/transport_integration_test.go`): hello → ack → prompt →
`tool_query` → `tool_result` → `assistant_message`, authorized by the real
`APIKeyResolver` against a real app, with a fake inference service that
drives a real `AskInteraction` through the asker the transport registered.

- `internal/ws/sse_test.go` (default suite, no DB): resolver rejection,
  a stream with no `Origin` refused before the resolver runs, stream headers
  + session event, POST round-trip through `Session`, invalid envelope,
  a wrong-origin POST indistinguishable from an unknown session and never
  reaching it, an unknown-session 404 readable cross-origin, a duplicate
  stable session id refused with 409 without disturbing the live one, 413
  only for oversized bodies (400 for a broken one), session released when
  the stream closes.
- `internal/ws/conn_test.go` (default suite, no DB): dials a **real**
  WebSocket through `Handler` — before this change no test in the codebase
  opened one. Prompt round-trip, a bad frame reported without ending the
  connection, resolver rejection, and `CloseSession` called when the client
  hangs up.
- `internal/ws/sse_integration_test.go` / `ws_flow_integration_test.go`
  (`-tags integration`): the shared scenario over SSE and over WebSocket.
  The WS one also checks the session's asker is unregistered after the
  client disconnects.
- `internal/inference/asker_integration.go` exposes `lookupAsker` as
  `LookupAskerForTest`, compiled only under the `integration` tag, so it
  never exists in a production binary.
- `packages/bridge/src/client.sse.test.ts`: URL derivation (query strings
  kept on both `url` and `sseUrl`), session/hello, queue-until-ack
  ordering, tool_query answered by POST, reconnect with fresh hello,
  `text/plain` POSTs, and the three POST failure outcomes — a 404'd prompt
  resent ahead of prompts queued after it, a 413 reported not retried, a
  network error reported not resent. A prompt lost after the next session
  is already up is sent immediately; a failed hello restarts the session;
  the handshake timeout (no session event, or no ack) and the POST timeout
  each restart it. `"auto"`: tries SSE only after three never-opened
  attempts, ignores closes it caused and attempts while offline, reverts
  to WebSocket when the SSE trial can't open either, commits once SSE
  opens, and reprobes WebSocket after 10 minutes. A replaced transport's
  late close event is ignored. The existing WebSocket lifecycle tests pass
  unchanged.

  Mutation-checked: removing the transport-identity gate, the immediate
  flush of a late-lost prompt, the trial revert, the handshake timeout, or
  the POST timeout each fails exactly the test written for it.

The new tests were checked against deliberate breakage: running
`handlePrompt` synchronously in the read loop makes the WS full-flow test
fail (the `tool_result` can never be read), and dropping the session
teardown fails both `TestWS_SessionReleasedOnClose` and the asker check.

Run integration tests with `-p 1`: packages share one database, and running
`ws` and `console` integration tests concurrently produced failures in
`TestAPIKeyResolver_OverQuotaRejectsHandshake` and
`TestListNotifications_ReturnsOnlyOwnedAppsAcrossMultipleApps` that pass
serially. Neither covers code this change touched.

Not run: the race detector (needs cgo/gcc, unavailable on the machine this
was written on), and a real browser exercising cross-origin `EventSource`
and the `text/plain` POSTs.

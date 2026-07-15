# Cross-site transport & security notes

This platform embeds a JS SDK into arbitrary third-party developer sites,
much like Google Analytics's `gtag.js` — but unlike GA's one-way telemetry,
this SDK is bidirectional: the backend can push `tool_call` messages that
execute actions in the page. That difference changes which parts of GA's
design apply and which don't. Findings below come from researching how
gtag.js/GA4 handles cross-site data transport, and how they map onto this
project's WebSocket-based design.

## What GA does that we borrow

- **Stub-function + queue buffering.** `gtag()` is a stub that pushes
  arguments onto `window.dataLayer` before the real library has loaded;
  the library drains the queue once ready. `AgentBridge` does the same
  thing internally — `prompt()` calls made before the
  WebSocket reaches `ack` are buffered and flushed on connect (see
  `packages/bridge/src/client.ts`). Callers never need to check
  a "ready" flag.
- **`sendBeacon` fallback on unload.** GA uses `sendBeacon`/keepalive
  `fetch` so the last hit survives page teardown. Since a WebSocket
  connection just drops on unload (no delivery guarantee for in-flight
  frames), `AgentBridge` optionally fires a `sendBeacon` with the last
  queued messages on `visibilitychange -> hidden`, if `beaconUrl` is
  configured.
- **CSP documentation for embedders.** GA publishes a minimal CSP snippet
  developers add to their site. We should do the same (see below).

## What GA does that does NOT apply here

- **`no-cors` beacon requests.** GA's `/g/collect` endpoint is typically hit
  with a `no-cors` GET/POST or `sendBeacon` — the browser allows this
  without any CORS header on the receiving end because the caller never
  reads the response body. This works for one-way telemetry. It does
  **not** work for us: we need to read `tool_call` responses back, so a
  transport that yields opaque/unreadable responses is a non-starter. This
  is why the primary channel is WebSocket, not a beacon.
- **Relying on browser-enforced cross-origin protection.** CORS protects
  *reading* cross-origin responses; it says nothing about WebSocket
  handshakes. A WebSocket `Upgrade` request is **not** gated by CORS at
  all — any page, on any origin, can open a connection to any WebSocket
  endpoint, and the browser will happily complete the handshake as long as
  the server replies `101`. The `Origin` header is sent, but nothing forces
  the server to check it.

## What this means for our implementation

Because WebSocket has no browser-side cross-origin gate, **the server is
the only enforcement point**:

- `backend/internal/ws/handler.go` validates the `Origin` header against a
  developer-configured allowlist (`ALLOWED_ORIGINS`) during the upgrade
  `CheckOrigin` callback, and rejects the handshake outright if it doesn't
  match. Running with no allowlist is logged as a dev-only warning, never
  silently permitted in a way that looks production-safe.
- Session identity should move to a short-lived token issued per site
  (e.g. an app key exchanged for a session token), not a bare cookie —
  cookies are attached automatically by the browser to any WebSocket
  handshake, which is the same ambient-authority problem CSRF exploits.
  This isn't implemented yet (no auth layer exists yet) but should land
  before this is used with anything beyond local/mock data.
- Tool dispatch never falls back to `eval` or dynamic property lookup by
  arbitrary name beyond an explicit allowlist: `AgentBridge` only invokes
  handlers the developer registered in `tools`, and refuses (with an
  explicit `tool_result.ok = false`) anything else. See
  `handleToolCall` in `client.ts`.

## Recommended CSP for embedding sites

Once this is deployed behind real domains, publish something like:

```
connect-src https://api.<platform-domain> wss://ws.<platform-domain>;
script-src https://sdk.<platform-domain>;
```

Two details that are easy to miss (found during GA CSP research):

- `connect-src` must include the `wss://` scheme explicitly — a
  `https://` entry alone does not cover a WebSocket upgrade.
- Prefer wildcarding a subdomain (`https://*.<platform-domain>`) over
  listing exact hosts, so introducing new edge/region endpoints doesn't
  require every embedding site to update their CSP.

## Open items (not yet implemented)

- Per-session auth token issuance/verification.
- Rate limiting / abuse protection on `/ws` and the codegen endpoints.
- A real `beaconUrl` HTTP endpoint on the backend (SDK already supports
  calling one; server-side handler doesn't exist yet).

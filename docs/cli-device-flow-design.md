# CLI auth: OAuth Device Authorization Grant (future work)

Not implemented. This documents the design for a second `atp login` mode,
to build if/when the CLI needs to authenticate from a machine with no
browser and no way to receive a localhost callback — an SSH session, a CI
job, a container. The browser-redirect flow (`atp login --web`, see
`backend/cmd/atp/main.go` / `backend/internal/console/console.go`) can't
work there: it needs to open a browser on the *same* machine and receive an
HTTP callback on a local port, both of which assume an interactive desktop
session.

This is the OAuth 2.0 Device Authorization Grant, [RFC 8628](https://www.rfc-editor.org/rfc/rfc8628) — the same
mechanism Docker CLI, Azure CLI, and `gh auth login`'s non-`--web` path use.
The core idea: the device (CLI) polls for approval instead of receiving a
callback, so the browser step can happen on a *different* device entirely
(e.g. approve from a phone while the CLI runs on a headless server).

## Flow

```
CLI                                Backend                          User's browser
 │                                     │                                    │
 │  POST /device/code                  │                                    │
 │ ───────────────────────────────────>│                                    │
 │                                     │  generates device_code (long,      │
 │                                     │  opaque, CLI-held) + user_code      │
 │                                     │  (short, human-typeable, e.g.       │
 │                                     │  "WDJB-MJHT") + expires_at (~10min) │
 │  { device_code, user_code,          │                                    │
 │    verification_uri,                │                                    │
 │    verification_uri_complete,       │                                    │
 │    interval, expires_in }           │                                    │
 │ <───────────────────────────────────│                                    │
 │                                     │                                    │
 │  prints:                            │                                    │
 │  "Go to <verification_uri> and      │                                    │
 │   enter code WDJB-MJHT"             │                                    │
 │  (or just the _complete URL, if the │                                    │
 │   terminal can open a QR/link)      │                                    │
 │                                     │                                    │
 │                                     │        opens verification_uri,     │
 │                                     │        logs in (if needed),        │
 │                                     │<───────────────────────────────────│
 │                                     │        enters/confirms user_code,  │
 │                                     │        approves                    │
 │                                     │<───────────────────────────────────│
 │                                     │                                    │
 │                                     │  on approve: mint a usertoken      │
 │                                     │  (internal/usertoken.Issue),       │
 │                                     │  associate its plaintext with      │
 │                                     │  device_code, mark approved        │
 │                                     │                                    │
 │  POST /device/token                 │                                    │
 │  { device_code }                    │                                    │
 │  (every `interval` seconds)         │                                    │
 │ ───────────────────────────────────>│                                    │
 │  { error: "authorization_pending" } │  (until approved)                  │
 │ <───────────────────────────────────│                                    │
 │           ⋮ keep polling ⋮          │                                    │
 │  POST /device/token                 │                                    │
 │ ───────────────────────────────────>│                                    │
 │  { token }  (once approved)         │                                    │
 │ <───────────────────────────────────│                                    │
 │                                     │                                    │
 │  saves token via saveToken()        │                                    │
 │  (same path browser-flow and        │                                    │
 │   password-flow already use)        │                                    │
```

## What's new vs. the browser-redirect flow already built

The browser-redirect flow reuses `internal/session` (cookie) +
`internal/usertoken` (the token it ultimately mints) with zero new backend
state — the CLI's local server is the only new moving part, and it's
gone the instant login finishes.

Device flow needs one new piece of *backend* state: a short-lived
CLI-code → approval-status association. Something like:

```sql
CREATE TABLE IF NOT EXISTS device_codes (
    device_code TEXT PRIMARY KEY,      -- long, opaque, only the CLI ever holds this
    user_code   TEXT NOT NULL,         -- short, what a human types; unique while unexpired
    user_id     BIGINT REFERENCES users (id) ON DELETE CASCADE, -- NULL until approved
    token       TEXT,                  -- the plaintext usertoken, set once approved; cleared after the CLI collects it
    expires_at  TIMESTAMPTZ NOT NULL,  -- ~10 minutes from creation (RFC 8628 recommends 600–1800s)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS device_codes_user_code_idx
    ON device_codes (user_code) WHERE expires_at > now();
```

Storing the plaintext token in this table (even briefly) is the one
deliberate departure from `internal/usertoken`'s usual "only ever hash it"
rule — RFC 8628's whole point is the CLI has no way to receive it except by
asking for it later, so *something* server-side has to hold it between
approval and collection. Mitigate with a short TTL and clearing the column
the instant `/device/token` returns it successfully (a second poll after
collection should 404/expire, not re-serve the same token).

## New endpoints (`internal/console`, or a new `internal/device` package)

- `POST /device/code` — no auth. Body: `{}` (maybe a `name` for the
  eventual usertoken, mirroring `issueTokenRequest`). Generates
  `device_code` (CLI-held secret, e.g. 32 random bytes) and `user_code`
  (short — RFC 8628 suggests a small charset like `BCDFGHJKLMNPQRSTVWXZ`
  avoiding ambiguous chars, formatted like `WDJB-MJHT`). Returns both plus
  `verification_uri` (a page prompting for the code) and
  `verification_uri_complete` (same page with `?user_code=` pre-filled, so
  a QR code or clicked link skips manual typing).
- A browser-facing page at `verification_uri` (part of `apps/console`, not
  the backend) — behind normal session-cookie auth (redirect to login if
  needed) — where the user confirms the code and clicks approve. On
  approve, calls a new authenticated backend endpoint (`POST
  /console/device/{userCode}/approve`) that looks up the matching
  `device_codes` row, mints a token via `usertoken.Issue`, stores it in
  the row, sets `user_id`.
- `POST /device/token` — no auth (device_code itself is the credential
  here, same trust model as the code in an OAuth authorization code
  grant). Body: `{device_code}`. While unapproved: `409` (or `200` with
  `{error: "authorization_pending"}`, matching RFC 8628's error shape more
  literally if an exact spec match matters later) so the CLI knows to keep
  polling. Once approved: returns `{token}` and clears the row's `token`
  column (single-collection). Expired/unknown device_code: `400`/`404` so
  the CLI stops polling and tells the user to restart.

## CLI side (`backend/cmd/atp`)

New subcommand, e.g. `atp login --device` (keeping plain `atp login` as
the password flow, `--web` as the browser-redirect flow once that's
built):

```go
resp := postDeviceCode(base)  // { deviceCode, userCode, verificationURIComplete, interval, expiresIn }
fmt.Printf("Open %s and confirm the code, or visit %s and enter %s\n",
    resp.VerificationURIComplete, resp.VerificationURI, resp.UserCode)

deadline := time.Now().Add(time.Duration(resp.ExpiresIn) * time.Second)
for time.Now().Before(deadline) {
    time.Sleep(time.Duration(resp.Interval) * time.Second)
    token, pending, err := postDeviceToken(base, resp.DeviceCode)
    if err != nil { return err }
    if pending { continue }
    return saveToken(token) // same saveToken() the password flow already uses
}
return fmt.Errorf("timed out waiting for approval")
```

RFC 8628 also defines a `slow_down` error the server can return to push
the CLI's polling interval up if it's polling too aggressively — worth
respecting if this gets built, but not essential for a first cut at the
scale this platform runs at.

## Why this is worth building later, not now

The browser-redirect flow (variant A, implemented) covers the common
case — a developer running `atp` on their own laptop, browser already
open. Device flow only earns its complexity once there's a real
CI/headless use case for the CLI; build it when that need actually shows
up rather than speculatively now.

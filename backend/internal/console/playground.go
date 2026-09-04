package console

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/tim72117/onagent/internal/quota"
	"github.com/tim72117/onagent/internal/session"
	"github.com/tim72117/onagent/internal/toolschema"
)

// Package playground: lets a developer test-drive their app's agent from
// inside the console itself, without a real front-end site to talk to.
//
// This used to be a whole separate, simpler WebSocket protocol reimplementing
// ping/pong, a read loop, and tool_call display — but with no tool_result
// round trip at all, any tool backed by ToolKindAction/ToolKindQuery (see
// internal/inference's askPage) had no way to ever succeed here: the
// forwarding/query tool's Call blocks on an inference.RegisterAsker'd asker
// that this endpoint never registered, so it always failed with "no
// connected page for session ... (it may have disconnected)".
//
// Rather than growing a second implementation of that machinery
// (AskInteraction, pendingCalls, tool_result correlation) to fix it,
// Playground now reuses internal/ws's Session/Handler wholesale — the exact
// same connection-management code the real Agent Bridge SDK path uses. Only
// the authentication/authorization half differs, via the AppResolver
// interface (see internal/ws/handler.go):
//
//   - Auth is the developer's own session cookie (internal/session), not an
//     API key. A console session is already proof the caller owns the app,
//     so there's no reason to make them mint and paste in a real key just to
//     try a prompt — and the console never even holds a plaintext key to use
//     for this (KeyModal shows it exactly once). See playgroundResolver
//     below.
//   - Origin is checked against the console's own origin allowlist
//     (Handler.ConsoleOrigins), not any per-app allowedOrigin — Playground is
//     reached from the console's own origin, not the developer's site, so
//     ws.Handler's per-app origin binding (APIKeyResolver) doesn't apply
//     here at all.
//   - The session id is a stable "PG-<userID>-<appID>" (not a fresh random
//     one per connection) so a developer re-opening Playground for the same
//     app resumes the same want conversation transcript rather than starting
//     a fresh one on every page load — see ws.NewSession's doc comment on
//     sessionID.
//   - playgroundResolver.ResolveApp also does its own handshake-time quota
//     check, mirroring APIKeyResolver.ResolveApp's — see that method's own
//     comment for why this is a cheap early gate, not the real enforcement
//     (ws.Session.handlePrompt's per-prompt check is).
//
// Everything past ResolveApp — hello/ack, prompt, tool_call/tool_query
// dispatch via AskInteraction, tool_result correlation, ping/pong, per-prompt
// quota enforcement — is exactly ws.Session's existing implementation. The
// frontend (apps/console/src/Playground.tsx) now speaks the real
// internal/protocol wire format instead of a hand-rolled subset.

// playgroundResolver implements ws.AppResolver for the console's Playground
// endpoint. See this file's package comment above for why Playground needs
// its own resolver instead of APIKeyResolver: authentication is a console
// session cookie plus app ownership, not an API key plus per-app origin.
type playgroundResolver struct {
	apps           *toolschema.Registry
	sessions       *session.Store
	consoleOrigins []string
	quota          *quota.Service // nil disables the handshake-time check below; per-prompt enforcement (ws.Session.handlePrompt) still applies regardless
	log            *slog.Logger
}

// ResolveApp implements ws.AppResolver. It is the WebSocket-handshake
// equivalent of withOwnedApp (see console.go): both require a valid session
// cookie and confirmed ownership of the {appId} path value, and both return
// 404 (not 401/403) for an unknown or not-owned app — the ownership check
// itself is shared (see ownedAppOrNotFound in console.go) so this and
// withOwnedApp can't drift apart; only the surrounding wrapper (an
// http.HandlerFunc there, an AppResolver here) differs, since the two
// signatures aren't compatible with each other.
//
// Origin is checked here too, since ws.Handler.CheckOrigin becomes a no-op
// whenever a Resolver is set (see that package's doc comment) — Playground's
// own notion of "allowed origin" is the console's origin allowlist, not any
// per-app one, so it has to be enforced inside this method rather than left
// to Handler.AllowedOrigins.
func (p *playgroundResolver) ResolveApp(r *http.Request) (appID, sessionID string, ok bool, msg string, code int) {
	// Defense-in-depth, not a documented mode: NewHandler always sets both
	// sessions and log (see console.go), so this shouldn't be reachable in
	// practice — but p.log.Warn/Info below would otherwise panic on a nil
	// *slog.Logger receiver, and p.sessions is dereferenced immediately
	// after. Fail closed with a generic message instead.
	if p.sessions == nil || p.log == nil {
		return "", "", false, "playground unavailable", http.StatusServiceUnavailable
	}
	if !originAllowed(r, p.consoleOrigins) {
		return "", "", false, "origin not allowed", http.StatusForbidden
	}

	// Cookie-only, no bearer-token fallback (unlike withAuth) — Playground is
	// only ever reached from a logged-in browser tab, never a CLI/script.
	// verifyUser is the same identity resolution withAuth/withCookieAuth use
	// (console.go) — shared for the same reason ownedAppOrNotFound is:
	// keeping only one implementation of "how do we resolve who's calling"
	// instead of two that must be kept in sync by hand.
	user, verified := verifyUser(p.sessions, nil, r)
	if !verified {
		return "", "", false, "not authenticated", http.StatusUnauthorized
	}

	appID = r.PathValue("appId")
	if !ownedAppOrNotFound(p.apps, user.ID, appID) {
		// 404, not 403 — see withOwnedApp's comment on why an app that
		// exists but belongs to someone else must look identical to one
		// that doesn't exist at all.
		return "", "", false, "unknown appId", http.StatusNotFound
	}

	// Cheap early gate, mirroring APIKeyResolver.ResolveApp: refuse to even
	// upgrade the connection if this app's owner is already over quota, so
	// an exhausted account can't keep opening fresh Playground sockets.
	// ws.Session.handlePrompt still enforces this per-prompt regardless —
	// that's the real backstop an owner can't bypass by reconnecting — this
	// is purely an earlier, cheaper rejection. A DB error here is fail-open
	// (log and allow), matching APIKeyResolver: a transient database blip
	// must not block an owner from testing their own app. Deliberately not
	// r.Context() for the same reason APIKeyResolver isn't either — see its
	// comment on quick-reconnect "context canceled" false positives.
	checkCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	dec, err := p.quota.Check(checkCtx, appID)
	cancel()
	if err != nil {
		p.log.Warn("playground handshake: quota check failed, allowing (fail-open)", "appId", appID, "err", err)
	} else if !dec.Allowed {
		p.log.Info("playground handshake rejected: owner over quota", "appId", appID, "used", dec.Used, "limit", dec.Limit)
		return "", "", false, "monthly quota exceeded for this app's plan", http.StatusTooManyRequests
	}

	// PG-<userID>-<appID> gives this playground run its own want
	// conversation transcript (see WantService.Complete's AgentID
	// switching), isolated both from the app's real end-user sessions and
	// from other developers' playground runs against the same app, and
	// stable across reconnects/page reloads for the same user+app.
	sessionID = fmt.Sprintf("PG-%d-%s", user.ID, appID)
	return appID, sessionID, true, "", 0
}

// originAllowed reports whether r's Origin header matches one of allowed
// exactly. Fail-closed on a missing Origin header — unlike APIKeyResolver
// (which must tolerate non-browser clients such as curl/server-to-server
// callers with no Origin header at all), Playground's own doc comment
// (this file's package comment) says it is only ever reached from a
// logged-in browser tab; a real browser always sends Origin on a
// cross-origin WebSocket handshake, so a missing header here means the
// request isn't what it claims to be, and should be rejected rather than
// let through.
func originAllowed(r *http.Request, allowed []string) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return false
	}
	for _, a := range allowed {
		if origin == a {
			return true
		}
	}
	return false
}

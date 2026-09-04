package ws

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
	"github.com/tim72117/onagent/internal/auth"
	"github.com/tim72117/onagent/internal/inference"
	"github.com/tim72117/onagent/internal/quota"
	"github.com/tim72117/onagent/internal/toolschema"
)

// Handler upgrades HTTP connections to WebSocket sessions. Unlike
// CORS-protected fetch/XHR, a WebSocket handshake is NOT gated by the
// browser: any page can attempt to open a connection to any origin. The
// server is the only line of defense, so AllowedOrigins is enforced here
// rather than left to browser behavior.
//
// Resolver, if set, is the other half of that defense: it decides which
// appId (and, optionally, which fixed session id) a connection is allowed to
// act as, rather than trusting whatever appId the client claims in its
// `hello` message (see session.go — the server-resolved appId from here
// always wins over that field). Two callers currently supply one: the real
// Agent Bridge SDK path (APIKeyResolver, below — one random session id per
// connection, per-app origin binding from the app's own configured
// allowedOrigin) and the console's Playground (internal/console's
// playgroundResolver — a stable "PG-<userID>-<appID>" session id so
// re-opening Playground for the same app resumes the same want conversation
// transcript, and the console's own origin allowlist rather than any
// per-app one, since Playground is reached from the console's origin, not
// the developer's site).
type Handler struct {
	Apps           *toolschema.Registry
	Inference      inference.Service
	Log            *slog.Logger
	AllowedOrigins OriginChecker
	Resolver       AppResolver    // nil disables auth: any appId is accepted, dev/mock mode only
	Quota          *quota.Service // nil disables quota enforcement (see quota.Service); handshake and per-prompt checks become no-ops

	upgrader websocket.Upgrader
}

// OriginChecker decides whether a WebSocket handshake from the given Origin
// header should be accepted.
type OriginChecker func(origin string) bool

// AllowAllOrigins accepts every origin. Only appropriate for local
// development; production deployments should pass a real allowlist backed
// by each developer app's registered domains.
func AllowAllOrigins(string) bool { return true }

// AppResolver decides which appId an incoming WebSocket handshake is allowed
// to act as, and (optionally) which id the resulting Session should use.
// Kept deliberately separate from OriginChecker (see Handler's doc comment):
// an implementation is free to do its own Origin-header check if its notion
// of "allowed" depends on which appId it resolved (see APIKeyResolver), but
// that's a property of this specific resolver, not something the AppResolver
// interface itself requires.
//
// IMPORTANT: whenever Handler.Resolver is non-nil, Handler.AllowedOrigins is
// NOT consulted at all — upgrader.CheckOrigin unconditionally returns true in
// that case (see NewHandler), on the assumption that ResolveApp does its own
// Origin check. Every AppResolver implementation MUST therefore verify
// Origin itself if it cares (both APIKeyResolver and internal/console's
// playgroundResolver do); a future implementation that skips this has no
// origin check at all, not a fallback to AllowedOrigins.
//
// sessionID may be "" to let Session pick a fresh random id (NewSession's
// default). ok=false rejects the handshake; msg and code (optional) are what
// the client sees.
type AppResolver interface {
	ResolveApp(r *http.Request) (appID, sessionID string, ok bool, msg string, code int)
}

// APIKeyResolver is the AppResolver the real Agent Bridge SDK path uses:
// the api key travels as a query parameter (browsers cannot attach custom
// headers to a WebSocket upgrade request — this is why TLS is not optional
// for any deployment that enables it, or the key would ride the wire, and
// often server access logs, in plaintext), and the app's own
// auth.Store-configured allowedOrigin is the only origin a connection
// presenting that key may come from — replaying a key stolen from one site
// must not work from another just because that other site is on some
// broader allowlist.
type APIKeyResolver struct {
	Auth  *auth.Store
	Apps  *toolschema.Registry
	Quota *quota.Service
	Log   *slog.Logger
}

func (a *APIKeyResolver) ResolveApp(r *http.Request) (appID, sessionID string, ok bool, msg string, code int) {
	// Defense-in-depth, not a documented mode: a misconstructed
	// APIKeyResolver (Auth/Log left nil — every real construction site sets
	// both, see cmd/server/main.go) would otherwise panic on this method's
	// first real line, taking down the single connection attempt (net/http
	// recovers per-handler-goroutine, so this can't crash the whole
	// process) with a nil-pointer trace instead of a clear rejection. Fail
	// closed with a generic message rather than surfacing which field was
	// nil to the client.
	if a.Auth == nil || a.Log == nil {
		return "", "", false, "auth unavailable", http.StatusServiceUnavailable
	}
	origin := r.Header.Get("Origin")
	token := r.URL.Query().Get("token")
	result, verified := a.Auth.Verify(token)
	if !verified {
		a.Log.Info("ws handshake rejected: invalid or missing token", "origin", origin)
		return "", "", false, "invalid or missing token", http.StatusUnauthorized
	}
	if _, known := a.Apps.Get(result.AppID); !known {
		a.Log.Warn("ws handshake rejected: token resolves to unknown appId", "appId", result.AppID)
		return "", "", false, "unknown app", http.StatusUnauthorized
	}
	// No origin configured means every connection for this app is rejected
	// (fail-closed) rather than falling back to some broader allowlist.
	if result.AllowedOrigin == "" {
		a.Log.Warn("ws handshake rejected: app has no allowed origin configured", "appId", result.AppID)
		return "", "", false, "app is not configured to accept connections from any site yet", http.StatusForbidden
	}
	if origin != result.AllowedOrigin {
		a.Log.Info("ws handshake rejected: origin does not match app's configured origin",
			"appId", result.AppID, "origin", origin, "allowedOrigin", result.AllowedOrigin)
		return "", "", false, "origin not allowed for this app", http.StatusForbidden
	}

	// Cheap early gate: refuse to even upgrade the connection if this app's
	// owner is already over quota, so an exhausted account can't keep
	// opening fresh sockets. This is the "handshake" half of the two-point
	// enforcement — Session.handlePrompt is the other half, covering a
	// connection that runs out mid-session (see its comment). A DB error
	// here is treated as fail-open (log and allow): a transient database
	// blip must not lock legitimate users out at the front door. 429
	// mirrors how HTTP APIs report rate/quota limits; the SDK sees the
	// handshake fail and its onError/reconnect path runs.
	//
	// Deliberately NOT r.Context(): that context is tied to this HTTP
	// request/upgrade, which can be canceled by the client disconnecting or
	// retrying the handshake before this query returns — observed in
	// practice as spurious "context canceled" fail-open warnings on every
	// quick reconnect, not an actual DB problem. A short-lived detached
	// context makes this check's lifetime match the query itself.
	checkCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	dec, err := a.Quota.Check(checkCtx, result.AppID)
	cancel()
	if err != nil {
		a.Log.Warn("ws handshake: quota check failed, allowing (fail-open)", "appId", result.AppID, "err", err)
	} else if !dec.Allowed {
		a.Log.Info("ws handshake rejected: owner over quota", "appId", result.AppID, "used", dec.Used, "limit", dec.Limit)
		return "", "", false, "monthly quota exceeded for this app's plan", http.StatusTooManyRequests
	}

	return result.AppID, "", true, "", 0
}

func NewHandler(apps *toolschema.Registry, infer inference.Service, log *slog.Logger, allowed OriginChecker, resolver AppResolver, quotaSvc *quota.Service) *Handler {
	h := &Handler{
		Apps:           apps,
		Inference:      infer,
		Log:            log,
		AllowedOrigins: allowed,
		Resolver:       resolver,
		Quota:          quotaSvc,
	}
	h.upgrader = websocket.Upgrader{
		ReadBufferSize:  4096,
		WriteBufferSize: 4096,
		CheckOrigin: func(r *http.Request) bool {
			if h.Resolver != nil {
				// APIKeyResolver.ResolveApp (or an equivalent) already ran
				// and fully decided this by the time Upgrade() gets here:
				// per-app origin binding is strictly narrower and
				// self-service than any global allowlist could be.
				// AllowedOrigins stays the real gate for /console and /auth
				// (withCORS), and for the no-resolver fallback below.
				return true
			}
			origin := r.Header.Get("Origin")
			if origin == "" {
				// Non-browser clients (curl, server-to-server) send no
				// Origin header; allow them through to the app-level
				// appId check in the hello message instead.
				return true
			}
			return h.AllowedOrigins(origin)
		},
	}
	return h
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var appID, sessionID string
	if h.Resolver != nil {
		var ok bool
		var msg string
		var code int
		appID, sessionID, ok, msg, code = h.Resolver.ResolveApp(r)
		if !ok {
			http.Error(w, msg, code)
			return
		}
	}

	conn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		h.Log.Info("ws upgrade rejected", "err", err, "origin", r.Header.Get("Origin"))
		return
	}
	NewSession(r.Context(), conn, h.Apps, h.Inference, h.Log, appID, h.Quota, sessionID)
}

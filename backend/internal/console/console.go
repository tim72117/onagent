// Package console exposes the API the console front-end (or any other
// client) uses for developers to register/log in and manage their own
// apps: creating them, editing tool definitions and the agent Thought, and
// issuing/revoking API keys. This is not an administrator-only surface —
// every registered user gets one, scoped to the apps they created.
//
// Every route (other than /auth/register and /auth/login themselves)
// requires either a valid session cookie (internal/session, for the
// browser console) or a bearer token (internal/usertoken, for CLI/script
// access) — see withAuth. Every app-scoped operation additionally checks
// that the calling user owns the app before touching it; this ownership
// check is the actual multi-tenant boundary, applied identically
// regardless of which of the two auth methods resolved the caller. There
// is no super-admin override: a user can only ever see and modify apps
// they created.
// (An earlier version of this package used one shared ADMIN_TOKEN with no
// per-app ownership at all, and was named "admin" — misleading, since it's
// every developer's own workspace, not an operator-only console.)
package console

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/tim72117/onagent/internal/auth"
	"github.com/tim72117/onagent/internal/cliauth"
	"github.com/tim72117/onagent/internal/inference"
	"github.com/tim72117/onagent/internal/quota"
	"github.com/tim72117/onagent/internal/session"
	"github.com/tim72117/onagent/internal/toolschema"
	"github.com/tim72117/onagent/internal/usertoken"
	"github.com/tim72117/onagent/internal/ws"
)

// accountLifecycle is the subset of *session.Store's methods console.go's
// register/login/logout handlers need — Verify is deliberately not part of
// this (it's cookieVerifier's job instead, used via verifyUser) since that's
// a different concern (authenticating an existing request) from these
// (creating/ending a session). Handler.Session is typed as this interface,
// not *session.Store directly, purely for unit-testability — see
// cookieVerifier's doc comment for the same rationale applied to auth
// itself. *session.Store satisfies both interfaces simultaneously; nothing
// about its own implementation changes.
type accountLifecycle interface {
	Register(email, password string) (*session.User, error)
	Login(email, password string) (*session.User, error)
	CreateSession(w http.ResponseWriter, userID int64) (string, error)
	Logout(w http.ResponseWriter, r *http.Request)
}

// tokenLifecycle is the subset of *usertoken.Store's methods console.go's
// token-management handlers (issueToken/listTokens/revokeToken) need —
// Verify is, again, tokenVerifier's job instead (see accountLifecycle's
// doc comment for the identical split on the session side).
type tokenLifecycle interface {
	Issue(userID int64, name string) (id int64, plaintext string, err error)
	List(userID int64) ([]usertoken.Token, error)
	Revoke(userID, tokenID int64) error
}

// Handler serves the /console/* and /auth/* APIs.
type Handler struct {
	Apps    *toolschema.Registry
	Auth    *auth.Store
	Session accountLifecycle
	Tokens  tokenLifecycle
	// sessionVerify/tokenVerify/appOwner are the same underlying
	// *session.Store/*usertoken.Store/*toolschema.Registry as Session/
	// Tokens/Apps above, seen through the narrower cookieVerifier/
	// tokenVerifier/appOwnerLookup interfaces withAuth/withCookieAuth/
	// withOwnedApp's verifyUser/ownedAppOrNotFound calls need. Separate
	// fields instead of widening accountLifecycle/tokenLifecycle (or typing
	// Apps as an interface everywhere) so each call site keeps depending on
	// only the methods it actually uses — see verifyUser's and
	// accountLifecycle's doc comments; Apps itself stays a concrete
	// *toolschema.Registry since the other ~10 call sites in this package
	// need its full method set (Get/Save/Create/Delete/...), not just
	// OwnerOf. Set once in NewHandler; all three point at the same objects
	// as Session/Tokens/Apps for the lifetime of this Handler.
	sessionVerify cookieVerifier
	tokenVerify   tokenVerifier
	appOwner      appOwnerLookup
	CliAuth       *cliauth.Store
	Inference     inference.Service // used to construct the Playground ws.Handler (see playgroundWS)
	Quota         *quota.Service    // nil disables enforcement; playground prompts count against the owner's quota like real traffic
	// ConsoleOrigins is the set of origins the console front-end itself is
	// served from (e.g. http://localhost:5173 in dev). Used only by
	// playgroundResolver (playground.go) to accept the Playground
	// WebSocket's cross-origin handshake — the console (this API's own
	// frontend) and this backend almost never share a host:port, even in
	// dev, so ws.Handler's default same-origin-ish behavior would reject
	// every real Playground connection unless these are explicitly trusted.
	ConsoleOrigins []string

	// playgroundWS is the shared internal/ws.Handler that serves
	// GET /console/apps/{appId}/playground — see playground.go's package
	// comment for why Playground reuses ws.Session instead of its own
	// connection-management code. Built once in NewHandler.
	playgroundWS *ws.Handler
}

func NewHandler(apps *toolschema.Registry, authStore *auth.Store, sessionStore *session.Store, tokenStore *usertoken.Store, cliAuthStore *cliauth.Store, inferSvc inference.Service, quotaSvc *quota.Service, consoleOrigins []string, log *slog.Logger) *Handler {
	h := &Handler{
		Apps: apps, appOwner: apps, Auth: authStore,
		Session: sessionStore, sessionVerify: sessionStore,
		Tokens: tokenStore, tokenVerify: tokenStore,
		CliAuth: cliAuthStore, Inference: inferSvc, Quota: quotaSvc, ConsoleOrigins: consoleOrigins,
	}

	resolver := &playgroundResolver{apps: apps, sessions: sessionStore, consoleOrigins: consoleOrigins, quota: quotaSvc, log: log}
	h.playgroundWS = ws.NewHandler(apps, inferSvc, log, ws.AllowAllOrigins, resolver, quotaSvc)
	return h
}

// syncWantRole re-registers appID's want agent role (tool whitelist +
// Thought) so an edit takes effect on the very next prompt, without a
// restart. Called after every successful write that changes what an app's
// agent should see/say (create, save tools, set thought) — see
// inference.RegisterAppRole's doc comment for what happens if this is
// skipped. A no-op-safe best-effort: if the Registry's cache hasn't
// reflected the write yet (shouldn't happen — Registry.Save/Create both
// Reload before returning), this silently does nothing rather than
// panicking, since a stale want role is a correctness bug to fix, not a
// reason to fail the HTTP request that already succeeded.
func (h *Handler) syncWantRole(appID string) {
	if app, ok := h.Apps.Get(appID); ok {
		inference.RegisterAppRole(app)
	}
}

// Register mounts the auth and console routes on mux.
func (h *Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc("POST /auth/register", h.register)
	mux.HandleFunc("POST /auth/login", h.login)
	mux.HandleFunc("POST /auth/logout", h.logout)
	mux.HandleFunc("GET /auth/me", h.withAuth(h.me))

	mux.HandleFunc("GET /console/quota", h.withAuth(h.getQuota))

	mux.HandleFunc("GET /console/apps", h.withAuth(h.listApps))
	mux.HandleFunc("POST /console/apps", h.withAuth(h.createApp))
	mux.HandleFunc("GET /console/apps/{appId}", h.withOwnedApp(h.getApp))
	mux.HandleFunc("PUT /console/apps/{appId}/tools", h.withOwnedApp(h.saveTools))
	mux.HandleFunc("PUT /console/apps/{appId}/origin", h.withOwnedApp(h.setOrigin))
	mux.HandleFunc("PUT /console/apps/{appId}/thought", h.withOwnedApp(h.setThought))
	mux.HandleFunc("DELETE /console/apps/{appId}", h.withOwnedApp(h.deleteApp))
	mux.HandleFunc("POST /console/apps/{appId}/key", h.withOwnedApp(h.issueKey))
	mux.HandleFunc("DELETE /console/apps/{appId}/key", h.withOwnedApp(h.revokeKey))
	// Not h.withOwnedApp: session-cookie verification and app-ownership
	// checks are done inside playgroundResolver.ResolveApp instead (see
	// playground.go), because ws.Handler.ServeHTTP needs to run its own
	// AppResolver before upgrading the connection — withOwnedApp's
	// http.HandlerFunc-wrapper shape has no hook for that. This is not a
	// weaker check than withOwnedApp: it verifies the same session cookie
	// and the same ownerID == user.ID comparison, just inlined into
	// ResolveApp rather than composed via the wrapper.
	mux.Handle("GET /console/apps/{appId}/playground", h.playgroundWS)

	// issueToken and approveCliAuth are withCookieAuth, not withAuth: both
	// mint a new bearer token, and if a bearer token itself could
	// authorize minting more of them, one leaked token would let an
	// attacker mint unlimited replacements — revoking the token that
	// leaked wouldn't cut off access, the attacker just switches to one
	// minted before the victim noticed. Requiring the browser session
	// (which a CLI never holds beyond the moment it trades it for a
	// token) breaks that chain. Listing/revoking stay on withAuth since
	// neither compounds access — revoking is self-limiting no matter
	// which credential requested it.
	mux.HandleFunc("POST /console/tokens", h.withCookieAuth(h.issueToken))
	mux.HandleFunc("GET /console/tokens", h.withAuth(h.listTokens))
	mux.HandleFunc("DELETE /console/tokens/{tokenId}", h.withAuth(h.revokeToken))

	// start and exchange are unauthenticated by design — see
	// internal/cliauth's package doc for why the session id itself (32
	// random bytes, single-use) is the right credential for each: Start
	// happens before the CLI has any credential at all, and Exchange's id
	// only ever works once, right after a legitimate approval, for
	// whoever holds the id the CLI itself generated the URL from.
	mux.HandleFunc("POST /console/cli-auth/start", h.startCliAuth)
	mux.HandleFunc("GET /console/cli-auth/{id}", h.getCliAuth)
	mux.HandleFunc("POST /console/cli-auth/{id}/approve", h.withCookieAuth(h.approveCliAuth))
	mux.HandleFunc("POST /console/cli-auth/{id}/exchange", h.exchangeCliAuth)
}

// cookieVerifier and tokenVerifier are the minimal shapes withAuth/
// withCookieAuth/playgroundResolver actually need from *session.Store and
// *usertoken.Store, respectively — not full interfaces for those packages,
// just enough surface for the pure functions below (verifyUser,
// ownedAppOrNotFound) to be exercised with a fake in a unit test, without
// touching how Handler stores its real *session.Store/*usertoken.Store/
// *toolschema.Registry fields (those stay concrete types: this package has
// exactly one real implementation of each, and widening every call site to
// an interface for testability elsewhere would be a much bigger, unrelated
// change — see docs/audit-functional.md's entry on this tradeoff).
// tokenVerifier.Verify returns *usertoken.User (a different concrete type
// than cookieVerifier.Verify's *session.User — see verifyUser for the
// conversion between them).
type cookieVerifier interface {
	Verify(r *http.Request) (*session.User, bool)
}
type tokenVerifier interface {
	Verify(r *http.Request) (*usertoken.User, bool)
}
type appOwnerLookup interface {
	OwnerOf(appID string) (ownerID int64, ok bool)
}

// verifyUser resolves the caller's identity from r — a session cookie via
// cookies first (the browser console's path), falling back to a bearer
// token via tokens (the CLI's path) — normalizing both onto *session.User so
// callers never need to know which method authenticated the caller. tokens
// may be nil to skip the fallback entirely (see withCookieAuth, which needs
// cookie-only verification).
//
// A pure function deliberately independent of http.HandlerFunc or any
// particular wrapper shape (compare playgroundResolver.ResolveApp in
// playground.go, which needs the same identity resolution but a completely
// different surrounding signature) — this is what actually lets withAuth's
// logic be unit-tested with a fake cookieVerifier/tokenVerifier instead of a
// live database.
func verifyUser(cookies cookieVerifier, tokens tokenVerifier, r *http.Request) (*session.User, bool) {
	if user, ok := cookies.Verify(r); ok {
		return user, true
	}
	if tokens != nil {
		if u, ok := tokens.Verify(r); ok {
			return &session.User{ID: u.ID, Email: u.Email}, true
		}
	}
	return nil, false
}

// withAuth resolves the caller's identity — a session cookie first (the
// browser console's path), falling back to a bearer token
// (internal/usertoken, the CLI's path) — and rejects the request if
// neither resolves. Handlers downstream see a single *session.User either
// way; they never need to know which method authenticated the caller.
func (h *Handler) withAuth(next func(http.ResponseWriter, *http.Request, *session.User)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := verifyUser(h.sessionVerify, h.tokenVerify, r)
		if !ok {
			http.Error(w, "not authenticated", http.StatusUnauthorized)
			return
		}
		next(w, r, user)
	}
}

// withCookieAuth is withAuth restricted to the session cookie only, no
// bearer-token fallback — see the Register call sites for why this
// matters specifically for token-minting routes.
func (h *Handler) withCookieAuth(next func(http.ResponseWriter, *http.Request, *session.User)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := verifyUser(h.sessionVerify, nil, r)
		if !ok {
			http.Error(w, "not authenticated", http.StatusUnauthorized)
			return
		}
		next(w, r, user)
	}
}

// ownedAppOrNotFound reports whether userID owns appID, per apps.OwnerOf.
// Shared by withOwnedApp and playgroundResolver.ResolveApp (internal/console/
// playground.go) — the two can't share the same wrapper function (one is an
// http.HandlerFunc middleware, the other implements ws.AppResolver's very
// different signature), but the ownership check itself, and its
// leak-no-information rationale, must stay identical between them: a
// nonexistent appId and an appId owned by someone else both must be
// indistinguishable to the caller (see withOwnedApp's own doc comment on why
// that's 404, not 403). Pulling just this check into one function means a
// future change to how ownership is determined only has one place to edit,
// instead of two call sites that must be kept in sync by hand. Takes
// appOwnerLookup (not *toolschema.Registry directly) for the same
// unit-testability reason verifyUser takes cookieVerifier/tokenVerifier.
func ownedAppOrNotFound(apps appOwnerLookup, userID int64, appID string) bool {
	ownerID, known := apps.OwnerOf(appID)
	return known && ownerID == userID
}

// withOwnedApp is withAuth plus an ownership check on the {appId} path
// value: the request is rejected before the handler runs at all if the
// session's user doesn't own that app. Handlers behind this are guaranteed
// both an authenticated user and confirmed ownership.
//
// A nonexistent appId and an appId owned by someone else both produce 404,
// not 403 — a 403 would confirm to a prober "this app exists, you just
// can't touch it," leaking which app ids are taken.
func (h *Handler) withOwnedApp(next func(http.ResponseWriter, *http.Request, *session.User)) http.HandlerFunc {
	return h.withAuth(func(w http.ResponseWriter, r *http.Request, user *session.User) {
		appID := r.PathValue("appId")
		if !ownedAppOrNotFound(h.appOwner, user.ID, appID) {
			http.Error(w, "unknown appId", http.StatusNotFound)
			return
		}
		next(w, r, user)
	})
}

// --- auth ----------------------------------------------------------------

type authRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type authResponse struct {
	Email string `json:"email"`
}

func (h *Handler) register(w http.ResponseWriter, r *http.Request) {
	var req authRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}

	user, err := h.Session.Register(req.Email, req.Password)
	if err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, session.ErrEmailTaken) {
			status = http.StatusConflict
		}
		http.Error(w, err.Error(), status)
		return
	}

	if _, err := h.Session.CreateSession(w, user.ID); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusCreated, authResponse{Email: user.Email})
}

func (h *Handler) login(w http.ResponseWriter, r *http.Request) {
	var req authRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}

	user, err := h.Session.Login(req.Email, req.Password)
	if err != nil {
		http.Error(w, err.Error(), http.StatusUnauthorized)
		return
	}

	if _, err := h.Session.CreateSession(w, user.ID); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, authResponse{Email: user.Email})
}

func (h *Handler) logout(w http.ResponseWriter, r *http.Request) {
	h.Session.Logout(w, r)
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) me(w http.ResponseWriter, r *http.Request, user *session.User) {
	writeJSON(w, http.StatusOK, authResponse{Email: user.Email})
}

// --- quota -----------------------------------------------------------------

// quotaResponse is the caller's own plan + usage-this-period standing.
// Field names mirror quota.UserSummary (the admin back-office's per-user
// shape returned by GET /admin/api/users) — tier/limit/used name the same
// facts there and here, so the two surfaces don't invent different
// vocabulary for the same numbers. periodStart/periodEnd are RFC 3339
// (encoding/json's default time.Time marshaling) since nothing else in this
// package needs a different format for a timestamp.
//
// Enabled is false when this deployment runs with QUOTA_ENABLED=false (see
// cmd/server/main.go) — every other field is the zero value in that case,
// never meaningful data a caller should render. This is a real, expected
// deployment state (self-hosters running onagent as their own
// infrastructure have no reason to enforce onagent's own SaaS tiers against
// themselves), not a failure — see getQuota below for why that distinction
// matters.
type quotaResponse struct {
	Enabled     bool      `json:"enabled"`
	Tier        string    `json:"tier,omitempty"`
	PlanName    string    `json:"planName,omitempty"`
	Limit       int       `json:"limit,omitempty"`
	Used        int       `json:"used,omitempty"`
	PeriodStart time.Time `json:"periodStart,omitempty"`
	PeriodEnd   time.Time `json:"periodEnd,omitempty"`
}

// getQuota reports the calling developer's own plan and current-period
// usage. Scoped to the account (user), not to a single app: quota is billed
// per owner across every app they have, matching how quota.Check/Record
// already enforce it — see quota.Service.StandingFor's doc comment. No app
// ownership check applies here (unlike the /console/apps/{appId}/* routes)
// since there is no {appId} in this path at all.
//
// h.Quota == nil (QUOTA_ENABLED=false) is reported as a normal 200 with
// enabled=false, not an error status — it's an intentional deployment
// choice, and treating it as a 500 would both mislead error-rate monitoring
// and make the console frontend's "hide the quota widget" decision harder
// to distinguish from "the request actually failed."
func (h *Handler) getQuota(w http.ResponseWriter, r *http.Request, user *session.User) {
	if h.Quota == nil {
		writeJSON(w, http.StatusOK, quotaResponse{Enabled: false})
		return
	}
	st, err := h.Quota.StandingFor(r.Context(), user.ID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, quotaResponse{
		Enabled:     true,
		Tier:        string(st.Tier),
		PlanName:    st.PlanName,
		Limit:       st.Limit,
		Used:        st.Used,
		PeriodStart: st.PeriodStart,
		PeriodEnd:   st.PeriodEnd,
	})
}

// --- apps ------------------------------------------------------------------

// appSummary is what listApps returns per app: enough for a dashboard list
// view without shipping every tool's full schema.
type appSummary struct {
	AppID         string `json:"appId"`
	ToolCount     int    `json:"toolCount"`
	HasKey        bool   `json:"hasKey"`
	AllowedOrigin string `json:"allowedOrigin"` // "" means unset (fail-closed — see ws.Handler.ServeHTTP)
	Thought       string `json:"thought"`       // "" means the platform default applies (agent_roles.go's defaultThought)
}

func (h *Handler) listApps(w http.ResponseWriter, r *http.Request, user *session.User) {
	ids, err := h.Apps.OwnedBy(user.ID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	out := make([]appSummary, 0, len(ids))
	for _, id := range ids {
		app, ok := h.Apps.Get(id)
		if !ok {
			continue // owner_id row exists but Registry cache hasn't caught up; skip rather than fake zero tools
		}
		out = append(out, appSummary{
			AppID:         id,
			ToolCount:     len(app.Tools),
			HasKey:        h.Auth.HasKey(id),
			AllowedOrigin: h.Auth.OriginFor(id),
			Thought:       app.Thought,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// getApp returns the full App definition (every tool with its complete
// parameter and returns schema). The editor loads this for editing — the
// public /apps/{appId}/tools.json can't serve that purpose because its
// LLM-schema shape drops the returns declaration.
func (h *Handler) getApp(w http.ResponseWriter, r *http.Request, user *session.User) {
	app, _ := h.Apps.Get(r.PathValue("appId")) // ownership + existence already checked by withOwnedApp
	writeJSON(w, http.StatusOK, app)
}

type createAppRequest struct {
	AppID string `json:"appId"`
}

func (h *Handler) createApp(w http.ResponseWriter, r *http.Request, user *session.User) {
	var req createAppRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}

	if err := h.Apps.Create(req.AppID, user.ID); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	h.syncWantRole(req.AppID)
	writeJSON(w, http.StatusCreated, appSummary{AppID: req.AppID, ToolCount: 0, HasKey: false})
}

type setOriginRequest struct {
	// Origin is the exact value the site's Origin header must present, e.g.
	// "https://demo.example.com" (no path, no trailing slash — that's what
	// browsers actually send). Empty string clears it, returning the app to
	// fail-closed (no connections accepted) until set again.
	Origin string `json:"origin"`
}

func (h *Handler) setOrigin(w http.ResponseWriter, r *http.Request, user *session.User) {
	appID := r.PathValue("appId")

	var req setOriginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}

	if err := h.Auth.SetOrigin(appID, req.Origin); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	app, _ := h.Apps.Get(appID)
	writeJSON(w, http.StatusOK, appSummary{
		AppID:         appID,
		ToolCount:     len(app.Tools),
		HasKey:        h.Auth.HasKey(appID),
		AllowedOrigin: req.Origin,
		Thought:       app.Thought,
	})
}

type setThoughtRequest struct {
	// Thought is the app's custom want agent system prompt. Empty string
	// clears it, returning the app to the platform default.
	Thought string `json:"thought"`
}

func (h *Handler) setThought(w http.ResponseWriter, r *http.Request, user *session.User) {
	appID := r.PathValue("appId")

	var req setThoughtRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}

	if err := h.Apps.SetThought(appID, req.Thought); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	h.syncWantRole(appID)
	app, _ := h.Apps.Get(appID)
	writeJSON(w, http.StatusOK, appSummary{
		AppID:         appID,
		ToolCount:     len(app.Tools),
		HasKey:        h.Auth.HasKey(appID),
		AllowedOrigin: h.Auth.OriginFor(appID),
		Thought:       req.Thought,
	})
}

func (h *Handler) saveTools(w http.ResponseWriter, r *http.Request, user *session.User) {
	appID := r.PathValue("appId")

	var tools []toolschema.Tool
	if err := json.NewDecoder(r.Body).Decode(&tools); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}

	app := &toolschema.App{AppID: appID, Tools: tools}
	if err := h.Apps.Save(app); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	h.syncWantRole(appID)
	saved, _ := h.Apps.Get(appID) // Save's own Reload already refreshed this; existing thought is untouched by saveApp (see registry.go)
	writeJSON(w, http.StatusOK, appSummary{
		AppID:         appID,
		ToolCount:     len(tools),
		HasKey:        h.Auth.HasKey(appID),
		AllowedOrigin: h.Auth.OriginFor(appID),
		Thought:       saved.Thought,
	})
}

func (h *Handler) deleteApp(w http.ResponseWriter, r *http.Request, user *session.User) {
	appID := r.PathValue("appId")
	if err := h.Apps.Delete(appID); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if err := h.Auth.Revoke(appID); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type issueKeyResponse struct {
	AppID  string `json:"appId"`
	ApiKey string `json:"apiKey"` // plaintext — shown exactly once, never retrievable again
}

func (h *Handler) issueKey(w http.ResponseWriter, r *http.Request, user *session.User) {
	appID := r.PathValue("appId")
	key, err := h.Auth.Issue(appID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, issueKeyResponse{AppID: appID, ApiKey: key})
}

func (h *Handler) revokeKey(w http.ResponseWriter, r *http.Request, user *session.User) {
	appID := r.PathValue("appId")
	if err := h.Auth.Revoke(appID); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- user tokens (CLI/script auth) ------------------------------------------

type issueTokenRequest struct {
	// Name is a human label distinguishing this token from a user's other
	// ones, e.g. "laptop" or "ci" — shown back in listTokens so a user can
	// tell which one to revoke without having kept the plaintext.
	Name string `json:"name"`
}

type issueTokenResponse struct {
	ID    int64  `json:"id"`
	Name  string `json:"name"`
	Token string `json:"token"` // plaintext — shown exactly once, never retrievable again
}

func (h *Handler) issueToken(w http.ResponseWriter, r *http.Request, user *session.User) {
	var req issueTokenRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}

	id, token, err := h.Tokens.Issue(user.ID, req.Name)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	writeJSON(w, http.StatusCreated, issueTokenResponse{ID: id, Name: req.Name, Token: token})
}

func (h *Handler) listTokens(w http.ResponseWriter, r *http.Request, user *session.User) {
	tokens, err := h.Tokens.List(user.ID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, tokens)
}

func (h *Handler) revokeToken(w http.ResponseWriter, r *http.Request, user *session.User) {
	tokenID, err := strconv.ParseInt(r.PathValue("tokenId"), 10, 64)
	if err != nil {
		http.Error(w, "invalid tokenId", http.StatusBadRequest)
		return
	}
	if err := h.Tokens.Revoke(user.ID, tokenID); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- CLI browser login (onagent login --web) -----------------------------------
//
// Four routes implement the handoff described in internal/cliauth's
// package doc: the CLI registers its (validated, loopback-only)
// redirect_uri out of band via start, before it has any credential at
// all; the browser only ever carries the resulting opaque id; approve
// mints the actual token server-side once the user consents; and the
// CLI's own local callback server collects it via exchange, once, right
// after the browser redirects back with that id.

type startCliAuthRequest struct {
	RedirectURI string `json:"redirectUri"`
	Name        string `json:"name"`
}

type startCliAuthResponse struct {
	ID string `json:"id"`
}

func (h *Handler) startCliAuth(w http.ResponseWriter, r *http.Request) {
	var req startCliAuthRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}
	id, err := h.CliAuth.Start(req.RedirectURI, req.Name)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusCreated, startCliAuthResponse{ID: id})
}

type getCliAuthResponse struct {
	// Name is the only thing this endpoint reveals about a session —
	// enough for CliAuthPage to render "the {name} CLI wants to sign in"
	// without needing redirect_uri (or anything else sensitive) in the
	// page's own URL or any response a page script can read.
	Name string `json:"name"`
}

func (h *Handler) getCliAuth(w http.ResponseWriter, r *http.Request) {
	name, ok := h.CliAuth.NameFor(r.PathValue("id"))
	if !ok {
		http.Error(w, "unknown or expired session", http.StatusNotFound)
		return
	}
	writeJSON(w, http.StatusOK, getCliAuthResponse{Name: name})
}

type approveCliAuthResponse struct {
	// RedirectURI is where the front-end sends the browser next (with
	// ?code={id} appended) — looked up server-side from what start
	// registered, never re-derived from the page's own URL.
	RedirectURI string `json:"redirectUri"`
}

func (h *Handler) approveCliAuth(w http.ResponseWriter, r *http.Request, user *session.User) {
	id := r.PathValue("id")

	name, ok := h.CliAuth.NameFor(id)
	if !ok {
		http.Error(w, "unknown or expired session", http.StatusNotFound)
		return
	}

	_, token, err := h.Tokens.Issue(user.ID, name)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	redirectURI, ok := h.CliAuth.Approve(id, token)
	if !ok {
		// The minted token above was never persisted anywhere or shown to
		// anyone — Approve failing just means it's discarded here, not a
		// leak. See Approve's doc comment for why double-approval is
		// rejected rather than re-collected.
		http.Error(w, "session already used or expired", http.StatusConflict)
		return
	}
	writeJSON(w, http.StatusOK, approveCliAuthResponse{RedirectURI: redirectURI})
}

type exchangeCliAuthResponse struct {
	Token string `json:"token"` // plaintext — shown exactly once, never retrievable again
}

func (h *Handler) exchangeCliAuth(w http.ResponseWriter, r *http.Request) {
	token, ok := h.CliAuth.Exchange(r.PathValue("id"))
	if !ok {
		http.Error(w, "not approved yet, or already collected", http.StatusNotFound)
		return
	}
	writeJSON(w, http.StatusOK, exchangeCliAuthResponse{Token: token})
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

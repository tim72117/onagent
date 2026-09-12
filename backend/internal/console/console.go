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
	"fmt"
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
	// Two addressing schemes for the same underlying Registry.SaveTool/
	// DeleteTool (see those methods' own doc comments): {toolName} is the
	// CLI's route (`onagent tool create` writes a hand-authored tool.yaml
	// that has no id, so it upserts by name) and also covers a
	// brand-new tool from the console editor that has never been saved
	// (Tool.ID == 0 both ways). id/{toolId} is the console editor's route
	// once a tool has been saved at least once and the editor holds onto
	// its id — this is what makes a rename a single atomic UPDATE instead
	// of the old delete-old-name-then-insert-new-name two-step (see
	// toolschema.saveTool's doc comment for the bug that motivated this).
	// Registered as a literal path segment ("tools/id/...") rather than a
	// second {toolId} wildcard segment directly under "tools/" — Go's
	// ServeMux forbids two patterns that could both match the same request
	// path (tools/{toolName} and tools/{toolId} are indistinguishable to
	// the router), so "id" has to be a fixed prefix a real tool name can
	// never collide with (nameRE requires the first character be a letter
	// or underscore, and "id" itself is a valid name — but the ROUTE
	// segment "id" is fixed text, not a wildcard, so this is unambiguous:
	// PUT .../tools/id/42 always means "id 42", never "a tool literally
	// named id").
	mux.HandleFunc("PUT /console/apps/{appId}/tools/{toolName}", h.withOwnedApp(h.saveTool))
	mux.HandleFunc("DELETE /console/apps/{appId}/tools/{toolName}", h.withOwnedApp(h.deleteTool))
	mux.HandleFunc("PUT /console/apps/{appId}/tools/id/{toolId}", h.withOwnedApp(h.saveToolByID))
	mux.HandleFunc("DELETE /console/apps/{appId}/tools/id/{toolId}", h.withOwnedApp(h.deleteToolByID))
	mux.HandleFunc("PUT /console/apps/{appId}/origin", h.withOwnedApp(h.setOrigin))
	mux.HandleFunc("PUT /console/apps/{appId}/thought", h.withOwnedApp(h.setThought))
	mux.HandleFunc("PUT /console/apps/{appId}/max-prompt-length", h.withOwnedApp(h.setMaxPromptLength))
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
	// Get is also on appOwnerLookup (rather than a separate interface) so
	// ownedOrPublicApp can check App.Public through the same narrow surface
	// ownedAppOrNotFound already uses — see ownedOrPublicApp's doc comment
	// for why Playground needs this and withOwnedApp/ownedAppOrNotFound
	// deliberately do not.
	Get(appID string) (app *toolschema.App, ok bool)
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

// ownedOrPublicApp reports whether userID owns appID OR appID is marked
// Public (toolschema.App.Public) — the Playground's own ownership check
// (playground.go's playgroundResolver.ResolveApp), deliberately separate
// from ownedAppOrNotFound/withOwnedApp so marking an app public can never
// accidentally loosen a REST API operation. Every REST route that edits an
// app (save tools, set origin, delete, issue/revoke key — see Register)
// stays behind withOwnedApp's strict ownedAppOrNotFound unconditionally: a
// public app is one its owner has opted to let other signed-in users try in
// Playground, not one anyone can edit. Only Playground calls this.
func ownedOrPublicApp(apps appOwnerLookup, userID int64, appID string) bool {
	if ownedAppOrNotFound(apps, userID, appID) {
		return true
	}
	app, ok := apps.Get(appID)
	return ok && app.Public
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
	if !decodeJSON(w, r, &req) {
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
	if !decodeJSON(w, r, &req) {
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
// Limit/Used are deliberately NOT `omitempty` — encoding/json's omitempty on
// an int drops the field entirely when it's 0, but 0 is a real, meaningful
// value here (a brand-new account has genuinely used 0 prompts; a plan
// could in principle have a 0 allowance) and must round-trip as "0", not be
// silently absent from the response. Tier/PlanName/PeriodStart/PeriodEnd
// keep omitempty since their zero values ("" / the zero time.Time) only
// ever occur when Enabled is false, and the frontend never reads them then.
type quotaResponse struct {
	Enabled  bool   `json:"enabled"`
	Tier     string `json:"tier,omitempty"`
	PlanName string `json:"planName,omitempty"`
	Limit    int    `json:"limit"`
	Used     int    `json:"used"`
	// UsedPercent is Used/Limit*100, computed here so the console SPA
	// doesn't each re-derive the same division (and doesn't need its own
	// divide-by-zero guard for the Limit==0 edge case — an explicit
	// per-user override of 0, or an unresolvable owner where Standing
	// itself reports Limit 0). Rounded to the nearest integer; callers
	// wanting sub-percent precision should compute it themselves from
	// Used/Limit instead. 0 when Limit is 0, rather than NaN/Inf.
	UsedPercent int       `json:"usedPercent"`
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
	var usedPercent int
	if st.Limit > 0 {
		// Integer rounding (not truncation): +Limit/2 before dividing shifts
		// .5-and-up up to the next integer, matching how a percentage bar in
		// the UI should read (e.g. 999_950/1_000_000 displays as "100%", not
		// a truncated "99%", once past the halfway point of the last percent).
		usedPercent = (st.Used*100 + st.Limit/2) / st.Limit
	}
	writeJSON(w, http.StatusOK, quotaResponse{
		Enabled:     true,
		Tier:        string(st.Tier),
		PlanName:    st.PlanName,
		Limit:       st.Limit,
		Used:        st.Used,
		UsedPercent: usedPercent,
		PeriodStart: st.PeriodStart,
		PeriodEnd:   st.PeriodEnd,
	})
}

// --- apps ------------------------------------------------------------------

// appSummary is what listApps returns per app: enough for a dashboard list
// view without shipping every tool's full schema.
type appSummary struct {
	AppID           string   `json:"appId"`
	ToolCount       int      `json:"toolCount"`
	HasKey          bool     `json:"hasKey"`
	AllowedOrigins  []string `json:"allowedOrigins"`  // empty/nil means unset (fail-closed — see ws.Handler.ServeHTTP)
	Thought         string   `json:"thought"`         // "" means the platform default applies (agent_roles.go's defaultThought)
	MaxPromptLength *int     `json:"maxPromptLength"` // nil means the system-wide default applies (inference.EffectiveMaxPromptLength)
}

// appSummaryJSON is appSummary's actual wire shape — see MarshalJSON below.
type appSummaryJSON struct {
	AppID                 string   `json:"appId"`
	ToolCount             int      `json:"toolCount"`
	HasKey                bool     `json:"hasKey"`
	AllowedOrigins        []string `json:"allowedOrigins"`
	Thought               string   `json:"thought"`
	MaxPromptLength       *int     `json:"maxPromptLength"`
	SystemMaxPromptLength int      `json:"systemMaxPromptLength"`
}

// MarshalJSON adds SystemMaxPromptLength (inference.SystemMaxPromptLength,
// the same value for every app in the process) to every appSummary response
// without every one of this file's ~9 appSummary{} construction sites
// needing to set it individually — the console UI uses it as an "if you
// clear your own limit, this is what applies" number to show alongside the
// per-app MaxPromptLength field, e.g. as an input's placeholder.
func (a appSummary) MarshalJSON() ([]byte, error) {
	return json.Marshal(appSummaryJSON{
		AppID:                 a.AppID,
		ToolCount:             a.ToolCount,
		HasKey:                a.HasKey,
		AllowedOrigins:        a.AllowedOrigins,
		Thought:               a.Thought,
		MaxPromptLength:       a.MaxPromptLength,
		SystemMaxPromptLength: inference.SystemMaxPromptLength(),
	})
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
			AppID:           id,
			ToolCount:       len(app.Tools),
			HasKey:          h.Auth.HasKey(id),
			AllowedOrigins:  h.Auth.OriginsFor(id),
			Thought:         app.Thought,
			MaxPromptLength: app.MaxPromptLength,
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
	// Public, if true, marks the new app Public at creation time (see
	// toolschema.App.Public's doc comment for what that unlocks) instead of
	// requiring a separate call to make it so afterward. Defaults to false
	// (private) when omitted, same as the schema's own default.
	Public bool `json:"public,omitempty"`
}

func (h *Handler) createApp(w http.ResponseWriter, r *http.Request, user *session.User) {
	var req createAppRequest
	if !decodeJSON(w, r, &req) {
		return
	}

	if err := h.Apps.Create(req.AppID, user.ID, req.Public); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	h.syncWantRole(req.AppID)
	writeJSON(w, http.StatusCreated, appSummary{AppID: req.AppID, ToolCount: 0, HasKey: false})
}

type setOriginRequest struct {
	// Origins is the set of exact values the site's Origin header may
	// present — a connection is accepted if its Origin matches any one of
	// these, e.g. "https://demo.example.com" (no path, no trailing slash —
	// that's what browsers actually send). An empty list clears them,
	// returning the app to fail-closed (no connections accepted) until set
	// again.
	Origins []string `json:"origins"`
}

func (h *Handler) setOrigin(w http.ResponseWriter, r *http.Request, user *session.User) {
	appID := r.PathValue("appId")

	var req setOriginRequest
	if !decodeJSON(w, r, &req) {
		return
	}

	if err := h.Auth.SetOrigins(appID, req.Origins); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	app, _ := h.Apps.Get(appID)
	writeJSON(w, http.StatusOK, appSummary{
		AppID:           appID,
		ToolCount:       len(app.Tools),
		HasKey:          h.Auth.HasKey(appID),
		AllowedOrigins:  h.Auth.OriginsFor(appID),
		Thought:         app.Thought,
		MaxPromptLength: app.MaxPromptLength,
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
	if !decodeJSON(w, r, &req) {
		return
	}

	if err := h.Apps.SetThought(appID, req.Thought); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	h.syncWantRole(appID)
	app, _ := h.Apps.Get(appID)
	writeJSON(w, http.StatusOK, appSummary{
		AppID:           appID,
		ToolCount:       len(app.Tools),
		HasKey:          h.Auth.HasKey(appID),
		AllowedOrigins:  h.Auth.OriginsFor(appID),
		Thought:         req.Thought,
		MaxPromptLength: app.MaxPromptLength,
	})
}

// setMaxPromptLengthRequest's MaxPromptLength is a pointer, not a bare int,
// so the JSON body can distinguish "clear the app-specific limit" (send
// `{"maxPromptLength": null}` or omit the field, decoding to nil) from
// "set it to a specific value" (send a positive integer) — a bare int
// field would have no way to express "clear it" other than overloading 0,
// which toolschema.Registry.SetMaxPromptLength already rejects as an
// invalid positive limit.
type setMaxPromptLengthRequest struct {
	MaxPromptLength *int `json:"maxPromptLength"`
}

func (h *Handler) setMaxPromptLength(w http.ResponseWriter, r *http.Request, user *session.User) {
	appID := r.PathValue("appId")

	var req setMaxPromptLengthRequest
	if !decodeJSON(w, r, &req) {
		return
	}

	if err := h.Apps.SetMaxPromptLength(appID, req.MaxPromptLength); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	app, _ := h.Apps.Get(appID)
	writeJSON(w, http.StatusOK, appSummary{
		AppID:           appID,
		ToolCount:       len(app.Tools),
		HasKey:          h.Auth.HasKey(appID),
		AllowedOrigins:  h.Auth.OriginsFor(appID),
		Thought:         app.Thought,
		MaxPromptLength: req.MaxPromptLength,
	})
}

// toolSaveResponse is what both saveTool and saveToolByID return — the
// usual appSummary fields, plus the id of the tool that was just written.
// The console editor needs this id back the moment a brand-new tool (no id
// yet) is first saved, so every subsequent save of that same tool can go
// through saveToolByID (an atomic in-place UPDATE, including on rename)
// instead of saveTool's name-based upsert.
type toolSaveResponse struct {
	appSummary
	ToolID int64 `json:"toolId"`
}

// MarshalJSON is needed because appSummary now defines its own MarshalJSON
// (see that method's doc comment): without this, embedding would promote
// appSummary's MarshalJSON onto toolSaveResponse wholesale and silently
// drop ToolID from the response, since Go doesn't merge an embedded type's
// custom MarshalJSON with the outer struct's own fields.
func (t toolSaveResponse) MarshalJSON() ([]byte, error) {
	summary, err := t.appSummary.MarshalJSON()
	if err != nil {
		return nil, err
	}
	var m map[string]any
	if err := json.Unmarshal(summary, &m); err != nil {
		return nil, err
	}
	m["toolId"] = t.ToolID
	return json.Marshal(m)
}

// saveTool upserts one tool by NAME (PUT /console/apps/{appId}/tools/
// {toolName}) — see toolschema.Registry.SaveTool's doc comment for why this
// replaced the old replace-all saveTools/Save: neither the CLI's `onagent
// tool create` (a hand-authored tool.yaml has no id to give) nor the
// console editor creating a brand-new tool (nothing to have an id for yet)
// has a tool id in hand here. Once the console editor DOES have an id (the
// ToolID this handler's response carries back), it switches to
// saveToolByID for every subsequent save of that same tool — see that
// handler's own doc comment for why: this route can upsert-by-name but
// can NOT rename a tool in place (its only key IS the name), so a client
// still addressing an existing tool by this route on every edit would be
// back to the old delete-then-insert rename bug this whole id column
// exists to fix.
//
// The path's {toolName} and the decoded body's Tool.Name must agree — a
// mismatch is caller confusion (or a client bug), not something to resolve
// by silently trusting one over the other, so it's rejected with 400
// before anything is written. Tool.ID, if present in the body, is ignored —
// this route only ever upserts by name (see toolschema.saveTool's ID==0
// branch); a caller that already knows an id should be calling
// saveToolByID instead.
func (h *Handler) saveTool(w http.ResponseWriter, r *http.Request, user *session.User) {
	appID := r.PathValue("appId")
	toolName := r.PathValue("toolName")

	var tool toolschema.Tool
	if !decodeJSON(w, r, &tool) {
		return
	}
	if tool.Name != toolName {
		http.Error(w, fmt.Sprintf("tool name %q in the request body does not match %q in the URL", tool.Name, toolName), http.StatusBadRequest)
		return
	}
	tool.ID = 0

	toolID, err := h.Apps.SaveTool(appID, tool)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	h.syncWantRole(appID)
	app, _ := h.Apps.Get(appID) // SaveTool's own Reload already refreshed this
	writeJSON(w, http.StatusOK, toolSaveResponse{
		appSummary: appSummary{
			AppID:           appID,
			ToolCount:       len(app.Tools),
			HasKey:          h.Auth.HasKey(appID),
			AllowedOrigins:  h.Auth.OriginsFor(appID),
			Thought:         app.Thought,
			MaxPromptLength: app.MaxPromptLength,
		},
		ToolID: toolID,
	})
}

// saveToolByID upserts one tool by ID (PUT /console/apps/{appId}/tools/id/
// {toolId}) — the console editor's route once a tool has been saved at
// least once and it holds onto that id (see saveTool's doc comment). This
// is the route that actually fixes the rename bug: an id-scoped UPDATE
// (toolschema.saveTool's ID!=0 branch) changes name in place, atomically,
// with no window where the tool exists under neither its old nor new name —
// contrast the name-based route above, whose ON CONFLICT (app_id, name)
// upsert has no way to change its own conflict target.
//
// The path's {toolId} and the decoded body's Tool.ID must agree, mirroring
// saveTool's name-match check — same rationale: a mismatch is caller
// confusion, not something to silently resolve by trusting one over the
// other.
func (h *Handler) saveToolByID(w http.ResponseWriter, r *http.Request, user *session.User) {
	appID := r.PathValue("appId")
	toolID, err := strconv.ParseInt(r.PathValue("toolId"), 10, 64)
	if err != nil {
		http.Error(w, "invalid toolId in URL", http.StatusBadRequest)
		return
	}

	var tool toolschema.Tool
	if !decodeJSON(w, r, &tool) {
		return
	}
	if tool.ID != 0 && tool.ID != toolID {
		http.Error(w, fmt.Sprintf("tool id %d in the request body does not match %d in the URL", tool.ID, toolID), http.StatusBadRequest)
		return
	}
	tool.ID = toolID

	savedID, err := h.Apps.SaveTool(appID, tool)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	h.syncWantRole(appID)
	app, _ := h.Apps.Get(appID) // SaveTool's own Reload already refreshed this
	writeJSON(w, http.StatusOK, toolSaveResponse{
		appSummary: appSummary{
			AppID:           appID,
			ToolCount:       len(app.Tools),
			HasKey:          h.Auth.HasKey(appID),
			AllowedOrigins:  h.Auth.OriginsFor(appID),
			Thought:         app.Thought,
			MaxPromptLength: app.MaxPromptLength,
		},
		ToolID: savedID,
	})
}

// deleteTool removes one tool by NAME (DELETE /console/apps/{appId}/tools/
// {toolName}) — the CLI's `onagent tool delete` route; see saveTool's doc
// comment for the addressing split this belongs to.
func (h *Handler) deleteTool(w http.ResponseWriter, r *http.Request, user *session.User) {
	appID := r.PathValue("appId")
	toolName := r.PathValue("toolName")

	if err := h.Apps.DeleteTool(appID, toolName); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	h.syncWantRole(appID)
	app, _ := h.Apps.Get(appID) // DeleteTool's own Reload already refreshed this
	writeJSON(w, http.StatusOK, appSummary{
		AppID:           appID,
		ToolCount:       len(app.Tools),
		HasKey:          h.Auth.HasKey(appID),
		AllowedOrigins:  h.Auth.OriginsFor(appID),
		Thought:         app.Thought,
		MaxPromptLength: app.MaxPromptLength,
	})
}

// deleteToolByID removes one tool by ID (DELETE /console/apps/{appId}/
// tools/id/{toolId}) — the console editor's route; see saveToolByID's doc
// comment for the addressing split this belongs to.
func (h *Handler) deleteToolByID(w http.ResponseWriter, r *http.Request, user *session.User) {
	appID := r.PathValue("appId")
	toolID, err := strconv.ParseInt(r.PathValue("toolId"), 10, 64)
	if err != nil {
		http.Error(w, "invalid toolId in URL", http.StatusBadRequest)
		return
	}

	if err := h.Apps.DeleteToolByID(appID, toolID); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	h.syncWantRole(appID)
	app, _ := h.Apps.Get(appID) // DeleteToolByID's own Reload already refreshed this
	writeJSON(w, http.StatusOK, appSummary{
		AppID:           appID,
		ToolCount:       len(app.Tools),
		HasKey:          h.Auth.HasKey(appID),
		AllowedOrigins:  h.Auth.OriginsFor(appID),
		Thought:         app.Thought,
		MaxPromptLength: app.MaxPromptLength,
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
	if !decodeJSON(w, r, &req) {
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
	if !decodeJSON(w, r, &req) {
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

// decodeJSON decodes r's body into dst, rejecting any field dst doesn't
// declare (DisallowUnknownFields) instead of the stdlib default of
// silently ignoring it. That default is what let a stale/mistyped client
// field (e.g. a CLI built against an older field name) look like a
// successful request while actually writing nothing — see setOrigin's
// history: the CLI once sent a JSON shape this handler's request struct
// didn't have a field for, and the mismatch was invisible until the
// allowed-origins list quietly emptied out. Every handler that decodes a
// request body should call this instead of json.NewDecoder(...).Decode
// directly, so a future field rename/removal fails loudly here rather
// than reproducing that bug in a new shape.
func decodeJSON(w http.ResponseWriter, r *http.Request, dst interface{}) bool {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		http.Error(w, "invalid JSON body: "+err.Error(), http.StatusBadRequest)
		return false
	}
	return true
}

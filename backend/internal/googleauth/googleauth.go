// Package googleauth implements "Sign in with Google" for the developer
// console: the browser-redirect authorization-code flow, not the
// JS-SDK/One-Tap popup flow — the console is a traditional server-rendered
// cookie-session app (internal/session), so a full-page redirect to Google
// and back fits its existing auth model instead of adding a second,
// token-based identity path alongside it.
//
// Flow: GET /auth/google/start redirects the browser to Google with a
// random state value stashed in a short-lived cookie; Google redirects back
// to GET /auth/google/callback with a code and that same state; Handler
// verifies the state matches (CSRF protection — see Start's doc comment),
// exchanges the code for tokens, verifies the returned ID token's signature
// against Google's published keys (idtoken.Validate, not a hand-rolled JWT
// check), and hands the verified subject id + email to
// session.Store.LoginOrCreateWithGoogle.
package googleauth

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
	"google.golang.org/api/idtoken"

	"github.com/tim72117/onagent/internal/session"
)

// stateCookieName carries the CSRF state value between Start and Callback.
// Separate from session.CookieName (the actual login session) — this
// cookie only ever exists for the few seconds of the redirect round trip.
const stateCookieName = "onagent_oauth_state"

const stateTTL = 10 * time.Minute

// Handler wires Google's OAuth2 endpoints to session.Store. ClientID/Secret
// come from Google Cloud Console (OAuth 2.0 Client ID, "Web application"
// type); RedirectURL must exactly match one of that client's registered
// redirect URIs, or Google rejects the request before ever showing a
// consent screen.
type Handler struct {
	oauthConfig *oauth2.Config
	clientID    string // also needed standalone to verify the ID token's audience claim
	Session     *session.Store
	// Secure controls the state cookie's Secure attribute, matching
	// session.Store.Secure's reasoning — see that field's doc comment.
	Secure bool
	// SuccessRedirect is where the browser lands after a successful login
	// (the console app's own URL, e.g. "https://console.onagent.example" or
	// "http://localhost:5173" in dev).
	SuccessRedirect string
	// FailureRedirect is where the browser lands after a failed login
	// attempt — a bare URL with NO query string of its own. callback's
	// fail() appends "?error=<reason>" itself; a FailureRedirect that
	// already contains a "?" would produce a malformed two-"?" URL.
	FailureRedirect string
}

// New builds a Handler. redirectURL is this backend's own callback URL
// (e.g. "https://api.onagent.example/auth/google/callback") — it must be
// registered verbatim as an authorized redirect URI on the Google Cloud
// Console OAuth client.
func New(clientID, clientSecret, redirectURL string, sessionStore *session.Store, secure bool, successRedirect, failureRedirect string) *Handler {
	return &Handler{
		oauthConfig: &oauth2.Config{
			ClientID:     clientID,
			ClientSecret: clientSecret,
			RedirectURL:  redirectURL,
			Scopes:       []string{"openid", "email"},
			Endpoint:     google.Endpoint,
		},
		clientID:        clientID,
		Session:         sessionStore,
		Secure:          secure,
		SuccessRedirect: successRedirect,
		FailureRedirect: failureRedirect,
	}
}

// RegisterConfig mounts GET /auth/config — deliberately unauthenticated
// (it's how the Login page, which by definition runs before anyone is
// signed in, learns whether to render a "Sign in with Google" button at
// all), but unlike Start/Callback below it IS called via fetch() from the
// console SPA, not a top-level navigation, so it needs to go on the same
// CORS-protected mux as /console and /auth/register|login|logout — see
// cmd/server/main.go's mountCredentialedRoutes. This route is only ever
// registered when a *Handler exists, i.e. GOOGLE_OAUTH_CLIENT_ID was set;
// a deployment that never configured Google sign-in has no /auth/config
// route, and the console's probe just gets a 404, which it also treats as
// "disabled."
func (h *Handler) RegisterConfig(mux *http.ServeMux) {
	mux.HandleFunc("GET /auth/config", h.config)
}

// RegisterRedirects mounts the two Google OAuth browser-redirect routes.
// Deliberately separate from RegisterConfig above — see main.go's mount
// site for why these two must NOT go behind the same CORS middleware as
// /auth/config.
func (h *Handler) RegisterRedirects(mux *http.ServeMux) {
	mux.HandleFunc("GET /auth/google/start", h.start)
	mux.HandleFunc("GET /auth/google/callback", h.callback)
}

func (h *Handler) config(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(struct {
		GoogleSignIn bool `json:"googleSignIn"`
	}{GoogleSignIn: true})
}

// start redirects the browser to Google's consent screen. The state value
// is the CSRF defense the OAuth2 spec expects here: without it, an
// attacker could craft their own /auth/google/callback?code=...&state=...
// link using a code obtained under the attacker's own Google account, and
// if the victim's browser followed it, the victim would end up logged in
// as the attacker — a "login CSRF" that silently attaches the victim's
// session to an account they don't control. Tying the callback's state to
// a cookie only this browser could have received closes that: the
// attacker has no way to predict or set the victim's cookie value.
func (h *Handler) start(w http.ResponseWriter, r *http.Request) {
	state, err := randomState()
	if err != nil {
		http.Error(w, "failed to start Google sign-in", http.StatusInternalServerError)
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     stateCookieName,
		Value:    state,
		Path:     "/auth/google",
		Expires:  time.Now().Add(stateTTL),
		HttpOnly: true,
		Secure:   h.Secure,
		SameSite: http.SameSiteLaxMode, // Lax, not None: this cookie only needs to survive Google's top-level redirect back to us, which Lax already allows
	})

	url := h.oauthConfig.AuthCodeURL(state, oauth2.AccessTypeOnline)
	http.Redirect(w, r, url, http.StatusFound)
}

// callback handles Google's redirect back. Any failure redirects the
// browser to FailureRedirect with a human-readable reason instead of
// rendering a raw error page — the console SPA never sees this endpoint
// directly, only its outcome.
func (h *Handler) callback(w http.ResponseWriter, r *http.Request) {
	fail := func(reason string) {
		http.Redirect(w, r, h.FailureRedirect+"?error="+reason, http.StatusFound)
	}

	cookie, err := r.Cookie(stateCookieName)
	if err != nil {
		fail("missing_state")
		return
	}
	// Clear the state cookie immediately regardless of outcome — it's
	// single-use by design, same reasoning as internal/cliauth's session
	// ids.
	http.SetCookie(w, &http.Cookie{
		Name: stateCookieName, Value: "", Path: "/auth/google",
		Expires: time.Unix(0, 0), MaxAge: -1, HttpOnly: true, Secure: h.Secure, SameSite: http.SameSiteLaxMode,
	})

	if r.URL.Query().Get("state") != cookie.Value {
		fail("state_mismatch")
		return
	}
	if errParam := r.URL.Query().Get("error"); errParam != "" {
		// The user declined consent, or Google itself rejected the request
		// (e.g. redirect_uri mismatch) — surfaced by Google as this param,
		// not an exception on our side.
		fail("google_" + errParam)
		return
	}
	code := r.URL.Query().Get("code")
	if code == "" {
		fail("missing_code")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	token, err := h.oauthConfig.Exchange(ctx, code)
	if err != nil {
		fail("exchange_failed")
		return
	}

	rawIDToken, ok := token.Extra("id_token").(string)
	if !ok || rawIDToken == "" {
		fail("no_id_token")
		return
	}

	// idtoken.Validate verifies the JWT's signature against Google's
	// published, rotating public keys and checks the standard claims
	// (issuer, expiry) — this is the step that actually establishes "this
	// really is Google vouching for this subject id," not just "some JWT
	// arrived." The audience check confirms the token was issued for THIS
	// app's client id, not a token obtained by some other application.
	payload, err := idtoken.Validate(ctx, rawIDToken, h.clientID)
	if err != nil {
		fail("invalid_id_token")
		return
	}

	googleID := payload.Subject
	email, _ := payload.Claims["email"].(string)
	if googleID == "" || email == "" {
		fail("missing_claims")
		return
	}
	if verified, _ := payload.Claims["email_verified"].(bool); !verified {
		// An unverified email on Google's own side means Google itself
		// isn't vouching that this address belongs to the account holder —
		// linking it to an existing users row by email match would be
		// exactly the account-takeover path LoginOrCreateWithGoogle's step
		// 2 is meant to avoid trusting blindly.
		fail("email_not_verified")
		return
	}

	user, created, err := h.Session.LoginOrCreateWithGoogle(googleID, email)
	if err != nil {
		// ErrInvalidEmail specifically means the ID token's own email claim
		// failed our format check — a Google-side anomaly, not a database
		// problem — worth a distinct reason code from the generic
		// "account_error" catch-all below (see session.ErrInvalidEmail's
		// doc comment).
		if errors.Is(err, session.ErrInvalidEmail) {
			fail("invalid_email")
			return
		}
		fail("account_error")
		return
	}

	if _, err := h.Session.CreateSession(w, user.ID); err != nil {
		fail("session_error")
		return
	}

	// created mirrors the fail path's own "?error=" query param — the only
	// way the console SPA (which never sees this handler directly, only its
	// redirect outcome) can tell a first-time signup apart from a returning
	// user's login, e.g. to fire an ads conversion event exactly once per
	// real registration instead of on every Google sign-in.
	redirect := h.SuccessRedirect
	if created {
		redirect += "?new=1"
	}
	http.Redirect(w, r, redirect, http.StatusFound)
}

func randomState() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("googleauth: generate state: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// Unit tests for the parts of Handler reachable without a live Google
// endpoint: state cookie issuance (start), the CSRF/error-param handling
// that runs before callback ever calls Google (state validation, Google's
// own ?error= passthrough, missing ?code=), and the unauthenticated
// /auth/config probe. Everything downstream of the token exchange
// (oauthConfig.Exchange, idtoken.Validate) is exercised end to end
// manually against real Google credentials — see the package doc comment
// — not here, since faking a signed ID token that passes idtoken.Validate
// would mean either hitting Google's real JWKS or hand-rolling a fake
// verifier, both of which would test the fake more than the code.
package googleauth

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/tim72117/onagent/internal/session"
)

func newTestHandler() *Handler {
	return New(
		"test-client-id.apps.googleusercontent.com",
		"test-client-secret",
		"http://backend.example.com/auth/google/callback",
		session.New(nil, false), // never dereferenced by anything these tests exercise
		true,
		"https://console.example.com/",
		"https://console.example.com/", // bare URL, no query string — see Handler.FailureRedirect's doc comment
	)
}

func TestConfig_ReportsGoogleSignInEnabled(t *testing.T) {
	h := newTestHandler()
	mux := http.NewServeMux()
	h.RegisterConfig(mux)

	req := httptest.NewRequest(http.MethodGet, "/auth/config", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	const want = `{"googleSignIn":true}` + "\n"
	if got := rec.Body.String(); got != want {
		t.Errorf("body = %q, want %q", got, want)
	}
}

// TestStart_RedirectsToGoogleWithStateCookie pins the two things a client
// depends on: the redirect actually goes to Google's own endpoint with the
// right client id/scope, and the state cookie set alongside it is the one
// callback's CSRF check later relies on (HttpOnly, SameSite=Lax, scoped to
// /auth/google — see start's doc comment for the threat this defends
// against).
func TestStart_RedirectsToGoogleWithStateCookie(t *testing.T) {
	h := newTestHandler()
	mux := http.NewServeMux()
	h.RegisterRedirects(mux)

	req := httptest.NewRequest(http.MethodGet, "/auth/google/start", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusFound {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusFound)
	}

	loc, err := url.Parse(rec.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse Location header: %v", err)
	}
	if got := loc.Scheme + "://" + loc.Host + loc.Path; !strings.HasPrefix(got, "https://accounts.google.com/") {
		t.Errorf("redirected to %q, want it to start with https://accounts.google.com/", got)
	}
	q := loc.Query()
	if got := q.Get("client_id"); got != "test-client-id.apps.googleusercontent.com" {
		t.Errorf("client_id = %q, want the configured client id", got)
	}
	if got := q.Get("scope"); got != "openid email" {
		t.Errorf("scope = %q, want %q (least-privilege: no profile scope requested)", got, "openid email")
	}
	if got := q.Get("redirect_uri"); got != "http://backend.example.com/auth/google/callback" {
		t.Errorf("redirect_uri = %q, want the configured backend callback URL", got)
	}
	state := q.Get("state")
	if state == "" {
		t.Fatal("state query param is empty — CSRF protection is a no-op without it")
	}

	cookies := rec.Result().Cookies()
	var stateCookie *http.Cookie
	for _, c := range cookies {
		if c.Name == stateCookieName {
			stateCookie = c
		}
	}
	if stateCookie == nil {
		t.Fatal("no onagent_oauth_state cookie was set")
	}
	if stateCookie.Value != state {
		t.Errorf("cookie value = %q, want it to match the state query param %q (callback compares these)", stateCookie.Value, state)
	}
	if !stateCookie.HttpOnly {
		t.Error("state cookie is not HttpOnly")
	}
	if stateCookie.SameSite != http.SameSiteLaxMode {
		t.Errorf("state cookie SameSite = %v, want Lax", stateCookie.SameSite)
	}
	if stateCookie.Path != "/auth/google" {
		t.Errorf("state cookie Path = %q, want %q", stateCookie.Path, "/auth/google")
	}
}

// TestStart_TwoRequestsGetDifferentState guards against a broken
// randomState that always returns the same value — if that regressed, the
// CSRF defense start's doc comment describes would be worthless (an
// attacker could just reuse a known state).
func TestStart_TwoRequestsGetDifferentState(t *testing.T) {
	h := newTestHandler()
	mux := http.NewServeMux()
	h.RegisterRedirects(mux)

	stateOf := func() string {
		req := httptest.NewRequest(http.MethodGet, "/auth/google/start", nil)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		loc, _ := url.Parse(rec.Header().Get("Location"))
		return loc.Query().Get("state")
	}

	a, b := stateOf(), stateOf()
	if a == b {
		t.Fatalf("two separate /auth/google/start calls produced the same state %q", a)
	}
}

// callbackRequest builds a GET /auth/google/callback request carrying the
// query params given plus the matching state cookie, mirroring what a real
// browser round trip through start looks like — a test that wants to
// exercise the state-mismatch path passes a deliberately different
// cookieState.
func callbackRequest(query url.Values, cookieState string) *http.Request {
	req := httptest.NewRequest(http.MethodGet, "/auth/google/callback?"+query.Encode(), nil)
	if cookieState != "" {
		req.AddCookie(&http.Cookie{Name: stateCookieName, Value: cookieState})
	}
	return req
}

func TestCallback_MissingStateCookie(t *testing.T) {
	h := newTestHandler()
	mux := http.NewServeMux()
	h.RegisterRedirects(mux)

	req := callbackRequest(url.Values{"state": {"whatever"}, "code": {"whatever"}}, "" /* no cookie */)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	assertFailureRedirect(t, rec, "missing_state")
}

func TestCallback_StateMismatch(t *testing.T) {
	h := newTestHandler()
	mux := http.NewServeMux()
	h.RegisterRedirects(mux)

	// The classic login-CSRF shape start's doc comment describes: an
	// attacker-supplied state in the query that doesn't match whatever
	// this browser's cookie actually holds.
	req := callbackRequest(url.Values{"state": {"attacker-supplied-state"}, "code": {"whatever"}}, "real-state-from-cookie")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	assertFailureRedirect(t, rec, "state_mismatch")
}

func TestCallback_StateCookieIsAlwaysCleared(t *testing.T) {
	h := newTestHandler()
	mux := http.NewServeMux()
	h.RegisterRedirects(mux)

	// Even on a state mismatch (attacker's request), the browser's
	// legitimate state cookie must not be left lying around for a second
	// attempt to reuse — single-use by design (see callback's doc comment).
	req := callbackRequest(url.Values{"state": {"mismatched"}, "code": {"whatever"}}, "real-state-from-cookie")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	var cleared *http.Cookie
	for _, c := range rec.Result().Cookies() {
		if c.Name == stateCookieName {
			cleared = c
		}
	}
	if cleared == nil {
		t.Fatal("callback never re-set the state cookie to clear it")
	}
	if cleared.Value != "" || cleared.MaxAge >= 0 {
		t.Errorf("state cookie not cleared: value=%q maxAge=%d, want empty value and MaxAge<0", cleared.Value, cleared.MaxAge)
	}
}

func TestCallback_GoogleReportedError(t *testing.T) {
	h := newTestHandler()
	mux := http.NewServeMux()
	h.RegisterRedirects(mux)

	const state = "shared-state"
	req := callbackRequest(url.Values{"state": {state}, "error": {"access_denied"}}, state)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	// Google's own ?error= is passed through with a "google_" prefix so
	// the console can tell "Google rejected/user declined" apart from our
	// own failure reasons — see callback's doc comment.
	assertFailureRedirect(t, rec, "google_access_denied")
}

func TestCallback_MissingCode(t *testing.T) {
	h := newTestHandler()
	mux := http.NewServeMux()
	h.RegisterRedirects(mux)

	const state = "shared-state"
	// State validates, no ?error=, but Google also never sent ?code= —
	// should fail closed rather than proceed into a token exchange with an
	// empty code.
	req := callbackRequest(url.Values{"state": {state}}, state)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	assertFailureRedirect(t, rec, "missing_code")
}

// assertFailureRedirect checks callback redirected to FailureRedirect with
// exactly the given ?error= reason — this is the contract Login.tsx's
// googleErrorMessage switches on, so the reason strings here are part of
// this package's public behavior even though they're just query params.
func assertFailureRedirect(t *testing.T, rec *httptest.ResponseRecorder, wantReason string) {
	t.Helper()
	if rec.Code != http.StatusFound {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusFound)
	}
	loc := rec.Header().Get("Location")
	want := "https://console.example.com/?error=" + wantReason
	if loc != want {
		t.Errorf("Location = %q, want %q", loc, want)
	}
}

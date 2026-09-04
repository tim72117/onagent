package console

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/tim72117/onagent/internal/session"
	"github.com/tim72117/onagent/internal/usertoken"
)

// testConsoleLogger is a discard-output *slog.Logger for tests that need a
// non-nil Log field but don't care what's logged. Named distinctly from
// playground_integration_test.go's testLogger (an integration-tagged file
// compiled separately, under //go:build integration) to avoid a
// same-package redeclaration if both ever compile together.
func testConsoleLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// fakeCookieVerifier and fakeTokenVerifier are test-only stand-ins for
// *session.Store/*usertoken.Store — see cookieVerifier/tokenVerifier's doc
// comment in console.go for why verifyUser/withAuth/withOwnedApp accept
// these narrow interfaces instead of the concrete store types, and
// fakeAppOwnerLookup for appOwnerLookup/ownedAppOrNotFound the same way.
type fakeCookieVerifier struct {
	user *session.User
	ok   bool
}

func (f fakeCookieVerifier) Verify(r *http.Request) (*session.User, bool) { return f.user, f.ok }

type fakeTokenVerifier struct {
	user *usertoken.User
	ok   bool
}

func (f fakeTokenVerifier) Verify(r *http.Request) (*usertoken.User, bool) { return f.user, f.ok }

type fakeAppOwnerLookup struct {
	owners map[string]int64 // appID -> ownerID; missing key means "unknown app"
}

func (f fakeAppOwnerLookup) OwnerOf(appID string) (int64, bool) {
	id, ok := f.owners[appID]
	return id, ok
}

func newTestRequest() *http.Request {
	return httptest.NewRequest(http.MethodGet, "/irrelevant", nil)
}

// newTestRequestWithAppID mirrors how the real ServeMux populates
// r.PathValue("appId") for a "{appId}" pattern — withOwnedApp reads it
// directly, so a test driving the middleware without going through a real
// mux has to set it explicitly.
func newTestRequestWithAppID(appID string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/console/apps/"+appID, nil)
	r.SetPathValue("appId", appID)
	return r
}

// TestVerifyUser_CookieWins confirms a valid cookie short-circuits before
// tokens is even consulted — mirrors withAuth's doc comment ("a session
// cookie first ... falling back to a bearer token").
func TestVerifyUser_CookieWins(t *testing.T) {
	cookieUser := &session.User{ID: 1, Email: "cookie@example.com"}
	cookies := fakeCookieVerifier{user: cookieUser, ok: true}
	tokens := fakeTokenVerifier{ok: true, user: &usertoken.User{ID: 999, Email: "should-not-be-used@example.com"}}

	got, ok := verifyUser(cookies, tokens, newTestRequest())
	if !ok {
		t.Fatal("verifyUser ok = false, want true")
	}
	if got != cookieUser {
		t.Errorf("verifyUser returned %+v, want the cookie-resolved user %+v (token fallback should not have run)", got, cookieUser)
	}
}

// TestVerifyUser_FallsBackToToken confirms a failed cookie check falls
// through to the token verifier, and that the *usertoken.User it returns is
// correctly normalized onto *session.User (a different concrete type — see
// verifyUser's doc comment).
func TestVerifyUser_FallsBackToToken(t *testing.T) {
	cookies := fakeCookieVerifier{ok: false}
	tokens := fakeTokenVerifier{ok: true, user: &usertoken.User{ID: 42, Email: "cli@example.com"}}

	got, ok := verifyUser(cookies, tokens, newTestRequest())
	if !ok {
		t.Fatal("verifyUser ok = false, want true")
	}
	if got.ID != 42 || got.Email != "cli@example.com" {
		t.Errorf("verifyUser = %+v, want {ID:42 Email:cli@example.com}", got)
	}
}

// TestVerifyUser_NeitherResolves confirms both failing means not
// authenticated, not a panic or a zero-value false positive.
func TestVerifyUser_NeitherResolves(t *testing.T) {
	cookies := fakeCookieVerifier{ok: false}
	tokens := fakeTokenVerifier{ok: false}

	_, ok := verifyUser(cookies, tokens, newTestRequest())
	if ok {
		t.Error("verifyUser ok = true, want false when neither cookie nor token resolves")
	}
}

// TestVerifyUser_NilTokensSkipsFallback covers withCookieAuth's use of
// verifyUser(h.Session, nil, r) — a nil tokenVerifier must not be called
// (which would panic on the interface's nil dynamic value) and must simply
// mean "no fallback available".
func TestVerifyUser_NilTokensSkipsFallback(t *testing.T) {
	cookies := fakeCookieVerifier{ok: false}

	_, ok := verifyUser(cookies, nil, newTestRequest())
	if ok {
		t.Error("verifyUser ok = true, want false with nil tokens and a failed cookie check")
	}
}

// TestOwnedAppOrNotFound covers all three branches ownedAppOrNotFound must
// distinguish only internally — the caller-visible behavior (see
// withOwnedApp/playgroundResolver.ResolveApp) treats "unknown app" and
// "owned by someone else" identically (404, not 403), but the function
// itself must still get both of those right, plus the true-owner case.
func TestOwnedAppOrNotFound(t *testing.T) {
	apps := fakeAppOwnerLookup{owners: map[string]int64{"my-app": 7, "someone-elses-app": 8}}

	cases := []struct {
		name   string
		userID int64
		appID  string
		want   bool
	}{
		{"owns it", 7, "my-app", true},
		{"owned by someone else", 7, "someone-elses-app", false},
		{"app does not exist", 7, "no-such-app", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ownedAppOrNotFound(apps, tc.userID, tc.appID); got != tc.want {
				t.Errorf("ownedAppOrNotFound(userID=%d, appID=%q) = %v, want %v", tc.userID, tc.appID, got, tc.want)
			}
		})
	}
}

// TestWithAuth_RejectsWhenNeitherCredentialResolves and
// TestWithAuth_PassesResolvedUserToNext cover withAuth itself (not just
// verifyUser) — confirming the wrapper actually wires h.sessionVerify/
// h.tokenVerify into verifyUser and reacts correctly to both outcomes,
// entirely without a database (see Handler.sessionVerify's doc comment for
// why these fields exist).
func TestWithAuth_RejectsWhenNeitherCredentialResolves(t *testing.T) {
	h := &Handler{
		sessionVerify: fakeCookieVerifier{ok: false},
		tokenVerify:   fakeTokenVerifier{ok: false},
	}
	called := false
	handler := h.withAuth(func(w http.ResponseWriter, r *http.Request, user *session.User) { called = true })

	rec := httptest.NewRecorder()
	handler(rec, newTestRequest())

	if called {
		t.Error("next was called, want it skipped when neither credential resolves")
	}
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestWithAuth_PassesResolvedUserToNext(t *testing.T) {
	wantUser := &session.User{ID: 5, Email: "test@example.com"}
	h := &Handler{
		sessionVerify: fakeCookieVerifier{user: wantUser, ok: true},
		tokenVerify:   fakeTokenVerifier{ok: false},
	}
	var gotUser *session.User
	handler := h.withAuth(func(w http.ResponseWriter, r *http.Request, user *session.User) { gotUser = user })

	rec := httptest.NewRecorder()
	handler(rec, newTestRequest())

	if gotUser != wantUser {
		t.Errorf("next received user %+v, want %+v", gotUser, wantUser)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d (default, since next didn't write one)", rec.Code, http.StatusOK)
	}
}

// TestWithOwnedApp_RejectsUnownedOrUnknownAppWith404 confirms the full
// withAuth+ownership chain end to end: an authenticated caller who doesn't
// own {appId} (or where it doesn't exist at all) gets 404, never reaching
// next — matching ownedAppOrNotFound's own leak-no-information contract,
// now verified at the wrapper level too, not just the pure function.
func TestWithOwnedApp_RejectsUnownedOrUnknownAppWith404(t *testing.T) {
	h := &Handler{
		sessionVerify: fakeCookieVerifier{user: &session.User{ID: 1}, ok: true},
		tokenVerify:   fakeTokenVerifier{ok: false},
		appOwner:      fakeAppOwnerLookup{owners: map[string]int64{"owned-by-someone-else": 2}},
	}

	for name, appID := range map[string]string{
		"nonexistent app":     "does-not-exist",
		"owned by other user": "owned-by-someone-else",
	} {
		t.Run(name, func(t *testing.T) {
			called := false
			handler := h.withOwnedApp(func(w http.ResponseWriter, r *http.Request, user *session.User) { called = true })

			rec := httptest.NewRecorder()
			handler(rec, newTestRequestWithAppID(appID))

			if called {
				t.Errorf("next was called for %s, want rejected before reaching it", name)
			}
			if rec.Code != http.StatusNotFound {
				t.Errorf("status = %d, want %d", rec.Code, http.StatusNotFound)
			}
		})
	}
}

// TestPlaygroundResolver_NilSessionsOrLogFailsClosed covers the
// defense-in-depth guard at the top of playgroundResolver.ResolveApp: a
// misconstructed resolver (nil sessions or log — NewHandler always sets
// both, see console.go) must reject the handshake with a clear 503 rather
// than panicking a few lines later on a nil *session.Store/*slog.Logger
// receiver. No database needed — the guard runs before either field is
// touched, and originAllowed/verifyUser never execute.
func TestPlaygroundResolver_NilSessionsOrLogFailsClosed(t *testing.T) {
	cases := []struct {
		name     string
		resolver *playgroundResolver
	}{
		{"nil sessions", &playgroundResolver{sessions: nil, log: testConsoleLogger()}},
		{"nil log", &playgroundResolver{sessions: &session.Store{}, log: nil}},
		{"both nil", &playgroundResolver{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, _, ok, _, code := tc.resolver.ResolveApp(newTestRequestWithAppID("irrelevant-app"))
			if ok {
				t.Fatal("ResolveApp ok = true, want false")
			}
			if code != http.StatusServiceUnavailable {
				t.Errorf("ResolveApp code = %d, want %d", code, http.StatusServiceUnavailable)
			}
		})
	}
}

// TestWithOwnedApp_AllowsOwnedApp is the golden path: authenticated caller
// who does own {appId} reaches next with the resolved user.
func TestWithOwnedApp_AllowsOwnedApp(t *testing.T) {
	wantUser := &session.User{ID: 1, Email: "owner@example.com"}
	h := &Handler{
		sessionVerify: fakeCookieVerifier{user: wantUser, ok: true},
		tokenVerify:   fakeTokenVerifier{ok: false},
		appOwner:      fakeAppOwnerLookup{owners: map[string]int64{"my-app": 1}},
	}

	var gotUser *session.User
	handler := h.withOwnedApp(func(w http.ResponseWriter, r *http.Request, user *session.User) { gotUser = user })

	rec := httptest.NewRecorder()
	handler(rec, newTestRequestWithAppID("my-app"))

	if gotUser != wantUser {
		t.Errorf("next received user %+v, want %+v", gotUser, wantUser)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
	}
}

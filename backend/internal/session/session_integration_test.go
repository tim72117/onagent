//go:build integration

// Integration tests for session against a live Postgres. These pin down the
// package's CURRENT behavior (raw database/sql) so a later rewrite (e.g. to
// GORM) can be checked against them without changing expectations. Excluded
// from the default build; run with:
//
//	go test -tags integration ./internal/session/ \
//	  -args -dsn "postgres://platform:platform@localhost:5434/platform?sslmode=disable"
package session

import (
	"flag"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/tim72117/onagent/internal/db"
)

var dsn = flag.String("dsn", "postgres://platform:platform@localhost:5434/platform?sslmode=disable", "Postgres DSN")

// newRequestWithCookie builds a *http.Request carrying the session cookie
// named CookieName with value id, the shape Verify/Logout expect.
func newRequestWithCookie(id string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.AddCookie(&http.Cookie{Name: CookieName, Value: id})
	return r
}

func TestRegisterLoginSessionLifecycle(t *testing.T) {
	database, err := db.Open(*dsn)
	if err != nil {
		t.Skipf("no reachable Postgres at %s (%v)", *dsn, err)
	}
	defer func() { if sqlDB, err := database.DB(); err == nil { sqlDB.Close() } }()
	sqlDB, _ := database.DB()
	conn := sqlDB

	const email = "session-integ-test@example.com"
	const password = "supersecret123"

	cleanup := func() {
		_, _ = conn.Exec(`DELETE FROM users WHERE lower(email) = lower($1)`, email)
	}
	cleanup() // clean slate in case a previous run left state behind
	t.Cleanup(cleanup)

	store := New(database, false)

	// --- 1. Register basic flow -------------------------------------
	user, err := store.Register(email, password)
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	if user.Email != email {
		t.Errorf("registered user email = %q, want %q", user.Email, email)
	}
	if user.ID == 0 {
		t.Errorf("registered user ID = 0, want a positive id")
	}

	// Register's side effect: a 'free' tier subscription row exists.
	var tier string
	if err := conn.QueryRow(`SELECT tier FROM subscriptions WHERE user_id = $1`, user.ID).Scan(&tier); err != nil {
		t.Fatalf("query subscription for new user: %v", err)
	}
	if tier != "free" {
		t.Errorf("subscription tier = %q, want %q", tier, "free")
	}

	// --- 2. Duplicate email (case-insensitive) is rejected -----------
	_, err = store.Register(strings.ToUpper(email), "another-password-123")
	if err != ErrEmailTaken {
		t.Errorf("duplicate (upper-cased) email register: got %v, want ErrEmailTaken", err)
	}

	// --- 3. Login basic flow, including case-insensitive email -------
	loggedIn, err := store.Login(email, password)
	if err != nil {
		t.Fatalf("Login with correct credentials: %v", err)
	}
	if loggedIn.ID != user.ID || loggedIn.Email != email {
		t.Errorf("Login returned %+v, want ID=%d Email=%q", loggedIn, user.ID, email)
	}

	loggedInUpper, err := store.Login(strings.ToUpper(email), password)
	if err != nil {
		t.Fatalf("Login with upper-cased email: %v", err)
	}
	if loggedInUpper.ID != user.ID {
		t.Errorf("Login (upper-cased email) returned ID=%d, want %d", loggedInUpper.ID, user.ID)
	}

	// --- 4. Login failure cases: same opaque error --------------------
	if _, err := store.Login(email, "wrong-password"); err != ErrInvalidCredentials {
		t.Errorf("wrong password: got %v, want ErrInvalidCredentials", err)
	}
	if _, err := store.Login("nobody-"+email, password); err != ErrInvalidCredentials {
		t.Errorf("unknown email: got %v, want ErrInvalidCredentials", err)
	}

	// --- 5. CreateSession + Verify -------------------------------------
	rec := httptest.NewRecorder()
	sessionID, err := store.CreateSession(rec, user.ID)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if sessionID == "" {
		t.Fatal("CreateSession returned empty session id")
	}

	verified, ok := store.Verify(newRequestWithCookie(sessionID))
	if !ok {
		t.Fatal("Verify(valid session) = false, want true")
	}
	if verified.ID != user.ID || verified.Email != email {
		t.Errorf("Verify returned %+v, want ID=%d Email=%q", verified, user.ID, email)
	}

	// A request with no cookie at all must fail closed.
	if _, ok := store.Verify(httptest.NewRequest(http.MethodGet, "/", nil)); ok {
		t.Error("Verify(no cookie) = true, want false")
	}

	// An unknown session id must fail closed.
	if _, ok := store.Verify(newRequestWithCookie("does-not-exist")); ok {
		t.Error("Verify(unknown session id) = true, want false")
	}

	// --- 6. Expired session cannot Verify ------------------------------
	const expiredID = "session-integ-test-expired"
	_, err = conn.Exec(
		`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)`,
		expiredID, user.ID, time.Now().Add(-1*time.Hour),
	)
	if err != nil {
		t.Fatalf("insert expired session row: %v", err)
	}
	t.Cleanup(func() {
		_, _ = conn.Exec(`DELETE FROM sessions WHERE id = $1`, expiredID)
	})

	if _, ok := store.Verify(newRequestWithCookie(expiredID)); ok {
		t.Error("Verify(expired session) = true, want false")
	}

	// --- 7. Logout ------------------------------------------------------
	logoutRec := httptest.NewRecorder()
	store.Logout(logoutRec, newRequestWithCookie(sessionID))

	if _, ok := store.Verify(newRequestWithCookie(sessionID)); ok {
		t.Error("Verify(session id after Logout) = true, want false")
	}

	// Logout with no cookie at all must be a no-op, not a panic/error.
	noCookieRec := httptest.NewRecorder()
	store.Logout(noCookieRec, httptest.NewRequest(http.MethodGet, "/", nil))
}

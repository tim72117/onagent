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
	"errors"
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

// TestLoginOrCreateWithGoogle_NewAccount pins step 3 of
// LoginOrCreateWithGoogle's doc comment: a Google subject id never seen
// before, with an email that also doesn't match any existing account,
// creates a brand-new passwordless account.
func TestLoginOrCreateWithGoogle_NewAccount(t *testing.T) {
	database, err := db.Open(*dsn)
	if err != nil {
		t.Skipf("no reachable Postgres at %s (%v)", *dsn, err)
	}
	defer func() { if sqlDB, err := database.DB(); err == nil { sqlDB.Close() } }()
	sqlDB, _ := database.DB()
	conn := sqlDB

	const email = "google-new-account@example.com"
	const googleID = "google-sub-new-account-001"

	cleanup := func() {
		_, _ = conn.Exec(`DELETE FROM users WHERE lower(email) = lower($1)`, email)
	}
	cleanup()
	t.Cleanup(cleanup)

	store := New(database, false)

	user, err := store.LoginOrCreateWithGoogle(googleID, email)
	if err != nil {
		t.Fatalf("LoginOrCreateWithGoogle: %v", err)
	}
	if user.Email != email {
		t.Errorf("user.Email = %q, want %q", user.Email, email)
	}
	if user.ID == 0 {
		t.Error("user.ID = 0, want a positive id")
	}

	// PasswordHash must stay NULL — this account can only sign in via
	// Google until/unless the user later sets a password (see
	// LoginOrCreateWithGoogle's doc comment and userRow.PasswordHash).
	var passwordHash *string
	if err := conn.QueryRow(`SELECT password_hash FROM users WHERE id = $1`, user.ID).Scan(&passwordHash); err != nil {
		t.Fatalf("query password_hash: %v", err)
	}
	if passwordHash != nil {
		t.Errorf("password_hash = %q, want NULL for a Google-only account", *passwordHash)
	}

	// The identity link itself must exist, keyed on (provider,
	// provider_user_id) — this is what a returning login looks up.
	var linkedUserID int64
	err = conn.QueryRow(
		`SELECT user_id FROM identities WHERE provider = 'google' AND provider_user_id = $1`, googleID,
	).Scan(&linkedUserID)
	if err != nil {
		t.Fatalf("query identities row: %v", err)
	}
	if linkedUserID != user.ID {
		t.Errorf("identities.user_id = %d, want %d", linkedUserID, user.ID)
	}

	// Same reasoning as Register: a fresh account gets a free-tier
	// subscription row so quota has something to read/UPDATE from day one.
	var tier string
	if err := conn.QueryRow(`SELECT tier FROM subscriptions WHERE user_id = $1`, user.ID).Scan(&tier); err != nil {
		t.Fatalf("query subscription for new user: %v", err)
	}
	if tier != "free" {
		t.Errorf("subscription tier = %q, want %q", tier, "free")
	}
}

// TestLoginOrCreateWithGoogle_ReturningUser pins step 1: a Google subject
// id that's already linked resolves straight to the same user on every
// subsequent call, without creating a duplicate account or a duplicate
// identities row.
func TestLoginOrCreateWithGoogle_ReturningUser(t *testing.T) {
	database, err := db.Open(*dsn)
	if err != nil {
		t.Skipf("no reachable Postgres at %s (%v)", *dsn, err)
	}
	defer func() { if sqlDB, err := database.DB(); err == nil { sqlDB.Close() } }()
	sqlDB, _ := database.DB()
	conn := sqlDB

	const email = "google-returning-user@example.com"
	const googleID = "google-sub-returning-001"

	cleanup := func() {
		_, _ = conn.Exec(`DELETE FROM users WHERE lower(email) = lower($1)`, email)
	}
	cleanup()
	t.Cleanup(cleanup)

	store := New(database, false)

	first, err := store.LoginOrCreateWithGoogle(googleID, email)
	if err != nil {
		t.Fatalf("first LoginOrCreateWithGoogle: %v", err)
	}

	second, err := store.LoginOrCreateWithGoogle(googleID, email)
	if err != nil {
		t.Fatalf("second LoginOrCreateWithGoogle: %v", err)
	}
	if second.ID != first.ID {
		t.Errorf("second call returned a different user ID (%d) than the first (%d) for the same Google subject", second.ID, first.ID)
	}

	var userCount, identityCount int
	if err := conn.QueryRow(`SELECT count(*) FROM users WHERE lower(email) = lower($1)`, email).Scan(&userCount); err != nil {
		t.Fatalf("count users: %v", err)
	}
	if userCount != 1 {
		t.Errorf("users with email %q = %d, want exactly 1 (no duplicate account created)", email, userCount)
	}
	if err := conn.QueryRow(
		`SELECT count(*) FROM identities WHERE provider = 'google' AND provider_user_id = $1`, googleID,
	).Scan(&identityCount); err != nil {
		t.Fatalf("count identities: %v", err)
	}
	if identityCount != 1 {
		t.Errorf("identities rows for this Google subject = %d, want exactly 1 (not re-linked on every login)", identityCount)
	}
}

// TestLoginOrCreateWithGoogle_LinksToExistingPasswordAccount pins step 2,
// the scenario this project explicitly chose over the alternatives (kept
// separate accounts, or requiring manual merge): a developer who already
// registered with email+password, then signs in with Google using the
// same email, lands in the SAME account — not a second one — and keeps
// their original password working alongside the new Google identity.
func TestLoginOrCreateWithGoogle_LinksToExistingPasswordAccount(t *testing.T) {
	database, err := db.Open(*dsn)
	if err != nil {
		t.Skipf("no reachable Postgres at %s (%v)", *dsn, err)
	}
	defer func() { if sqlDB, err := database.DB(); err == nil { sqlDB.Close() } }()
	sqlDB, _ := database.DB()
	conn := sqlDB

	const email = "google-links-existing@example.com"
	const password = "supersecret123"
	const googleID = "google-sub-links-existing-001"

	cleanup := func() {
		_, _ = conn.Exec(`DELETE FROM users WHERE lower(email) = lower($1)`, email)
	}
	cleanup()
	t.Cleanup(cleanup)

	store := New(database, false)

	// 1. Register the password account first, exactly like an existing
	// developer would have before Google sign-in ever existed.
	registered, err := store.Register(email, password)
	if err != nil {
		t.Fatalf("Register: %v", err)
	}

	// 2. Sign in with Google using the same (already-verified — see
	// googleauth.go's email_verified check, which runs before this method
	// is ever called) email address.
	linked, err := store.LoginOrCreateWithGoogle(googleID, email)
	if err != nil {
		t.Fatalf("LoginOrCreateWithGoogle: %v", err)
	}

	// Same account, not a new one.
	if linked.ID != registered.ID {
		t.Errorf("LoginOrCreateWithGoogle returned user ID %d, want the existing account's ID %d", linked.ID, registered.ID)
	}

	var userCount int
	if err := conn.QueryRow(`SELECT count(*) FROM users WHERE lower(email) = lower($1)`, email).Scan(&userCount); err != nil {
		t.Fatalf("count users: %v", err)
	}
	if userCount != 1 {
		t.Errorf("users with email %q = %d, want exactly 1 (Google sign-in must not create a duplicate account)", email, userCount)
	}

	// The original password must still work — linking a Google identity is
	// additive, not a migration away from the password.
	if _, err := store.Login(email, password); err != nil {
		t.Errorf("Login with the original password after Google linking: %v, want it to still succeed", err)
	}

	// And the new Google identity must resolve straight back to this same
	// account on a subsequent sign-in (step 1's path, not step 2's again).
	again, err := store.LoginOrCreateWithGoogle(googleID, email)
	if err != nil {
		t.Fatalf("second LoginOrCreateWithGoogle: %v", err)
	}
	if again.ID != registered.ID {
		t.Errorf("repeat Google sign-in returned user ID %d, want %d", again.ID, registered.ID)
	}
}

// TestLoginOrCreateWithGoogle_InvalidEmail pins that a malformed email
// claim is rejected with the specific ErrInvalidEmail sentinel (not a bare
// error) — googleauth.go's callback distinguishes this from a database
// failure to give the console a more precise "invalid_email" reason code
// rather than the generic "account_error" catch-all.
func TestLoginOrCreateWithGoogle_InvalidEmail(t *testing.T) {
	database, err := db.Open(*dsn)
	if err != nil {
		t.Skipf("no reachable Postgres at %s (%v)", *dsn, err)
	}
	defer func() { if sqlDB, err := database.DB(); err == nil { sqlDB.Close() } }()

	store := New(database, false)

	if _, err := store.LoginOrCreateWithGoogle("some-google-sub", "not-an-email"); !errors.Is(err, ErrInvalidEmail) {
		t.Errorf("LoginOrCreateWithGoogle with malformed email: got %v, want ErrInvalidEmail", err)
	}
}

//go:build integration

// Integration tests for playgroundResolver.ResolveApp (backend/internal/
// console/playground.go) against a live Postgres — it depends on real
// *session.Store/*toolschema.Registry, mirroring internal/ws's own
// APIKeyResolver test conventions (handler_integration_test.go) since the
// two resolvers are meant to be equivalent in strictness, just keyed on a
// different credential (console session cookie + ownership, not an API
// key). Excluded from the default build; run with:
//
//	go test -tags integration ./internal/console/... \
//	  -args -dsn "postgres://platform:platform@localhost:5434/platform?sslmode=disable"
package console

import (
	"context"
	"database/sql"
	"flag"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/tim72117/onagent/internal/db"
	"github.com/tim72117/onagent/internal/quota"
	"github.com/tim72117/onagent/internal/session"
	"github.com/tim72117/onagent/internal/toolschema"
	"gorm.io/gorm"
)

var dsn = flag.String("dsn", "postgres://platform:platform@localhost:5434/platform?sslmode=disable", "Postgres DSN")

func openTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	database, err := db.Open(*dsn)
	if err != nil {
		t.Skipf("no reachable Postgres at %s (%v) — skipping integration test", *dsn, err)
	}
	t.Cleanup(func() {
		if sqlDB, err := database.DB(); err == nil {
			sqlDB.Close()
		}
	})
	return database
}

// makeSessionCookie logs in as userID (already a users row) via
// session.Store.CreateSession and returns the cookie a real browser would
// have received — the only way to exercise Verify's actual query path
// rather than faking a cookie value that wouldn't resolve to anything.
func makeSessionCookie(t *testing.T, store *session.Store, userID int64) *http.Cookie {
	t.Helper()
	rec := httptest.NewRecorder()
	if _, err := store.CreateSession(rec, userID); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	cookies := rec.Result().Cookies()
	if len(cookies) == 0 {
		t.Fatal("CreateSession set no cookie")
	}
	return cookies[0]
}

func makeTestUser(t *testing.T, conn *sql.DB, id int64, email string) {
	t.Helper()
	if _, err := conn.Exec(
		`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'x')`,
		id, email,
	); err != nil {
		t.Fatalf("insert test user %d: %v", id, err)
	}
	t.Cleanup(func() {
		if _, err := conn.Exec(`DELETE FROM users WHERE id = $1`, id); err != nil {
			t.Errorf("cleanup user %d: %v", id, err)
		}
	})
}

func makeTestApp(t *testing.T, database *gorm.DB, appID string, ownerID int64) *toolschema.Registry {
	t.Helper()
	reg, err := toolschema.NewRegistry(database)
	if err != nil {
		t.Fatalf("toolschema.NewRegistry: %v", err)
	}
	if err := reg.Create(appID, ownerID); err != nil {
		t.Fatalf("toolschema.Registry.Create(%s): %v", appID, err)
	}
	t.Cleanup(func() {
		if err := reg.Delete(appID); err != nil {
			t.Errorf("cleanup app %s: %v", appID, err)
		}
	})
	return reg
}

// newPlaygroundRequest builds a request the way a browser's Playground
// WebSocket handshake would: {appId} as a mux path value (playgroundResolver
// reads it via r.PathValue, which in production only the ServeMux's pattern
// matching populates — SetPathValue reproduces that directly here since
// this test calls ResolveApp without routing the request through a real
// mux), the session cookie if any, and an Origin header if any.
func newPlaygroundRequest(appID string, cookie *http.Cookie, origin string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/console/apps/"+appID+"/playground", nil)
	r.SetPathValue("appId", appID)
	if cookie != nil {
		r.AddCookie(cookie)
	}
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	return r
}

// TestPlaygroundResolver_OriginNotAllowed covers the console-origin
// allowlist check — playgroundResolver's own responsibility, since
// ws.Handler.CheckOrigin becomes a no-op whenever a Resolver is set (see
// playground.go's package doc comment).
func TestPlaygroundResolver_OriginNotAllowed(t *testing.T) {
	database := openTestDB(t)
	sessions := session.New(database, false)

	resolver := &playgroundResolver{
		apps:           mustRegistry(t, database),
		sessions:       sessions,
		consoleOrigins: []string{"https://console.example.com"},
		log:            testLogger(),
	}

	req := newPlaygroundRequest("irrelevant-app", nil, "https://evil.example.com")
	_, _, ok, _, code := resolver.ResolveApp(req)
	if ok {
		t.Fatalf("ResolveApp ok = true, want false (origin not on allowlist)")
	}
	if code != http.StatusForbidden {
		t.Errorf("ResolveApp code = %d, want %d", code, http.StatusForbidden)
	}
}

// TestPlaygroundResolver_NoOriginHeaderRejected confirms a request with no
// Origin header at all is rejected (fail-closed) — unlike APIKeyResolver,
// which must tolerate non-browser callers, Playground is only ever reached
// from a logged-in browser tab (see playground.go's package comment and
// originAllowed's doc comment), and a real browser always sends Origin on a
// cross-origin WebSocket handshake — a missing header here means the
// request isn't what it claims to be.
func TestPlaygroundResolver_NoOriginHeaderRejected(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	sessions := session.New(database, false)

	const userID = 999901
	const appID = "test-pg-resolver-noorigin-app"
	makeTestUser(t, sqlDB, userID, "pg-resolver-noorigin@example.com")
	makeTestApp(t, database, appID, userID)

	cookie := makeSessionCookie(t, sessions, userID)

	resolver := &playgroundResolver{
		apps:           mustRegistry(t, database),
		sessions:       sessions,
		consoleOrigins: []string{"https://console.example.com"},
		log:            testLogger(),
	}

	req := newPlaygroundRequest(appID, cookie, "")
	_, _, ok, _, code := resolver.ResolveApp(req)
	if ok {
		t.Fatal("ResolveApp ok = true, want false (missing Origin header must be rejected)")
	}
	if code != http.StatusForbidden {
		t.Errorf("ResolveApp code = %d, want %d", code, http.StatusForbidden)
	}
}

// TestPlaygroundResolver_NotAuthenticated covers a missing/invalid session
// cookie — no cookie at all, since Verify's own doc comment treats a
// missing cookie the same as an unknown/expired one.
func TestPlaygroundResolver_NotAuthenticated(t *testing.T) {
	database := openTestDB(t)
	sessions := session.New(database, false)

	resolver := &playgroundResolver{
		apps:           mustRegistry(t, database),
		sessions:       sessions,
		consoleOrigins: []string{"https://console.example.com"},
		log:            testLogger(),
	}

	req := newPlaygroundRequest("some-app", nil, "https://console.example.com")
	_, _, ok, _, code := resolver.ResolveApp(req)
	if ok {
		t.Fatalf("ResolveApp ok = true, want false (no session cookie)")
	}
	if code != http.StatusUnauthorized {
		t.Errorf("ResolveApp code = %d, want %d", code, http.StatusUnauthorized)
	}
}

// TestPlaygroundResolver_AppNotOwnedByCaller covers both "app doesn't
// exist" and "app belongs to someone else" — playgroundResolver's own doc
// comment says both must return 404, not 401/403, for the same
// leak-no-information reason withOwnedApp's comment documents (console.go).
// Covered as one test since the resolver treats them identically (OwnerOf's
// !known branch and the ownerID mismatch branch share one return).
func TestPlaygroundResolver_AppNotOwnedByCaller(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	sessions := session.New(database, false)

	const callerID = 999902
	const ownerID = 999903
	const existingAppID = "test-pg-resolver-notowned-app"
	makeTestUser(t, sqlDB, callerID, "pg-resolver-caller@example.com")
	makeTestUser(t, sqlDB, ownerID, "pg-resolver-owner@example.com")
	makeTestApp(t, database, existingAppID, ownerID)

	cookie := makeSessionCookie(t, sessions, callerID)
	resolver := &playgroundResolver{
		apps:           mustRegistry(t, database),
		sessions:       sessions,
		consoleOrigins: []string{"https://console.example.com"},
		log:            testLogger(),
	}

	for name, appID := range map[string]string{
		"nonexistent app":     "test-pg-resolver-does-not-exist",
		"owned by other user": existingAppID,
	} {
		t.Run(name, func(t *testing.T) {
			req := newPlaygroundRequest(appID, cookie, "https://console.example.com")
			_, _, ok, _, code := resolver.ResolveApp(req)
			if ok {
				t.Fatalf("ResolveApp(%s) ok = true, want false", name)
			}
			if code != http.StatusNotFound {
				t.Errorf("ResolveApp(%s) code = %d, want %d (not 401/403 — must not leak whether the app exists)", name, code, http.StatusNotFound)
			}
		})
	}
}

// TestPlaygroundResolver_SuccessPath is the golden path: valid session
// cookie, caller owns the app, origin on the allowlist. sessionID must come
// back as the stable "PG-<userID>-<appID>" shape (not empty, unlike
// APIKeyResolver) so a developer reopening Playground for the same app
// resumes the same want conversation transcript.
func TestPlaygroundResolver_SuccessPath(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	sessions := session.New(database, false)

	const userID = 999904
	const appID = "test-pg-resolver-success-app"
	makeTestUser(t, sqlDB, userID, "pg-resolver-success@example.com")
	makeTestApp(t, database, appID, userID)

	cookie := makeSessionCookie(t, sessions, userID)
	resolver := &playgroundResolver{
		apps:           mustRegistry(t, database),
		sessions:       sessions,
		consoleOrigins: []string{"https://console.example.com"},
		log:            testLogger(),
	}

	req := newPlaygroundRequest(appID, cookie, "https://console.example.com")
	gotAppID, gotSessionID, ok, msg, code := resolver.ResolveApp(req)
	if !ok {
		t.Fatalf("ResolveApp ok = false (msg=%q, code=%d), want true", msg, code)
	}
	if gotAppID != appID {
		t.Errorf("ResolveApp appID = %q, want %q", gotAppID, appID)
	}
	wantSessionID := "PG-999904-" + appID
	if gotSessionID != wantSessionID {
		t.Errorf("ResolveApp sessionID = %q, want %q", gotSessionID, wantSessionID)
	}
	if code != 0 {
		t.Errorf("ResolveApp code = %d, want 0 on success", code)
	}
}

// TestPlaygroundResolver_OverQuotaRejectsHandshake covers the 429 branch,
// mirroring internal/ws's TestAPIKeyResolver_OverQuotaRejectsHandshake:
// the app's owner is already at/over their plan's monthly allowance. Forces
// this deterministically via a subscriptions row with monthly_quota = 0 (a
// per-user override that beats the tier's plan value), rather than
// populating 100+ usage_events rows.
func TestPlaygroundResolver_OverQuotaRejectsHandshake(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	sessions := session.New(database, false)

	const userID = 999905
	const appID = "test-pg-resolver-overquota-app"
	makeTestUser(t, sqlDB, userID, "pg-resolver-overquota@example.com")
	makeTestApp(t, database, appID, userID)

	cookie := makeSessionCookie(t, sessions, userID)

	quotaSvc := quota.New(database)
	if err := quotaSvc.SetTier(context.Background(), userID, quota.TierFree); err != nil {
		t.Fatalf("SetTier: %v", err)
	}
	if _, err := sqlDB.Exec(`UPDATE subscriptions SET monthly_quota = 0 WHERE user_id = $1`, userID); err != nil {
		t.Fatalf("force zero quota override: %v", err)
	}

	resolver := &playgroundResolver{
		apps:           mustRegistry(t, database),
		sessions:       sessions,
		consoleOrigins: []string{"https://console.example.com"},
		quota:          quotaSvc,
		log:            testLogger(),
	}

	req := newPlaygroundRequest(appID, cookie, "https://console.example.com")
	_, _, ok, _, code := resolver.ResolveApp(req)
	if ok {
		t.Fatalf("ResolveApp ok = true, want false (owner is over quota)")
	}
	if code != http.StatusTooManyRequests {
		t.Errorf("ResolveApp code = %d, want %d", code, http.StatusTooManyRequests)
	}
}

// TestPlaygroundResolver_NilQuotaAllows confirms a nil quota field (quota
// enforcement disabled service-wide) never blocks the handshake — mirrors
// quota.Service.Check's own documented nil-receiver behavior (always
// allowed).
func TestPlaygroundResolver_NilQuotaAllows(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	sessions := session.New(database, false)

	const userID = 999906
	const appID = "test-pg-resolver-nilquota-app"
	makeTestUser(t, sqlDB, userID, "pg-resolver-nilquota@example.com")
	makeTestApp(t, database, appID, userID)

	cookie := makeSessionCookie(t, sessions, userID)
	resolver := &playgroundResolver{
		apps:           mustRegistry(t, database),
		sessions:       sessions,
		consoleOrigins: []string{"https://console.example.com"},
		quota:          nil,
		log:            testLogger(),
	}

	req := newPlaygroundRequest(appID, cookie, "https://console.example.com")
	_, _, ok, msg, code := resolver.ResolveApp(req)
	if !ok {
		t.Fatalf("ResolveApp ok = false (msg=%q, code=%d), want true with nil quota", msg, code)
	}
}

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func mustRegistry(t *testing.T, database *gorm.DB) *toolschema.Registry {
	t.Helper()
	reg, err := toolschema.NewRegistry(database)
	if err != nil {
		t.Fatalf("toolschema.NewRegistry: %v", err)
	}
	return reg
}

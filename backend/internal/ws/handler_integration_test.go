//go:build integration

// Integration tests for the refactored auth path in handler.go:
// APIKeyResolver.ResolveApp (token/app/origin/quota checks against a live
// Postgres, since it depends on real *auth.Store/*toolschema.Registry/
// *quota.Service) and ws.Handler.ServeHTTP's routing around it (resolver
// rejection short-circuits before any WebSocket upgrade is attempted).
// Excluded from the default build; run with:
//
//	go test -tags integration ./internal/ws/... \
//	  -args -dsn "postgres://platform:platform@localhost:5434/platform?sslmode=disable"
//
// Setup/cleanup helpers here mirror internal/auth/auth_integration_test.go
// and internal/quota/quota_integration_test.go's existing conventions
// (openTestDB skips rather than fails when Postgres is unreachable;
// makeTestUser/makeTestApp register their own t.Cleanup).
package ws

import (
	"context"
	"database/sql"
	"flag"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/tim72117/onagent/internal/auth"
	"github.com/tim72117/onagent/internal/db"
	"github.com/tim72117/onagent/internal/quota"
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

// makeTestApp creates appID via toolschema.Registry.Create (mirroring how a
// real app comes to exist before auth ever touches it) and registers its
// cleanup via the same Registry.
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

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(discardWriter{}, nil))
}

type discardWriter struct{}

func (discardWriter) Write(p []byte) (int, error) { return len(p), nil }

// newResolveRequest builds a bare *http.Request the way ResolveApp expects
// it: token as a query parameter (browsers can't attach custom headers to a
// WebSocket upgrade — see APIKeyResolver's doc comment) and Origin as a
// header.
func newResolveRequest(token, origin string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/ws?token="+token, nil)
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	return r
}

// TestAPIKeyResolver_MissingOrInvalidToken covers both the empty-token and
// wrong-token cases in one test, since auth.Store.Verify treats them
// identically (see Verify's early "" check and its hash-miss path).
func TestAPIKeyResolver_MissingOrInvalidToken(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()

	const ownerID = 999801
	const appID = "test-ws-resolver-badtoken-app"
	makeTestUser(t, sqlDB, ownerID, "ws-resolver-badtoken@example.com")
	makeTestApp(t, database, appID, ownerID)

	resolver := &APIKeyResolver{
		Auth:  auth.New(database),
		Apps:  mustRegistry(t, database),
		Quota: quota.New(database),
		Log:   testLogger(),
	}

	for name, token := range map[string]string{
		"missing token": "",
		"garbage token": "not-a-real-key",
	} {
		t.Run(name, func(t *testing.T) {
			_, _, ok, _, code := resolver.ResolveApp(newResolveRequest(token, "https://example.com"))
			if ok {
				t.Fatalf("ResolveApp(%s) ok = true, want false", name)
			}
			if code != http.StatusUnauthorized {
				t.Errorf("ResolveApp(%s) code = %d, want %d", name, code, http.StatusUnauthorized)
			}
		})
	}
}

// TestAPIKeyResolver_TokenResolvesToUnknownApp covers ResolveApp's second
// gate — result.AppID verified fine by auth.Verify, but not found via
// Apps.Get — in isolation from the token check itself.
//
// toolschema.Registry.Get is an in-memory snapshot lookup, not a live query
// (see NewRegistry/Reload: the snapshot is loaded once at construction and
// only refreshed by an explicit Reload/Save/Create/Delete call on that same
// instance). This test exploits exactly that: it builds the Registry passed
// to APIKeyResolver.Apps BEFORE the app row exists, so its snapshot never
// contains appID, then creates the app and issues a key against it via a
// second, independent Registry/Store pair the way a real second backend
// instance (or a Registry that just hasn't polled since) would see it.
// auth.Verify still succeeds (it queries the DB live, not a cached
// snapshot), so this isolates the Apps.Get miss from the token check.
func TestAPIKeyResolver_TokenResolvesToUnknownApp(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()

	const ownerID = 999802
	const appID = "test-ws-resolver-unknownapp-app"
	makeTestUser(t, sqlDB, ownerID, "ws-resolver-unknownapp@example.com")

	// Snapshot taken while appID does not exist yet.
	staleRegistry := mustRegistry(t, database)

	makeTestApp(t, database, appID, ownerID) // uses its own fresh Registry internally

	authStore := auth.New(database)
	key, err := authStore.Issue(appID)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if err := authStore.SetOrigin(appID, "https://example.com"); err != nil {
		t.Fatalf("SetOrigin: %v", err)
	}

	if _, known := staleRegistry.Get(appID); known {
		t.Fatalf("staleRegistry.Get(%q) found the app, want it absent from the pre-creation snapshot", appID)
	}

	resolver := &APIKeyResolver{
		Auth:  authStore,
		Apps:  staleRegistry,
		Quota: quota.New(database),
		Log:   testLogger(),
	}

	_, _, ok, _, code := resolver.ResolveApp(newResolveRequest(key, "https://example.com"))
	if ok {
		t.Fatalf("ResolveApp ok = true, want false (app absent from this resolver's Registry)")
	}
	if code != http.StatusUnauthorized {
		t.Errorf("ResolveApp code = %d, want %d", code, http.StatusUnauthorized)
	}
}

// TestAPIKeyResolver_AppHasNoAllowedOrigin covers the fail-closed default: a
// freshly created app with a key issued but SetOrigin never called must
// reject every connection, not fall back to "no restriction".
func TestAPIKeyResolver_AppHasNoAllowedOrigin(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()

	const ownerID = 999803
	const appID = "test-ws-resolver-noorigin-app"
	makeTestUser(t, sqlDB, ownerID, "ws-resolver-noorigin@example.com")
	makeTestApp(t, database, appID, ownerID)

	authStore := auth.New(database)
	key, err := authStore.Issue(appID)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	// Deliberately no SetOrigin call.

	resolver := &APIKeyResolver{
		Auth:  authStore,
		Apps:  mustRegistry(t, database),
		Quota: quota.New(database),
		Log:   testLogger(),
	}

	_, _, ok, _, code := resolver.ResolveApp(newResolveRequest(key, "https://example.com"))
	if ok {
		t.Fatalf("ResolveApp ok = true, want false (no allowed origin configured)")
	}
	if code != http.StatusForbidden {
		t.Errorf("ResolveApp code = %d, want %d", code, http.StatusForbidden)
	}
}

// TestAPIKeyResolver_OriginMismatch covers an app WITH an allowed origin
// configured, but the request's Origin header doesn't match it exactly.
func TestAPIKeyResolver_OriginMismatch(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()

	const ownerID = 999804
	const appID = "test-ws-resolver-originmismatch-app"
	makeTestUser(t, sqlDB, ownerID, "ws-resolver-originmismatch@example.com")
	makeTestApp(t, database, appID, ownerID)

	authStore := auth.New(database)
	key, err := authStore.Issue(appID)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if err := authStore.SetOrigin(appID, "https://allowed.example.com"); err != nil {
		t.Fatalf("SetOrigin: %v", err)
	}

	resolver := &APIKeyResolver{
		Auth:  authStore,
		Apps:  mustRegistry(t, database),
		Quota: quota.New(database),
		Log:   testLogger(),
	}

	for name, origin := range map[string]string{
		"different origin": "https://evil.example.com",
		"no origin header": "",
		"subdomain differs": "https://sub.allowed.example.com",
	} {
		t.Run(name, func(t *testing.T) {
			_, _, ok, _, code := resolver.ResolveApp(newResolveRequest(key, origin))
			if ok {
				t.Fatalf("ResolveApp(origin=%q) ok = true, want false", origin)
			}
			if code != http.StatusForbidden {
				t.Errorf("ResolveApp(origin=%q) code = %d, want %d", origin, code, http.StatusForbidden)
			}
		})
	}
}

// TestAPIKeyResolver_SuccessPath is the golden path: valid token, known app,
// matching origin, quota allows. sessionID must come back "" — APIKeyResolver
// always lets Session pick a fresh random id (see ResolveApp's final return
// and NewSession's doc comment on the real SDK path never passing a fixed
// id).
func TestAPIKeyResolver_SuccessPath(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()

	const ownerID = 999805
	const appID = "test-ws-resolver-success-app"
	makeTestUser(t, sqlDB, ownerID, "ws-resolver-success@example.com")
	makeTestApp(t, database, appID, ownerID)

	authStore := auth.New(database)
	key, err := authStore.Issue(appID)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	const origin = "https://allowed.example.com"
	if err := authStore.SetOrigin(appID, origin); err != nil {
		t.Fatalf("SetOrigin: %v", err)
	}

	resolver := &APIKeyResolver{
		Auth:  authStore,
		Apps:  mustRegistry(t, database),
		Quota: quota.New(database),
		Log:   testLogger(),
	}

	gotAppID, gotSessionID, ok, msg, code := resolver.ResolveApp(newResolveRequest(key, origin))
	if !ok {
		t.Fatalf("ResolveApp ok = false (msg=%q, code=%d), want true", msg, code)
	}
	if gotAppID != appID {
		t.Errorf("ResolveApp appID = %q, want %q", gotAppID, appID)
	}
	if gotSessionID != "" {
		t.Errorf("ResolveApp sessionID = %q, want \"\" (APIKeyResolver always leaves session id selection to NewSession)", gotSessionID)
	}
	if code != 0 {
		t.Errorf("ResolveApp code = %d, want 0 on success", code)
	}
}

// TestAPIKeyResolver_OverQuotaRejectsHandshake covers the 429 branch: the
// app's owner is already at/over their plan's monthly allowance. Forces this
// deterministically by giving the owner a subscriptions row with
// monthly_quota = 0 (a per-user override that beats the tier's plan value —
// see quota.ownerStandingRow.limit), which quota.Service.Check.Allowed
// treats as "used (0) < limit (0)" == false without needing to actually
// populate 100+ usage_events rows.
func TestAPIKeyResolver_OverQuotaRejectsHandshake(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()

	const ownerID = 999806
	const appID = "test-ws-resolver-overquota-app"
	makeTestUser(t, sqlDB, ownerID, "ws-resolver-overquota@example.com")
	makeTestApp(t, database, appID, ownerID)

	authStore := auth.New(database)
	key, err := authStore.Issue(appID)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	const origin = "https://allowed.example.com"
	if err := authStore.SetOrigin(appID, origin); err != nil {
		t.Fatalf("SetOrigin: %v", err)
	}

	quotaSvc := quota.New(database)
	if err := quotaSvc.SetTier(context.Background(), ownerID, quota.TierFree); err != nil {
		t.Fatalf("SetTier: %v", err)
	}
	if _, err := sqlDB.Exec(`UPDATE subscriptions SET monthly_quota = 0 WHERE user_id = $1`, ownerID); err != nil {
		t.Fatalf("force zero quota override: %v", err)
	}

	resolver := &APIKeyResolver{
		Auth:  authStore,
		Apps:  mustRegistry(t, database),
		Quota: quotaSvc,
		Log:   testLogger(),
	}

	_, _, ok, _, code := resolver.ResolveApp(newResolveRequest(key, origin))
	if ok {
		t.Fatalf("ResolveApp ok = true, want false (owner is over quota)")
	}
	if code != http.StatusTooManyRequests {
		t.Errorf("ResolveApp code = %d, want %d", code, http.StatusTooManyRequests)
	}
}

func mustRegistry(t *testing.T, database *gorm.DB) *toolschema.Registry {
	t.Helper()
	reg, err := toolschema.NewRegistry(database)
	if err != nil {
		t.Fatalf("toolschema.NewRegistry: %v", err)
	}
	return reg
}

// Note: ws.Handler.ServeHTTP's dispatch behavior (resolver rejection
// short-circuits before any upgrade attempt) and upgrader.CheckOrigin's
// with/without-Resolver branching are already covered, without needing a
// database, by handler_test.go's fakeResolver-based tests
// (TestServeHTTP_ResolverRejectionNeverUpgrades,
// TestServeHTTP_ResolverRejectionPropagatesCode,
// TestCheckOrigin_ResolverPresentAlwaysAllows,
// TestCheckOrigin_NoResolverNoOriginHeaderAllowed,
// TestCheckOrigin_NoResolverDelegatesToAllowedOrigins) — intentionally not
// duplicated here.

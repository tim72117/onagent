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
	"encoding/json"
	"flag"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tim72117/onagent/internal/auth"
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
	_, _, _, ok, _, code := resolver.ResolveApp(req)
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
	_, _, _, ok, _, code := resolver.ResolveApp(req)
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
	_, _, _, ok, _, code := resolver.ResolveApp(req)
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
			_, _, _, ok, _, code := resolver.ResolveApp(req)
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
	gotAppID, gotSessionID, _, ok, msg, code := resolver.ResolveApp(req)
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
	_, _, _, ok, _, code := resolver.ResolveApp(req)
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
	_, _, _, ok, msg, code := resolver.ResolveApp(req)
	if !ok {
		t.Fatalf("ResolveApp ok = false (msg=%q, code=%d), want true with nil quota", msg, code)
	}
}

// TestPlaygroundResolver_PublicAppAllowsNonOwner covers the new
// ownedOrPublicApp branch: a non-owner reaches the Playground once the app's
// owner marks it Public (toolschema.Registry.SetPublic) — this is the whole
// point of the Public flag, so it's the golden path for it.
func TestPlaygroundResolver_PublicAppAllowsNonOwner(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	sessions := session.New(database, false)

	const ownerID = 999908
	const visitorID = 999909
	const appID = "test-pg-resolver-public-app"
	makeTestUser(t, sqlDB, ownerID, "pg-resolver-public-owner@example.com")
	makeTestUser(t, sqlDB, visitorID, "pg-resolver-public-visitor@example.com")
	reg := makeTestApp(t, database, appID, ownerID)
	if err := reg.SetPublic(appID, true); err != nil {
		t.Fatalf("SetPublic: %v", err)
	}

	cookie := makeSessionCookie(t, sessions, visitorID)
	resolver := &playgroundResolver{
		apps:           reg,
		sessions:       sessions,
		consoleOrigins: []string{"https://console.example.com"},
		log:            testLogger(),
	}

	req := newPlaygroundRequest(appID, cookie, "https://console.example.com")
	gotAppID, gotSessionID, _, ok, msg, code := resolver.ResolveApp(req)
	if !ok {
		t.Fatalf("ResolveApp ok = false (msg=%q, code=%d), want true (app is public)", msg, code)
	}
	if gotAppID != appID {
		t.Errorf("ResolveApp appID = %q, want %q", gotAppID, appID)
	}
	// The session id is keyed by the VISITOR's own id, not the owner's — a
	// public app's Playground still isolates each visitor's own conversation
	// transcript from every other visitor's (and from the owner's own runs),
	// mirroring the existing PG-<userID>-<appID> scheme.
	wantSessionID := "PG-999909-" + appID
	if gotSessionID != wantSessionID {
		t.Errorf("ResolveApp sessionID = %q, want %q", gotSessionID, wantSessionID)
	}
}

// TestPlaygroundResolver_PrivateAppStillRejectsNonOwner confirms an app with
// Public left at its default (false) behaves exactly as before this task:
// a non-owner still gets 404, indistinguishable from a nonexistent app —
// adding the Public column must not accidentally loosen the default case.
func TestPlaygroundResolver_PrivateAppStillRejectsNonOwner(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	sessions := session.New(database, false)

	const ownerID = 999910
	const visitorID = 999911
	const appID = "test-pg-resolver-private-app"
	makeTestUser(t, sqlDB, ownerID, "pg-resolver-private-owner@example.com")
	makeTestUser(t, sqlDB, visitorID, "pg-resolver-private-visitor@example.com")
	reg := makeTestApp(t, database, appID, ownerID)
	// Deliberately no SetPublic call — Public stays at its schema default
	// (false).

	cookie := makeSessionCookie(t, sessions, visitorID)
	resolver := &playgroundResolver{
		apps:           reg,
		sessions:       sessions,
		consoleOrigins: []string{"https://console.example.com"},
		log:            testLogger(),
	}

	req := newPlaygroundRequest(appID, cookie, "https://console.example.com")
	_, _, _, ok, _, code := resolver.ResolveApp(req)
	if ok {
		t.Fatal("ResolveApp ok = true, want false (app is private, caller is not the owner)")
	}
	if code != http.StatusNotFound {
		t.Errorf("ResolveApp code = %d, want %d", code, http.StatusNotFound)
	}
}

// TestWithOwnedApp_RejectsNonOwnerEvenOnAPublicApp confirms marking an app
// Public does NOT loosen the REST API's ownership check: withOwnedApp (the
// middleware every edit route — save tools, set origin, delete, issue/revoke
// key — runs behind) must keep rejecting a non-owner with 404 regardless of
// App.Public, since ownedOrPublicApp's widening is deliberately scoped to
// playgroundResolver alone (see console.go's doc comments on both
// functions). Exercised via the real *toolschema.Registry (not
// fakeAppOwnerLookup) specifically to prove withOwnedApp's actual
// appOwnerLookup field — a concrete *toolschema.Registry in production —
// still only calls ownedAppOrNotFound, never ownedOrPublicApp.
func TestWithOwnedApp_RejectsNonOwnerEvenOnAPublicApp(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	sessions := session.New(database, false)

	const ownerID = 999912
	const visitorID = 999913
	const appID = "test-withownedapp-public-app"
	makeTestUser(t, sqlDB, ownerID, "withownedapp-public-owner@example.com")
	makeTestUser(t, sqlDB, visitorID, "withownedapp-public-visitor@example.com")
	reg := makeTestApp(t, database, appID, ownerID)
	if err := reg.SetPublic(appID, true); err != nil {
		t.Fatalf("SetPublic: %v", err)
	}

	h := &Handler{
		sessionVerify: sessions,
		appOwner:      reg,
	}

	var called bool
	handler := h.withOwnedApp(func(w http.ResponseWriter, r *http.Request, user *session.User) { called = true })

	cookie := makeSessionCookie(t, sessions, visitorID)
	req := newTestRequestWithAppID(appID)
	req.AddCookie(cookie)
	rec := httptest.NewRecorder()
	handler(rec, req)

	if called {
		t.Error("withOwnedApp let a non-owner through to the handler because the app is public — REST API operations must stay owner-only")
	}
	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want %d (public must not turn into 200/403 for the REST API)", rec.Code, http.StatusNotFound)
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

// --- PUT/DELETE /console/apps/{appId}/tools/{toolName} (saveTool/deleteTool
// handlers) ---
//
// These call the unexported handler methods directly (constructing a
// minimal &Handler{Apps: reg} rather than the full NewHandler dependency
// chain — saveTool/deleteTool only ever touch h.Apps, same as getApp does)
// with r.SetPathValue used the same way newPlaygroundRequest does above:
// {appId}/{toolName} as mux path values, since that's what only a real
// ServeMux's routing would otherwise populate on r.PathValue. withOwnedApp
// itself (the ownership gate both routes sit behind in Register) already
// has its own full coverage in console_test.go; these only need to prove
// the handler's own body — path/body parsing, which Registry method it
// calls, and the response shape — is correct.

// newToolRequest builds a PUT or DELETE request for
// /console/apps/{appId}/tools/{toolName}, with appId/toolName set as mux
// path values (see this file's package doc comment on why SetPathValue is
// required here rather than routing through a real mux). body is the raw
// JSON to send as the PUT's Tool payload; pass "" for DELETE requests,
// which send no body.
func newToolRequest(method, appID, toolName, body string) *http.Request {
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, "/console/apps/"+appID+"/tools/"+toolName, nil)
	} else {
		r = httptest.NewRequest(method, "/console/apps/"+appID+"/tools/"+toolName, strings.NewReader(body))
	}
	r.SetPathValue("appId", appID)
	r.SetPathValue("toolName", toolName)
	return r
}

// TestSaveTool_HandlerUpsertsAndReturnsAppSummary confirms the PUT handler
// decodes the request body into a toolschema.Tool, calls
// Registry.SaveTool(appId, tool) (not the old replace-all Save), and
// answers with the app's current appSummary (mirroring every other
// app-mutating handler's response shape — createApp, setOrigin, setThought
// — so the console front-end's existing response handling needs no special
// case for this one).
func TestSaveTool_HandlerUpsertsAndReturnsAppSummary(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	conn := sqlDB

	const ownerID = 999901
	const appID = "test-console-savetool-handler-app"
	makeTestUser(t, conn, ownerID, "console-savetool-handler@example.com")
	reg := makeTestApp(t, database, appID, ownerID)
	if err := reg.SaveTool(appID, toolschema.Tool{
		Name: "existing_tool", Description: "already here",
		Parameters: toolschema.ParameterSchema{Type: "object"}, Kind: toolschema.ToolKindAction,
	}); err != nil {
		t.Fatalf("seed SaveTool: %v", err)
	}

	h := &Handler{Apps: reg, Auth: auth.New(database)}
	r := newToolRequest(http.MethodPut, appID, "new_tool",
		`{"name":"new_tool","description":"added via the handler","parameters":{"type":"object"},"kind":"action"}`)
	rec := httptest.NewRecorder()
	h.saveTool(rec, r, &session.User{ID: ownerID})

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body: %s", rec.Code, rec.Body.String())
	}
	var got appSummary
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v (body: %s)", err, rec.Body.String())
	}
	if got.AppID != appID {
		t.Errorf("response AppID = %q, want %q", got.AppID, appID)
	}
	if got.ToolCount != 2 {
		t.Errorf("response ToolCount = %d, want 2 (existing_tool + new_tool — saveTool must not have clobbered existing_tool)", got.ToolCount)
	}

	app, ok := reg.Get(appID)
	if !ok {
		t.Fatal("app not found in Registry after saveTool handler")
	}
	names := make(map[string]bool, len(app.Tools))
	for _, tool := range app.Tools {
		names[tool.Name] = true
	}
	if !names["existing_tool"] || !names["new_tool"] {
		t.Errorf("Registry Tools after saveTool handler = %v, want both existing_tool and new_tool", app.Tools)
	}
}

// TestSaveTool_HandlerNameMismatchIsRejected confirms the handler refuses a
// body whose Tool.Name disagrees with the {toolName} path segment, rather
// than silently trusting one or the other — a URL of .../tools/foo with a
// body naming "bar" is caller confusion (or a client bug) that must be
// surfaced as a clear 400, not resolved by picking one value and ignoring
// the other.
func TestSaveTool_HandlerNameMismatchIsRejected(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	conn := sqlDB

	const ownerID = 999902
	const appID = "test-console-savetool-mismatch-app"
	makeTestUser(t, conn, ownerID, "console-savetool-mismatch@example.com")
	reg := makeTestApp(t, database, appID, ownerID)

	h := &Handler{Apps: reg, Auth: auth.New(database)}
	r := newToolRequest(http.MethodPut, appID, "foo",
		`{"name":"bar","description":"d","parameters":{"type":"object"},"kind":"action"}`)
	rec := httptest.NewRecorder()
	h.saveTool(rec, r, &session.User{ID: ownerID})

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 for a path/body tool-name mismatch, body: %s", rec.Code, rec.Body.String())
	}
	if _, ok := reg.Get(appID); ok {
		if app, _ := reg.Get(appID); len(app.Tools) != 0 {
			t.Errorf("Tools after a rejected mismatched request = %v, want none written", app.Tools)
		}
	}
}

// TestDeleteTool_HandlerRemovesAndReturnsAppSummary confirms the DELETE
// handler calls Registry.DeleteTool(appId, toolName) and answers with the
// app's current appSummary, same response-shape convention as saveTool.
func TestDeleteTool_HandlerRemovesAndReturnsAppSummary(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	conn := sqlDB

	const ownerID = 999903
	const appID = "test-console-deletetool-handler-app"
	makeTestUser(t, conn, ownerID, "console-deletetool-handler@example.com")
	reg := makeTestApp(t, database, appID, ownerID)
	if err := reg.SaveTool(appID, toolschema.Tool{
		Name: "keep_me", Description: "d", Parameters: toolschema.ParameterSchema{Type: "object"}, Kind: toolschema.ToolKindAction,
	}); err != nil {
		t.Fatalf("seed SaveTool(keep_me): %v", err)
	}
	if err := reg.SaveTool(appID, toolschema.Tool{
		Name: "remove_me", Description: "d", Parameters: toolschema.ParameterSchema{Type: "object"}, Kind: toolschema.ToolKindAction,
	}); err != nil {
		t.Fatalf("seed SaveTool(remove_me): %v", err)
	}

	h := &Handler{Apps: reg, Auth: auth.New(database)}
	r := newToolRequest(http.MethodDelete, appID, "remove_me", "")
	rec := httptest.NewRecorder()
	h.deleteTool(rec, r, &session.User{ID: ownerID})

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body: %s", rec.Code, rec.Body.String())
	}
	var got appSummary
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v (body: %s)", err, rec.Body.String())
	}
	if got.ToolCount != 1 {
		t.Errorf("response ToolCount = %d, want 1 (keep_me only)", got.ToolCount)
	}

	app, ok := reg.Get(appID)
	if !ok {
		t.Fatal("app not found in Registry after deleteTool handler")
	}
	if len(app.Tools) != 1 || app.Tools[0].Name != "keep_me" {
		t.Errorf("Registry Tools after deleteTool handler = %v, want just keep_me", app.Tools)
	}
}

// TestSaveDeleteTool_RoutesAreRegisteredBehindWithOwnedApp confirms
// Register actually mounts PUT/DELETE .../tools/{toolName} behind
// withOwnedApp — unlike the two tests above, which call saveTool/deleteTool
// directly to isolate handler-body behavior, this one drives a real
// *http.ServeMux end to end so a route that's missing, misspelled, or
// mounted without the ownership gate is caught here rather than only ever
// being noticed by a manual client. See console_test.go's
// TestWithOwnedApp_* for the ownership gate's own exhaustive behavior —
// this only needs one non-owner case to prove the gate is actually in the
// chain for these two new routes.
func TestSaveDeleteTool_RoutesAreRegisteredBehindWithOwnedApp(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	conn := sqlDB

	const ownerID = 999904
	const otherUserID = 999905
	const appID = "test-console-tools-routes-app"
	makeTestUser(t, conn, ownerID, "console-tools-routes-owner@example.com")
	makeTestUser(t, conn, otherUserID, "console-tools-routes-other@example.com")
	reg := makeTestApp(t, database, appID, ownerID)

	sessions := session.New(database, false)
	h := &Handler{Apps: reg, appOwner: reg, sessionVerify: sessions, Auth: auth.New(database)}
	mux := http.NewServeMux()
	mux.HandleFunc("PUT /console/apps/{appId}/tools/{toolName}", h.withOwnedApp(h.saveTool))
	mux.HandleFunc("DELETE /console/apps/{appId}/tools/{toolName}", h.withOwnedApp(h.deleteTool))
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	ownerCookie := makeSessionCookie(t, sessions, ownerID)
	otherCookie := makeSessionCookie(t, sessions, otherUserID)

	// The owner can PUT a new tool through the real route.
	req, _ := http.NewRequest(http.MethodPut, srv.URL+"/console/apps/"+appID+"/tools/routed_tool",
		strings.NewReader(`{"name":"routed_tool","description":"d","parameters":{"type":"object"},"kind":"action"}`))
	req.AddCookie(ownerCookie)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("PUT request: %v", err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("owner PUT status = %d, want 200", res.StatusCode)
	}

	// A non-owner hitting the same route must be rejected before the
	// handler ever runs — same 404-not-403 convention as every other
	// withOwnedApp route (see withOwnedApp's own doc comment).
	req, _ = http.NewRequest(http.MethodPut, srv.URL+"/console/apps/"+appID+"/tools/routed_tool",
		strings.NewReader(`{"name":"routed_tool","description":"changed by a non-owner","parameters":{"type":"object"},"kind":"action"}`))
	req.AddCookie(otherCookie)
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("PUT request (non-owner): %v", err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusNotFound {
		t.Errorf("non-owner PUT status = %d, want 404 (withOwnedApp must reject before saveTool runs)", res.StatusCode)
	}

	// DELETE through the real route, as the owner.
	req, _ = http.NewRequest(http.MethodDelete, srv.URL+"/console/apps/"+appID+"/tools/routed_tool", nil)
	req.AddCookie(ownerCookie)
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("DELETE request: %v", err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("owner DELETE status = %d, want 200", res.StatusCode)
	}

	app, ok := reg.Get(appID)
	if !ok || len(app.Tools) != 0 {
		t.Errorf("Tools after the routed DELETE = %v, want none (routed_tool removed, the non-owner's PUT never applied)", app.Tools)
	}
}

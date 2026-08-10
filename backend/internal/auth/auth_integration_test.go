//go:build integration

// Integration tests for auth.Store against a live Postgres. Excluded from
// the default build; run with:
//
//	go test -tags integration ./internal/auth/ \
//	  -args -dsn "postgres://platform:platform@localhost:5434/platform?sslmode=disable"
//
// This suite is meant to survive auth.go's planned rewrite from
// database/sql to GORM (see internal/db.DB's doc comment): it exercises
// Store's exported methods (Issue, Verify, HasKey, Revoke, SetOrigin,
// OriginFor) rather than the SQL used to get there.
//
// It also covers the single most important invariant for the upcoming
// migration: auth and toolschema.Registry share the `apps` table but each
// only touches its own columns (auth: api_key_hash, allowed_origin;
// toolschema: owner_id, thought, plus the whole `tools` table). If a GORM
// rewrite of either package swaps its targeted UPDATE for a bare
// gorm `Save()` (which writes every column, zeroing out whatever it
// doesn't know about), a write from one package would silently wipe the
// other's fields. TestAuthAndToolschemaDoNotOverwriteEachOther and
// TestToolschemaWritesDoNotOverwriteAuthFields exist specifically to catch
// that regression.
package auth

import (
	"database/sql"
	"flag"
	"testing"

	"github.com/tim72117/onagent/internal/db"
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
	t.Cleanup(func() { if sqlDB, err := database.DB(); err == nil { sqlDB.Close() } })
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

// makeTestApp creates appID via toolschema.Registry.Create, mirroring how a
// real app comes to exist before auth ever touches it (Issue/SetOrigin both
// require an existing apps row). Registers Delete via the same Registry as
// cleanup, exercising the CASCADE path tools rely on too.
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

// TestStoreCRUDLifecycle covers Issue/Verify/HasKey/Revoke/SetOrigin/
// OriginFor against an app that already exists.
func TestStoreCRUDLifecycle(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	conn := sqlDB

	const ownerID = 999901
	const appID = "test-auth-crud-app"
	makeTestUser(t, conn, ownerID, "auth-crud@example.com")
	makeTestApp(t, database, appID, ownerID)

	store := New(database)

	if store.HasKey(appID) {
		t.Fatalf("HasKey before Issue = true, want false")
	}

	key, err := store.Issue(appID)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if key == "" {
		t.Fatalf("Issue returned empty key")
	}
	if !store.HasKey(appID) {
		t.Fatalf("HasKey after Issue = false, want true")
	}

	result, ok := store.Verify(key)
	if !ok {
		t.Fatalf("Verify(issued key) ok = false, want true")
	}
	if result.AppID != appID {
		t.Fatalf("Verify(issued key).AppID = %q, want %q", result.AppID, appID)
	}
	if result.AllowedOrigin != "" {
		t.Fatalf("Verify(issued key).AllowedOrigin = %q, want empty before SetOrigin", result.AllowedOrigin)
	}

	// SetOrigin / OriginFor round-trip.
	if err := store.SetOrigin(appID, "https://example.com"); err != nil {
		t.Fatalf("SetOrigin: %v", err)
	}
	if got := store.OriginFor(appID); got != "https://example.com" {
		t.Fatalf("OriginFor after SetOrigin = %q, want %q", got, "https://example.com")
	}
	result, ok = store.Verify(key)
	if !ok || result.AllowedOrigin != "https://example.com" {
		t.Fatalf("Verify after SetOrigin = (%+v, %v), want AllowedOrigin=https://example.com, true", result, ok)
	}

	// Revoke clears the key: HasKey flips false, old key stops verifying.
	if err := store.Revoke(appID); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	if store.HasKey(appID) {
		t.Fatalf("HasKey after Revoke = true, want false")
	}
	if _, ok := store.Verify(key); ok {
		t.Fatalf("Verify(revoked key) ok = true, want false")
	}
}

// TestIssueFailsForNonexistentApp confirms Issue's documented behavior:
// it requires an existing apps row (UPDATE ... WHERE app_id = $2 with
// RowsAffected == 0 treated as an error), it does not create one.
func TestIssueFailsForNonexistentApp(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	conn := sqlDB
	store := New(database)

	const appID = "test-auth-no-such-app"
	// Guard against a stale row from a previous failed run.
	_, _ = conn.Exec(`DELETE FROM apps WHERE app_id = $1`, appID)

	if _, err := store.Issue(appID); err == nil {
		t.Fatalf("Issue against nonexistent app: got nil error, want an error")
	}
}

// TestHasKeyForNonexistentAppIsFalse confirms the EXISTS-based HasKey
// query returns false (not an error, not a panic) for an app_id with no
// row at all.
func TestHasKeyForNonexistentAppIsFalse(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	conn := sqlDB
	store := New(database)

	const appID = "test-auth-hasKey-nonexistent-app"
	_, _ = conn.Exec(`DELETE FROM apps WHERE app_id = $1`, appID)

	if store.HasKey(appID) {
		t.Fatalf("HasKey(nonexistent app) = true, want false")
	}
}

// TestAuthAndToolschemaDoNotOverwriteEachOther is the key regression test
// for the shared `apps` table: toolschema sets owner_id/thought, then auth
// issues a key and sets an origin on the SAME app row — and toolschema's
// fields must come back unchanged. See this file's package doc comment for
// why this specifically guards against a GORM `Save()`-style full-row
// overwrite creeping into either package's rewrite.
func TestAuthAndToolschemaDoNotOverwriteEachOther(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	conn := sqlDB

	const ownerID = 999902
	const appID = "test-auth-toolschema-isolation-app"
	makeTestUser(t, conn, ownerID, "auth-toolschema-isolation@example.com")
	reg := makeTestApp(t, database, appID, ownerID)

	if err := reg.SetThought(appID, "custom system prompt"); err != nil {
		t.Fatalf("SetThought: %v", err)
	}

	store := New(database)
	if _, err := store.Issue(appID); err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if err := store.SetOrigin(appID, "https://example.com"); err != nil {
		t.Fatalf("SetOrigin: %v", err)
	}

	// toolschema's fields must be untouched by auth's writes.
	if owner, ok := reg.OwnerOf(appID); !ok || owner != ownerID {
		t.Fatalf("OwnerOf after auth writes = (%d, %v), want (%d, true) — auth must not clear owner_id", owner, ok, ownerID)
	}
	app, ok := reg.Get(appID)
	if !ok {
		t.Fatalf("Get after auth writes: app not found")
	}
	if app.Thought != "custom system prompt" {
		t.Fatalf("Thought after auth writes = %q, want %q — auth must not clear thought", app.Thought, "custom system prompt")
	}
}

// TestToolschemaWritesDoNotOverwriteAuthFields is the mirror image of
// TestAuthAndToolschemaDoNotOverwriteEachOther: auth sets api_key_hash and
// allowed_origin first, then toolschema writes thought and a tool list on
// the same app — auth's fields must come back unchanged.
func TestToolschemaWritesDoNotOverwriteAuthFields(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	conn := sqlDB

	const ownerID = 999903
	const appID = "test-toolschema-auth-isolation-app"
	makeTestUser(t, conn, ownerID, "toolschema-auth-isolation@example.com")
	reg := makeTestApp(t, database, appID, ownerID)

	store := New(database)
	key, err := store.Issue(appID)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if err := store.SetOrigin(appID, "https://example.org"); err != nil {
		t.Fatalf("SetOrigin: %v", err)
	}

	// Now exercise toolschema's writes on the same app: SetThought and a
	// full Save (which upserts the app row and replaces its tool set).
	if err := reg.SetThought(appID, "another prompt"); err != nil {
		t.Fatalf("SetThought: %v", err)
	}
	app, ok := reg.Get(appID)
	if !ok {
		t.Fatalf("Get before Save: app not found")
	}
	app.Tools = []toolschema.Tool{{
		Name:        "some_tool",
		Description: "a tool",
		Parameters:  toolschema.ParameterSchema{Type: "object"},
		Kind:        toolschema.ToolKindAction,
	}}
	if err := reg.Save(app); err != nil {
		t.Fatalf("Save: %v", err)
	}

	// auth's fields must be untouched by toolschema's writes.
	if !store.HasKey(appID) {
		t.Fatalf("HasKey after toolschema writes = false, want true — toolschema must not clear api_key_hash")
	}
	if got := store.OriginFor(appID); got != "https://example.org" {
		t.Fatalf("OriginFor after toolschema writes = %q, want %q — toolschema must not clear allowed_origin", got, "https://example.org")
	}
	if result, ok := store.Verify(key); !ok || result.AppID != appID {
		t.Fatalf("Verify(original key) after toolschema writes = (%+v, %v), want (AppID=%s, true)", result, ok, appID)
	}
}

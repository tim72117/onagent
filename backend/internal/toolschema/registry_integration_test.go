//go:build integration

// Integration tests for toolschema.Registry against a live Postgres.
// Excluded from the default build; run with:
//
//	go test -tags integration ./internal/toolschema/ \
//	  -args -dsn "postgres://platform:platform@localhost:5434/platform?sslmode=disable"
//
// This suite is meant to survive registry.go's planned rewrite from
// database/sql to GORM (see internal/db.DB's doc comment): it exercises
// Registry's exported methods (Create, Save, Delete, OwnerOf, SetThought,
// OwnedBy, Get) rather than the SQL used to get there, so it keeps
// validating behavior — in particular the apps/tools field ownership and
// saveApp's replace-all semantics — no matter how the underlying queries
// are written.
package toolschema

import (
	"database/sql"
	"flag"
	"testing"

	"github.com/tim72117/onagent/internal/db"
	"gorm.io/gorm"
)

var dsn = flag.String("dsn", "postgres://platform:platform@localhost:5434/platform?sslmode=disable", "Postgres DSN")

// openTestDB opens the shared dev Postgres, skipping (not failing) the test
// when it isn't reachable, matching this repo's other integration tests.
func openTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	database, err := db.Open(*dsn)
	if err != nil {
		t.Skipf("no reachable Postgres at %s (%v) — skipping integration test", *dsn, err)
	}
	t.Cleanup(func() { if sqlDB, err := database.DB(); err == nil { sqlDB.Close() } })
	return database
}

// makeTestUser inserts a throwaway users row at a high, collision-avoiding
// id and registers its cleanup. Deleting the user CASCADEs to apps (and from
// there, tools), so this alone is enough to clean up anything hung off it —
// but tests also explicitly delete their app via the Registry under test,
// since that's part of what's being exercised.
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

func sampleTool(name string) Tool {
	return Tool{
		Name:        name,
		Description: "test tool " + name,
		Parameters:  ParameterSchema{Type: "object"},
		Kind:        ToolKindAction,
	}
}

// TestRegistryCRUDLifecycle covers the basic Create/SetThought/Save/
// OwnedBy/Delete flow through the Registry's exported API, checking that
// each write is visible through the corresponding read afterward.
func TestRegistryCRUDLifecycle(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	conn := sqlDB

	const ownerID = 999801
	const appID = "test-toolschema-crud-app"
	makeTestUser(t, conn, ownerID, "toolschema-crud@example.com")
	t.Cleanup(func() {
		_, _ = conn.Exec(`DELETE FROM apps WHERE app_id = $1`, appID)
	})

	reg, err := NewRegistry(database)
	if err != nil {
		t.Fatalf("NewRegistry: %v", err)
	}

	if err := reg.Create(appID, ownerID); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if owner, ok := reg.OwnerOf(appID); !ok || owner != ownerID {
		t.Fatalf("OwnerOf after Create = (%d, %v), want (%d, true)", owner, ok, ownerID)
	}

	app, ok := reg.Get(appID)
	if !ok {
		t.Fatalf("Get after Create: app not found")
	}
	if len(app.Tools) != 0 {
		t.Fatalf("Get after Create: Tools = %v, want empty", app.Tools)
	}

	// Save a tool list and confirm it round-trips through Get.
	app.Tools = []Tool{sampleTool("tool_a"), sampleTool("tool_b")}
	if err := reg.Save(app); err != nil {
		t.Fatalf("Save: %v", err)
	}
	got, ok := reg.Get(appID)
	if !ok {
		t.Fatalf("Get after Save: app not found")
	}
	if len(got.Tools) != 2 {
		t.Fatalf("Get after Save: len(Tools) = %d, want 2", len(got.Tools))
	}
	names := map[string]bool{}
	for _, tl := range got.Tools {
		names[tl.Name] = true
	}
	if !names["tool_a"] || !names["tool_b"] {
		t.Fatalf("Get after Save: tool names = %v, want tool_a and tool_b", names)
	}

	// SetThought.
	if err := reg.SetThought(appID, "be extra helpful"); err != nil {
		t.Fatalf("SetThought: %v", err)
	}
	got, ok = reg.Get(appID)
	if !ok || got.Thought != "be extra helpful" {
		t.Fatalf("Get after SetThought: Thought = %q, ok=%v, want %q, true", got.Thought, ok, "be extra helpful")
	}

	// OwnedBy lists this app for its owner.
	ids, err := reg.OwnedBy(ownerID)
	if err != nil {
		t.Fatalf("OwnedBy: %v", err)
	}
	found := false
	for _, id := range ids {
		if id == appID {
			found = true
		}
	}
	if !found {
		t.Fatalf("OwnedBy(%d) = %v, want to contain %q", ownerID, ids, appID)
	}

	// Delete removes the app and CASCADEs its tools.
	if err := reg.Delete(appID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, ok := reg.Get(appID); ok {
		t.Fatalf("Get after Delete: app still present")
	}
	var toolCount int
	if err := conn.QueryRow(`SELECT count(*) FROM tools WHERE app_id = $1`, appID).Scan(&toolCount); err != nil {
		t.Fatalf("count tools after Delete: %v", err)
	}
	if toolCount != 0 {
		t.Fatalf("tools rows remaining after Delete = %d, want 0 (CASCADE should have removed them)", toolCount)
	}
}

// TestSaveReplacesToolSet confirms Save has replace-all semantics: saving a
// smaller tool list must remove the tools that were dropped, not merge with
// or diff against the previous set. This is the core regression test for
// saveApp's "DELETE then INSERT inside one transaction" strategy — a naive
// GORM rewrite using upsert-only (no delete of the old rows) would leave
// stale tools behind and this test would catch it.
func TestSaveReplacesToolSet(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	conn := sqlDB

	const ownerID = 999802
	const appID = "test-toolschema-replace-app"
	makeTestUser(t, conn, ownerID, "toolschema-replace@example.com")
	t.Cleanup(func() {
		_, _ = conn.Exec(`DELETE FROM apps WHERE app_id = $1`, appID)
	})

	reg, err := NewRegistry(database)
	if err != nil {
		t.Fatalf("NewRegistry: %v", err)
	}
	if err := reg.Create(appID, ownerID); err != nil {
		t.Fatalf("Create: %v", err)
	}

	// First save: 3 tools.
	app := &App{AppID: appID, Tools: []Tool{
		sampleTool("tool_1"), sampleTool("tool_2"), sampleTool("tool_3"),
	}}
	if err := reg.Save(app); err != nil {
		t.Fatalf("first Save: %v", err)
	}
	got, ok := reg.Get(appID)
	if !ok || len(got.Tools) != 3 {
		t.Fatalf("after first Save: len(Tools) = %d, ok=%v, want 3, true", len(got.Tools), ok)
	}

	// Second save: only 1 tool, none of which overlaps the first 3.
	app2 := &App{AppID: appID, Tools: []Tool{sampleTool("tool_only")}}
	if err := reg.Save(app2); err != nil {
		t.Fatalf("second Save: %v", err)
	}
	got, ok = reg.Get(appID)
	if !ok {
		t.Fatalf("after second Save: app not found")
	}
	if len(got.Tools) != 1 {
		t.Fatalf("after second Save: len(Tools) = %d, want 1 (replace-all should have dropped tool_1..3)", len(got.Tools))
	}
	if got.Tools[0].Name != "tool_only" {
		t.Fatalf("after second Save: Tools = %v, want just tool_only", got.Tools)
	}
}

// TestSaveDoesNotOverwriteExistingOwner confirms saveApp's
// `INSERT ... ON CONFLICT (app_id) DO NOTHING` really is a no-op for an app
// that already exists: calling Save (which upserts the app row before
// replacing tools) on an app created with Create(appID, ownerID) must never
// clear or change owner_id. A GORM rewrite that swaps this upsert for a
// blind Save()/full-row-write would zero out owner_id here, and this test
// would catch it.
func TestSaveDoesNotOverwriteExistingOwner(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	conn := sqlDB

	const ownerID = 999803
	const appID = "test-toolschema-ownerpreserve-app"
	makeTestUser(t, conn, ownerID, "toolschema-ownerpreserve@example.com")
	t.Cleanup(func() {
		_, _ = conn.Exec(`DELETE FROM apps WHERE app_id = $1`, appID)
	})

	reg, err := NewRegistry(database)
	if err != nil {
		t.Fatalf("NewRegistry: %v", err)
	}
	if err := reg.Create(appID, ownerID); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if owner, ok := reg.OwnerOf(appID); !ok || owner != ownerID {
		t.Fatalf("OwnerOf after Create = (%d, %v), want (%d, true)", owner, ok, ownerID)
	}

	app := &App{AppID: appID, Tools: []Tool{sampleTool("t1")}}
	if err := reg.Save(app); err != nil {
		t.Fatalf("Save: %v", err)
	}

	if owner, ok := reg.OwnerOf(appID); !ok || owner != ownerID {
		t.Fatalf("OwnerOf after Save = (%d, %v), want (%d, true) — Save must not clear owner_id", owner, ok, ownerID)
	}
}

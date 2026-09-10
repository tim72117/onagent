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

	if err := reg.Create(appID, ownerID, false); err != nil {
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

	// SaveTool each tool and confirm they round-trip through Get.
	if _, err := reg.SaveTool(appID, sampleTool("tool_a")); err != nil {
		t.Fatalf("SaveTool(tool_a): %v", err)
	}
	if _, err := reg.SaveTool(appID, sampleTool("tool_b")); err != nil {
		t.Fatalf("SaveTool(tool_b): %v", err)
	}
	got, ok := reg.Get(appID)
	if !ok {
		t.Fatalf("Get after SaveTool: app not found")
	}
	if len(got.Tools) != 2 {
		t.Fatalf("Get after SaveTool: len(Tools) = %d, want 2", len(got.Tools))
	}
	names := map[string]bool{}
	for _, tl := range got.Tools {
		names[tl.Name] = true
	}
	if !names["tool_a"] || !names["tool_b"] {
		t.Fatalf("Get after SaveTool: tool names = %v, want tool_a and tool_b", names)
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

// --- SaveTool/DeleteTool (single-tool upsert/delete, backing the CLI's
// `onagent tool create` and the console front-end's per-tool editor — see
// PUT/DELETE /console/apps/{appId}/tools/{toolName}) ---
//
// The console tool editor and the CLI used to share Save/saveApp's
// replace-all semantics (send the whole intended tool list, the backend
// deletes everything and reinserts it) — removed along with these tests
// once both callers moved to per-tool writes: neither the console's
// immediate-write editor nor a CLI user describing "add one tool" via
// `onagent tool create <appId> <tool.yaml>` has (or wants) the rest of the
// app's current tool set in hand just to avoid clobbering it via a
// replace-all write.

// TestSaveTool_AddsWithoutTouchingOthers confirms SaveTool only ever
// touches the one named tool, never any other tool already on the app.
func TestSaveTool_AddsWithoutTouchingOthers(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	conn := sqlDB

	const ownerID = 999804
	const appID = "test-toolschema-savetool-add-app"
	makeTestUser(t, conn, ownerID, "toolschema-savetool-add@example.com")
	t.Cleanup(func() {
		_, _ = conn.Exec(`DELETE FROM apps WHERE app_id = $1`, appID)
	})

	reg, err := NewRegistry(database)
	if err != nil {
		t.Fatalf("NewRegistry: %v", err)
	}
	if err := reg.Create(appID, ownerID, false); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, err := reg.SaveTool(appID, sampleTool("existing_1")); err != nil {
		t.Fatalf("seed SaveTool(existing_1): %v", err)
	}
	if _, err := reg.SaveTool(appID, sampleTool("existing_2")); err != nil {
		t.Fatalf("seed SaveTool(existing_2): %v", err)
	}

	if _, err := reg.SaveTool(appID, sampleTool("new_tool")); err != nil {
		t.Fatalf("SaveTool: %v", err)
	}

	got, ok := reg.Get(appID)
	if !ok {
		t.Fatal("app not found after SaveTool")
	}
	names := make(map[string]bool, len(got.Tools))
	for _, tool := range got.Tools {
		names[tool.Name] = true
	}
	if len(got.Tools) != 3 || !names["existing_1"] || !names["existing_2"] || !names["new_tool"] {
		t.Fatalf("Tools after SaveTool = %v, want existing_1, existing_2, and new_tool all present (3 total)", got.Tools)
	}
}

// TestSaveTool_UpdatesExistingToolInPlace confirms calling SaveTool again
// with the same tool name overwrites that one tool's fields (description
// here) without duplicating it or disturbing any other tool — the "create
// or update" half of upsert.
func TestSaveTool_UpdatesExistingToolInPlace(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	conn := sqlDB

	const ownerID = 999805
	const appID = "test-toolschema-savetool-update-app"
	makeTestUser(t, conn, ownerID, "toolschema-savetool-update@example.com")
	t.Cleanup(func() {
		_, _ = conn.Exec(`DELETE FROM apps WHERE app_id = $1`, appID)
	})

	reg, err := NewRegistry(database)
	if err != nil {
		t.Fatalf("NewRegistry: %v", err)
	}
	if err := reg.Create(appID, ownerID, false); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, err := reg.SaveTool(appID, sampleTool("other_tool")); err != nil {
		t.Fatalf("seed SaveTool(other_tool): %v", err)
	}
	if _, err := reg.SaveTool(appID, sampleTool("target_tool")); err != nil {
		t.Fatalf("seed SaveTool(target_tool): %v", err)
	}

	updated := sampleTool("target_tool")
	updated.Description = "an updated description"
	if _, err := reg.SaveTool(appID, updated); err != nil {
		t.Fatalf("SaveTool: %v", err)
	}

	got, ok := reg.Get(appID)
	if !ok {
		t.Fatal("app not found after SaveTool")
	}
	if len(got.Tools) != 2 {
		t.Fatalf("Tools after SaveTool = %v, want exactly 2 (target_tool updated in place, other_tool untouched)", got.Tools)
	}
	var found bool
	for _, tool := range got.Tools {
		if tool.Name != "target_tool" {
			continue
		}
		found = true
		if tool.Description != "an updated description" {
			t.Errorf("target_tool.Description = %q, want %q", tool.Description, "an updated description")
		}
	}
	if !found {
		t.Fatal("target_tool missing after SaveTool — update must not have removed and failed to reinsert it")
	}
}

// TestSaveTool_RenameByIDUpdatesInPlace is the regression test for the bug
// that motivated adding tools.id at all (see this package's saveTool doc
// comment and apps/console/src/App.tsx's old persistTool): renaming a tool
// by passing its existing ID with a new Name must be a single atomic
// UPDATE — the row's id, position, and every other field stay unchanged,
// and there is no point in time where a caller re-reading the app would
// see neither the old name nor the new one (the failure mode the old
// delete-old-name-then-insert-new-name two-step could hit if the insert
// half failed after the delete half committed).
func TestSaveTool_RenameByIDUpdatesInPlace(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	conn := sqlDB

	const ownerID = 999807
	const appID = "test-toolschema-savetool-rename-app"
	makeTestUser(t, conn, ownerID, "toolschema-savetool-rename@example.com")
	t.Cleanup(func() {
		_, _ = conn.Exec(`DELETE FROM apps WHERE app_id = $1`, appID)
	})

	reg, err := NewRegistry(database)
	if err != nil {
		t.Fatalf("NewRegistry: %v", err)
	}
	if err := reg.Create(appID, ownerID, false); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, err := reg.SaveTool(appID, sampleTool("sibling_tool")); err != nil {
		t.Fatalf("seed SaveTool(sibling_tool): %v", err)
	}
	id, err := reg.SaveTool(appID, sampleTool("old_name"))
	if err != nil {
		t.Fatalf("seed SaveTool(old_name): %v", err)
	}
	if id == 0 {
		t.Fatal("SaveTool returned id 0 for a brand-new tool, want a real assigned id")
	}

	renamed := sampleTool("old_name")
	renamed.ID = id
	renamed.Name = "new_name"
	renamed.Description = "renamed via id"
	gotID, err := reg.SaveTool(appID, renamed)
	if err != nil {
		t.Fatalf("SaveTool (rename by id): %v", err)
	}
	if gotID != id {
		t.Errorf("SaveTool (rename) returned id %d, want the same id %d — a rename must not change the row's identity", gotID, id)
	}

	app, ok := reg.Get(appID)
	if !ok {
		t.Fatal("app not found after rename")
	}
	if len(app.Tools) != 2 {
		t.Fatalf("Tools after rename = %v, want exactly 2 (renamed tool + sibling_tool) — a broken rename could leave 1 (old row deleted, insert failed) or 3 (both old and new names present)", app.Tools)
	}
	var found bool
	for _, tool := range app.Tools {
		if tool.Name == "old_name" {
			t.Errorf("old_name still present after rename — this is exactly the delete-then-insert failure mode the id column exists to prevent")
		}
		if tool.Name == "new_name" {
			found = true
			if tool.ID != id {
				t.Errorf("new_name's ID = %d, want unchanged %d", tool.ID, id)
			}
			if tool.Description != "renamed via id" {
				t.Errorf("new_name's Description = %q, want %q", tool.Description, "renamed via id")
			}
		}
	}
	if !found {
		t.Fatal("new_name missing after rename")
	}

	// The row's id itself never changed at the database level either — not
	// just "a tool with this name and these fields exists somewhere."
	var dbName string
	if err := conn.QueryRow(`SELECT name FROM tools WHERE id = $1`, id).Scan(&dbName); err != nil {
		t.Fatalf("query tools by id: %v", err)
	}
	if dbName != "new_name" {
		t.Errorf("tools.name for id %d = %q, want %q — the SAME row must have been updated, not a new row inserted under a new id", id, dbName, "new_name")
	}
}

// TestSaveTool_UnknownAppErrors — SaveTool must refuse to write a tool row
// for an app_id that was never created via Registry.Create, the same "app
// must already exist" invariant the old saveApp enforced (see
// apps.owner_id being NOT NULL: a tool row for a nonexistent app_id would
// either violate the tools.app_id foreign key or, worse on an older schema,
// silently create orphaned data).
func TestSaveTool_UnknownAppErrors(t *testing.T) {
	database := openTestDB(t)
	reg, err := NewRegistry(database)
	if err != nil {
		t.Fatalf("NewRegistry: %v", err)
	}

	_, err = reg.SaveTool("test-toolschema-savetool-no-such-app", sampleTool("t1"))
	if err == nil {
		t.Fatal("SaveTool against a nonexistent app returned nil error, want an error")
	}
}

// TestSaveTool_InvalidToolErrors confirms SaveTool validates the tool it's
// given (Tool's own validation, whatever App.Validate used to apply
// per-tool) — a malformed single tool (empty name) from a hand-edited CLI
// tool.yaml or a console editor bug must be rejected with a clear error,
// not silently written or left to fail obscurely at the database layer.
func TestSaveTool_InvalidToolErrors(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	conn := sqlDB

	const ownerID = 999806
	const appID = "test-toolschema-savetool-invalid-app"
	makeTestUser(t, conn, ownerID, "toolschema-savetool-invalid@example.com")
	t.Cleanup(func() {
		_, _ = conn.Exec(`DELETE FROM apps WHERE app_id = $1`, appID)
	})

	reg, err := NewRegistry(database)
	if err != nil {
		t.Fatalf("NewRegistry: %v", err)
	}
	if err := reg.Create(appID, ownerID, false); err != nil {
		t.Fatalf("Create: %v", err)
	}

	_, err = reg.SaveTool(appID, Tool{Name: "", Description: "missing a name"})
	if err == nil {
		t.Fatal("SaveTool with an empty tool name returned nil error, want a validation error")
	}
}

// TestSaveTool_DoesNotOverwriteExistingOwner confirms SaveTool (which, like
// the old saveApp, may need to touch the apps row on a first-ever write to
// establish e.g. updated_at bookkeeping) never clears or changes owner_id
// on an app created with Create(appID, ownerID) — the same owner-preserving
// guarantee saveApp's own ON CONFLICT DO NOTHING used to provide, now
// re-pinned against SaveTool since that's the only write path left.
func TestSaveTool_DoesNotOverwriteExistingOwner(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	conn := sqlDB

	const ownerID = 999807
	const appID = "test-toolschema-savetool-ownerpreserve-app"
	makeTestUser(t, conn, ownerID, "toolschema-savetool-ownerpreserve@example.com")
	t.Cleanup(func() {
		_, _ = conn.Exec(`DELETE FROM apps WHERE app_id = $1`, appID)
	})

	reg, err := NewRegistry(database)
	if err != nil {
		t.Fatalf("NewRegistry: %v", err)
	}
	if err := reg.Create(appID, ownerID, false); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if owner, ok := reg.OwnerOf(appID); !ok || owner != ownerID {
		t.Fatalf("OwnerOf after Create = (%d, %v), want (%d, true)", owner, ok, ownerID)
	}

	if _, err := reg.SaveTool(appID, sampleTool("t1")); err != nil {
		t.Fatalf("SaveTool: %v", err)
	}

	if owner, ok := reg.OwnerOf(appID); !ok || owner != ownerID {
		t.Fatalf("OwnerOf after SaveTool = (%d, %v), want (%d, true) — SaveTool must not clear owner_id", owner, ok, ownerID)
	}
}

// TestDeleteTool_RemovesOnlyThatTool confirms DeleteTool removes exactly
// the named tool and leaves every other tool on the app untouched — the
// delete counterpart to SaveTool's upsert, needed now that the console
// editor's "remove a tool" action can no longer ride along with a
// replace-all Save.
func TestDeleteTool_RemovesOnlyThatTool(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	conn := sqlDB

	const ownerID = 999808
	const appID = "test-toolschema-deletetool-app"
	makeTestUser(t, conn, ownerID, "toolschema-deletetool@example.com")
	t.Cleanup(func() {
		_, _ = conn.Exec(`DELETE FROM apps WHERE app_id = $1`, appID)
	})

	reg, err := NewRegistry(database)
	if err != nil {
		t.Fatalf("NewRegistry: %v", err)
	}
	if err := reg.Create(appID, ownerID, false); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, err := reg.SaveTool(appID, sampleTool("keep_1")); err != nil {
		t.Fatalf("seed SaveTool(keep_1): %v", err)
	}
	if _, err := reg.SaveTool(appID, sampleTool("to_delete")); err != nil {
		t.Fatalf("seed SaveTool(to_delete): %v", err)
	}
	if _, err := reg.SaveTool(appID, sampleTool("keep_2")); err != nil {
		t.Fatalf("seed SaveTool(keep_2): %v", err)
	}

	if err := reg.DeleteTool(appID, "to_delete"); err != nil {
		t.Fatalf("DeleteTool: %v", err)
	}

	got, ok := reg.Get(appID)
	if !ok {
		t.Fatal("app not found after DeleteTool")
	}
	names := make(map[string]bool, len(got.Tools))
	for _, tool := range got.Tools {
		names[tool.Name] = true
	}
	if len(got.Tools) != 2 || !names["keep_1"] || !names["keep_2"] || names["to_delete"] {
		t.Fatalf("Tools after DeleteTool = %v, want keep_1 and keep_2 only (to_delete removed)", got.Tools)
	}
}

// TestDeleteTool_UnknownToolIsNoOp mirrors Registry.Delete's own "deleting
// something already gone is the caller's desired end state either way"
// convention (see Delete's doc comment) — deleting a tool name that never
// existed on the app must not error.
func TestDeleteTool_UnknownToolIsNoOp(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	conn := sqlDB

	const ownerID = 999809
	const appID = "test-toolschema-deletetool-noop-app"
	makeTestUser(t, conn, ownerID, "toolschema-deletetool-noop@example.com")
	t.Cleanup(func() {
		_, _ = conn.Exec(`DELETE FROM apps WHERE app_id = $1`, appID)
	})

	reg, err := NewRegistry(database)
	if err != nil {
		t.Fatalf("NewRegistry: %v", err)
	}
	if err := reg.Create(appID, ownerID, false); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, err := reg.SaveTool(appID, sampleTool("kept")); err != nil {
		t.Fatalf("seed SaveTool: %v", err)
	}

	if err := reg.DeleteTool(appID, "never_existed"); err != nil {
		t.Fatalf("DeleteTool for a nonexistent tool name returned an error, want nil: %v", err)
	}

	got, ok := reg.Get(appID)
	if !ok || len(got.Tools) != 1 || got.Tools[0].Name != "kept" {
		t.Fatalf("Tools after no-op DeleteTool = %v, want just kept, untouched", got.Tools)
	}
}

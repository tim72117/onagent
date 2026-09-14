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
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/tim72117/onagent/internal/db"
	"github.com/tim72117/onagent/internal/events"
	"github.com/tim72117/onagent/internal/notify"
	"gorm.io/gorm"
)

// testLogger is a discard-everything logger for events.NewBus, which only
// ever uses it to report a subscriber panic (see events.Bus.Publish) —
// nothing this suite's subscribers do should panic, so there's nothing
// worth asserting on here.
func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

var dsn = flag.String("dsn", "postgres://platform:platform@localhost:5434/platform?sslmode=disable", "Postgres DSN")

// openTestDB opens the shared dev Postgres, skipping (not failing) the test
// when it isn't reachable, matching this repo's other integration tests.
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

// TestSetMaxPromptLength covers setting, clearing, and rejecting invalid
// values for an app's own per-prompt character cap (the app-level half of
// inference.EffectiveMaxPromptLength's two-layer clamp).
func TestSetMaxPromptLength(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	conn := sqlDB

	const ownerID = 999810
	const appID = "test-toolschema-maxpromptlength-app"
	makeTestUser(t, conn, ownerID, "toolschema-maxpromptlength@example.com")
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

	// A freshly created app has no app-specific limit.
	app, ok := reg.Get(appID)
	if !ok || app.MaxPromptLength != nil {
		t.Fatalf("Get after Create: MaxPromptLength = %v, want nil", app.MaxPromptLength)
	}

	// Setting a positive value round-trips through Get.
	limit := 200
	if err := reg.SetMaxPromptLength(appID, &limit); err != nil {
		t.Fatalf("SetMaxPromptLength(200): %v", err)
	}
	app, ok = reg.Get(appID)
	if !ok || app.MaxPromptLength == nil || *app.MaxPromptLength != 200 {
		t.Fatalf("Get after SetMaxPromptLength(200): MaxPromptLength = %v, want 200", app.MaxPromptLength)
	}

	// Clearing (nil) falls back to no app-specific limit.
	if err := reg.SetMaxPromptLength(appID, nil); err != nil {
		t.Fatalf("SetMaxPromptLength(nil): %v", err)
	}
	app, ok = reg.Get(appID)
	if !ok || app.MaxPromptLength != nil {
		t.Fatalf("Get after SetMaxPromptLength(nil): MaxPromptLength = %v, want nil", app.MaxPromptLength)
	}

	// Zero and negative values are rejected outright — not a meaningful
	// limit a developer would actually want; clearing (nil) is the way to
	// fall back to the system-wide default instead.
	zero := 0
	if err := reg.SetMaxPromptLength(appID, &zero); err == nil {
		t.Fatalf("SetMaxPromptLength(0) = nil error, want an error")
	}
	negative := -5
	if err := reg.SetMaxPromptLength(appID, &negative); err == nil {
		t.Fatalf("SetMaxPromptLength(-5) = nil error, want an error")
	}

	// A nonexistent app is an error, not a silent no-op.
	if err := reg.SetMaxPromptLength("no-such-app-at-all", &limit); err == nil {
		t.Fatalf("SetMaxPromptLength on a nonexistent app = nil error, want an error")
	}
}

// TestSaveTool_PublishesToolCreatedEvent confirms SaveTool publishes
// "tool.created" through a wired events.Bus when it inserts a brand-new
// tool — the actual event-source demonstration for the events package
// (see internal/events' own doc comment on the event -> rule ->
// notification pipeline this is the first layer of). Registry.events is
// nil (no publish at all) unless SetEventBus is called, so this also
// covers that opt-in wiring actually working end to end, not just that
// events.Bus.Publish/Subscribe work in isolation (see events_test.go for
// that).
func TestSaveTool_PublishesToolCreatedEvent(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	conn := sqlDB

	const ownerID = 999811
	const appID = "test-toolschema-events-app"
	makeTestUser(t, conn, ownerID, "toolschema-events@example.com")
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

	bus := events.NewBus(testLogger())
	received := make(chan events.Event, 1)
	bus.Subscribe("tool.created", func(e events.Event) { received <- e })
	reg.SetEventBus(bus)

	if _, err := reg.SaveTool(appID, sampleTool("event_tool")); err != nil {
		t.Fatalf("SaveTool: %v", err)
	}

	// SaveTool publishes on its own goroutine (see its own doc comment) —
	// a channel receive with a timeout is the only reliable way to observe
	// that without an arbitrary sleep.
	select {
	case e := <-received:
		if e.SubjectID != appID {
			t.Errorf("event SubjectID = %q, want %q", e.SubjectID, appID)
		}
		if e.Metadata["toolName"] != "event_tool" {
			t.Errorf("event Metadata[toolName] = %v, want %q", e.Metadata["toolName"], "event_tool")
		}
		if e.Metadata["isFirst"] != true {
			t.Errorf("event Metadata[isFirst] = %v, want true (this is the app's only tool)", e.Metadata["isFirst"])
		}
	case <-time.After(2 * time.Second):
		t.Fatal("did not receive tool.created event within 2s")
	}
}

// TestSaveTool_SecondToolPublishesIsFirstFalse confirms the isFirst
// metadata flag (used by notify's first_tool_and_feedback PairRule to
// gate side A — see cmd/server/main.go) is false once the app already has
// another tool, not just true-by-default on every create.
func TestSaveTool_SecondToolPublishesIsFirstFalse(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	conn := sqlDB

	const ownerID = 999813
	const appID = "test-toolschema-events-second-tool-app"
	makeTestUser(t, conn, ownerID, "toolschema-events-second-tool@example.com")
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
	if _, err := reg.SaveTool(appID, sampleTool("first_tool")); err != nil {
		t.Fatalf("seed SaveTool(first_tool): %v", err)
	}

	bus := events.NewBus(testLogger())
	received := make(chan events.Event, 1)
	bus.Subscribe("tool.created", func(e events.Event) { received <- e })
	reg.SetEventBus(bus)

	if _, err := reg.SaveTool(appID, sampleTool("second_tool")); err != nil {
		t.Fatalf("SaveTool(second_tool): %v", err)
	}

	select {
	case e := <-received:
		if e.Metadata["isFirst"] != false {
			t.Errorf("event Metadata[isFirst] = %v, want false (this app already had a tool)", e.Metadata["isFirst"])
		}
	case <-time.After(2 * time.Second):
		t.Fatal("did not receive tool.created event within 2s")
	}
}

// TestSaveTool_UpdateDoesNotPublishToolCreatedEvent confirms updating an
// EXISTING tool (tool.ID != 0) does not publish "tool.created" a second
// time — only an actual insert should. Without this, editing a tool's
// description a dozen times would fire a dozen misleading
// "tool created" events.
func TestSaveTool_UpdateDoesNotPublishToolCreatedEvent(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	conn := sqlDB

	const ownerID = 999812
	const appID = "test-toolschema-events-update-app"
	makeTestUser(t, conn, ownerID, "toolschema-events-update@example.com")
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

	id, err := reg.SaveTool(appID, sampleTool("update_me"))
	if err != nil {
		t.Fatalf("seed SaveTool: %v", err)
	}

	bus := events.NewBus(testLogger())
	received := make(chan events.Event, 1)
	bus.Subscribe("tool.created", func(e events.Event) { received <- e })
	reg.SetEventBus(bus)

	updated := sampleTool("update_me")
	updated.ID = id
	updated.Description = "an updated description"
	if _, err := reg.SaveTool(appID, updated); err != nil {
		t.Fatalf("update SaveTool: %v", err)
	}

	select {
	case e := <-received:
		t.Fatalf("tool.created event published for an UPDATE, want none: %+v", e)
	case <-time.After(300 * time.Millisecond):
		// Expected: no event within a generous grace period.
	}
}

// TestFirstAppAndFeedbackRule_EndToEnd is the full pipeline demonstration:
// events.Bus (internal/events) + notify.Engine (internal/notify) +
// toolschema.Registry.Create's real "app.created" publish, wired up
// exactly the way cmd/server/main.go wires them for the actual
// first_app_and_feedback PairRule — the same rule construction is
// duplicated here (rather than importing it from cmd/server, which isn't
// an importable package) specifically so this test proves the pipeline
// works end to end against a real Postgres, not just that each layer
// works in isolation (registry_integration_test.go's own
// TestRegistryCRUDLifecycle and notify's own unit/integration tests
// already cover the layers separately).
func TestFirstAppAndFeedbackRule_EndToEnd(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	conn := sqlDB

	const ownerID = 999814
	const appID = "test-toolschema-e2e-first-app-feedback-app"
	makeTestUser(t, conn, ownerID, "toolschema-e2e@example.com")
	t.Cleanup(func() {
		_, _ = conn.Exec(`DELETE FROM apps WHERE app_id = $1`, appID)
		_, _ = conn.Exec(`DELETE FROM notifications WHERE subject_id = $1`, appID)
		_, _ = conn.Exec(`DELETE FROM rule_progress WHERE subject_id = $1`, appID)
	})

	reg, err := NewRegistry(database)
	if err != nil {
		t.Fatalf("NewRegistry: %v", err)
	}

	bus := events.NewBus(testLogger())
	reg.SetEventBus(bus)

	rule := notify.PairRule{
		Name:       "first_app_and_feedback",
		EventTypeA: "app.created",
		EventTypeB: "feedback.submitted",
		Build: func(subjectID string) notify.Action {
			return notify.CreateNotification{
				SubjectID: subjectID,
				Title:     "You're all set up!",
				Body:      "You've created an app and shared feedback.",
			}
		},
	}
	engine := notify.NewEngine(nil, []notify.PairRule{rule}, notify.NewGormNotificationStore(database), notify.NewGormProgressStore(database), testLogger())
	engine.Register(bus)

	// Side A: create the app. SetEventBus above ran BEFORE this, unlike
	// the old tool-based version of this test — app.created only ever
	// fires once, at Create time, so the bus has to be wired up before
	// that call, not after seeding some earlier state.
	if err := reg.Create(appID, ownerID, false); err != nil {
		t.Fatalf("Create: %v", err)
	}

	// Registry.Create's publish is fire-and-forget on its own goroutine —
	// poll briefly for rule_progress's a_done_at to land before firing
	// side B, rather than assuming it already has by the time we get here.
	deadline := time.Now().Add(2 * time.Second)
	for {
		var count int64
		if err := database.Table("rule_progress").
			Where("subject_id = ? AND rule_name = ? AND a_done_at IS NOT NULL", appID, "first_app_and_feedback").
			Count(&count).Error; err != nil {
			t.Fatalf("query rule_progress: %v", err)
		}
		if count == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("side A (app.created) never registered in rule_progress within 2s")
		}
		time.Sleep(20 * time.Millisecond)
	}

	// Side B: submit feedback (published directly here — this test doesn't
	// go through console.Handler.submitFeedback, which has its own unit
	// tests for the HTTP-layer behavior).
	bus.Publish(events.Event{Type: "feedback.submitted", SubjectID: appID})

	deadline = time.Now().Add(2 * time.Second)
	for {
		var rows []struct {
			Title string
			Body  string
		}
		if err := database.Table("notifications").
			Select("title, body").
			Where("subject_id = ? AND rule_name = ?", appID, "first_app_and_feedback").
			Find(&rows).Error; err != nil {
			t.Fatalf("query notifications: %v", err)
		}
		if len(rows) == 1 {
			if rows[0].Title != "You're all set up!" {
				t.Errorf("notification Title = %q, want %q", rows[0].Title, "You're all set up!")
			}
			return
		}
		if len(rows) > 1 {
			t.Fatalf("got %d notifications for this rule, want exactly 1", len(rows))
		}
		if time.Now().After(deadline) {
			t.Fatal("no notification row appeared within 2s after both sides completed")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// TestRegistryCreate_PublishesAppCreatedEvent confirms Registry.Create
// publishes "app.created" through a wired events.Bus — the direct,
// isolated counterpart to TestFirstAppAndFeedbackRule_EndToEnd's full
// pipeline test, same relationship TestSaveTool_PublishesToolCreatedEvent
// has to that pipeline test's tool-based predecessor.
func TestRegistryCreate_PublishesAppCreatedEvent(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	conn := sqlDB

	const ownerID = 999815
	const appID = "test-toolschema-events-app-created"
	makeTestUser(t, conn, ownerID, "toolschema-events-app-created@example.com")
	t.Cleanup(func() {
		_, _ = conn.Exec(`DELETE FROM apps WHERE app_id = $1`, appID)
	})

	reg, err := NewRegistry(database)
	if err != nil {
		t.Fatalf("NewRegistry: %v", err)
	}

	bus := events.NewBus(testLogger())
	received := make(chan events.Event, 1)
	bus.Subscribe("app.created", func(e events.Event) { received <- e })
	reg.SetEventBus(bus)

	if err := reg.Create(appID, ownerID, false); err != nil {
		t.Fatalf("Create: %v", err)
	}

	select {
	case e := <-received:
		if e.SubjectID != appID {
			t.Errorf("event SubjectID = %q, want %q", e.SubjectID, appID)
		}
		if e.ActorID != ownerID {
			t.Errorf("event ActorID = %d, want %d", e.ActorID, ownerID)
		}
		if e.Metadata["isFirst"] != true {
			t.Errorf("event Metadata[isFirst] = %v, want true (this is the owner's only app)", e.Metadata["isFirst"])
		}
	case <-time.After(2 * time.Second):
		t.Fatal("did not receive app.created event within 2s")
	}
}

// TestRegistryCreate_SecondAppPublishesIsFirstFalse confirms the isFirst
// metadata flag (used by notify's "welcome" Rule to gate the one-time
// welcome notification — see cmd/server/main.go) is false once the owner
// already has another app, not just true-by-default on every create.
func TestRegistryCreate_SecondAppPublishesIsFirstFalse(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	conn := sqlDB

	const ownerID = 999816
	const firstAppID = "test-toolschema-events-first-app"
	const secondAppID = "test-toolschema-events-second-app"
	makeTestUser(t, conn, ownerID, "toolschema-events-second-app@example.com")
	t.Cleanup(func() {
		_, _ = conn.Exec(`DELETE FROM apps WHERE app_id IN ($1, $2)`, firstAppID, secondAppID)
	})

	reg, err := NewRegistry(database)
	if err != nil {
		t.Fatalf("NewRegistry: %v", err)
	}
	if err := reg.Create(firstAppID, ownerID, false); err != nil {
		t.Fatalf("Create(firstAppID): %v", err)
	}

	bus := events.NewBus(testLogger())
	received := make(chan events.Event, 1)
	bus.Subscribe("app.created", func(e events.Event) { received <- e })
	reg.SetEventBus(bus)

	if err := reg.Create(secondAppID, ownerID, false); err != nil {
		t.Fatalf("Create(secondAppID): %v", err)
	}

	select {
	case e := <-received:
		if e.Metadata["isFirst"] != false {
			t.Errorf("event Metadata[isFirst] = %v, want false (owner already had an app)", e.Metadata["isFirst"])
		}
	case <-time.After(2 * time.Second):
		t.Fatal("did not receive app.created event within 2s")
	}
}

// TestWelcomeRule_EndToEnd proves the "welcome" single-event Rule's full
// pipeline (Registry.Create's real "app.created" publish, gated by its
// own isFirst flag, through a real notify.Engine into a real Postgres
// notifications row) — the single-event-Rule counterpart to
// TestFirstAppAndFeedbackRule_EndToEnd's PairRule pipeline test. The rule
// construction mirrors cmd/server/main.go's own welcomeRule (not
// importable from here — cmd/server isn't a library package).
func TestWelcomeRule_EndToEnd(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	conn := sqlDB

	const ownerID = 999817
	const firstAppID = "test-toolschema-welcome-first-app"
	const secondAppID = "test-toolschema-welcome-second-app"
	makeTestUser(t, conn, ownerID, "toolschema-welcome@example.com")
	t.Cleanup(func() {
		_, _ = conn.Exec(`DELETE FROM apps WHERE app_id IN ($1, $2)`, firstAppID, secondAppID)
		_, _ = conn.Exec(`DELETE FROM notifications WHERE rule_name = 'welcome' AND subject_id IN ($1, $2)`, firstAppID, secondAppID)
	})

	reg, err := NewRegistry(database)
	if err != nil {
		t.Fatalf("NewRegistry: %v", err)
	}

	bus := events.NewBus(testLogger())
	reg.SetEventBus(bus)

	rule := notify.Rule{
		Name:      "welcome",
		EventType: "app.created",
		Match: func(e events.Event) bool {
			isFirst, _ := e.Metadata["isFirst"].(bool)
			return isFirst
		},
		Build: func(e events.Event) notify.Action {
			return notify.CreateNotification{
				SubjectID:    e.SubjectID,
				Title:        "Thanks for signing up",
				ActionLabel:  "Join Builder →",
				ActionTarget: "useCaseForm",
				Body:         "Tell us what you are building.",
			}
		},
	}
	engine := notify.NewEngine([]notify.Rule{rule}, nil, notify.NewGormNotificationStore(database), notify.NewGormProgressStore(database), testLogger())
	engine.Register(bus)

	if err := reg.Create(firstAppID, ownerID, false); err != nil {
		t.Fatalf("Create(firstAppID): %v", err)
	}
	if err := reg.Create(secondAppID, ownerID, false); err != nil {
		t.Fatalf("Create(secondAppID): %v", err)
	}

	// Poll for the welcome notification on the FIRST app (fire-and-forget
	// publish on its own goroutine — see Registry.Create's own comment).
	deadline := time.Now().Add(2 * time.Second)
	for {
		var rows []struct{ Title string }
		if err := database.Table("notifications").
			Select("title").
			Where("subject_id = ? AND rule_name = ?", firstAppID, "welcome").
			Find(&rows).Error; err != nil {
			t.Fatalf("query notifications: %v", err)
		}
		if len(rows) == 1 {
			if rows[0].Title != "Thanks for signing up" {
				t.Errorf("notification Title = %q, want %q", rows[0].Title, "Thanks for signing up")
			}
			break
		}
		if len(rows) > 1 {
			t.Fatalf("got %d welcome notifications for the first app, want exactly 1", len(rows))
		}
		if time.Now().After(deadline) {
			t.Fatal("no welcome notification appeared for the first app within 2s")
		}
		time.Sleep(20 * time.Millisecond)
	}

	// The SECOND app must never get its own welcome notification —
	// isFirst gates this rule to fire at most once per owner. A fixed
	// grace period, not a poll-for-absence loop (there's no positive
	// signal to wait for), mirrors this suite's other "confirm something
	// did NOT happen" tests (e.g. TestSaveTool_UpdateDoesNotPublishToolCreatedEvent).
	time.Sleep(300 * time.Millisecond)
	var count int64
	if err := database.Table("notifications").
		Where("subject_id = ? AND rule_name = ?", secondAppID, "welcome").
		Count(&count).Error; err != nil {
		t.Fatalf("query notifications for second app: %v", err)
	}
	if count != 0 {
		t.Fatalf("welcome notifications for the second app = %d, want 0", count)
	}
}

// TestCatchUpWelcomeRule_EndToEnd proves the "catch up" pipeline for a
// user who created their app before any notify rule existed — app.created
// already fired for them, in the past, with nobody subscribed. The rule
// construction mirrors cmd/server/main.go's own catchUpWelcomeRule (not
// importable from here). Session.started's ActorID is what this rule
// keys off, not SubjectID (which the event doesn't carry — it's a
// per-user, not per-app, occurrence).
func TestCatchUpWelcomeRule_EndToEnd(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	conn := sqlDB

	const ownerID = 999818
	const appID = "test-toolschema-catchup-welcome-app"
	makeTestUser(t, conn, ownerID, "toolschema-catchup-welcome@example.com")
	t.Cleanup(func() {
		_, _ = conn.Exec(`DELETE FROM apps WHERE app_id = $1`, appID)
		_, _ = conn.Exec(`DELETE FROM notifications WHERE subject_id = $1`, appID)
	})

	reg, err := NewRegistry(database)
	if err != nil {
		t.Fatalf("NewRegistry: %v", err)
	}
	// No SetEventBus yet — this app is "created before any notify rule
	// existed," so app.created either never fires or fires into a bus
	// nobody's listening on. Either way, no notification comes from it.
	if err := reg.Create(appID, ownerID, false); err != nil {
		t.Fatalf("Create: %v", err)
	}

	bus := events.NewBus(testLogger())
	store := notify.NewGormNotificationStore(database)
	rule := notify.Rule{
		Name:      "catch_up_welcome",
		EventType: "session.started",
		Match: func(e events.Event) bool {
			appIDs, err := reg.OwnedBy(e.ActorID)
			if err != nil || len(appIDs) == 0 {
				return false
			}
			fired, err := store.HasRuleFired(appIDs, "welcome", "catch_up_welcome")
			return err == nil && !fired
		},
		Build: func(e events.Event) notify.Action {
			appIDs, _ := reg.OwnedBy(e.ActorID)
			return notify.CreateNotification{
				SubjectID:    appIDs[0],
				Title:        "Thanks for signing up",
				ActionLabel:  "Join Builder →",
				ActionTarget: "useCaseForm",
				Body:         "Tell us what you are building.",
			}
		},
	}
	engine := notify.NewEngine([]notify.Rule{rule}, nil, store, notify.NewGormProgressStore(database), testLogger())
	engine.Register(bus)

	bus.Publish(events.Event{Type: "session.started", ActorID: ownerID})

	deadline := time.Now().Add(2 * time.Second)
	for {
		var rows []struct{ Title string }
		if err := database.Table("notifications").
			Select("title").
			Where("subject_id = ? AND rule_name = ?", appID, "catch_up_welcome").
			Find(&rows).Error; err != nil {
			t.Fatalf("query notifications: %v", err)
		}
		if len(rows) == 1 {
			if rows[0].Title != "Thanks for signing up" {
				t.Errorf("notification Title = %q, want %q", rows[0].Title, "Thanks for signing up")
			}
			break
		}
		if len(rows) > 1 {
			t.Fatalf("got %d catch_up_welcome notifications, want exactly 1", len(rows))
		}
		if time.Now().After(deadline) {
			t.Fatal("no catch_up_welcome notification appeared within 2s")
		}
		time.Sleep(20 * time.Millisecond)
	}

	// A second session.started for the same user must NOT fire again —
	// HasRuleFired now sees the notification just inserted.
	bus.Publish(events.Event{Type: "session.started", ActorID: ownerID})
	time.Sleep(300 * time.Millisecond)
	var count int64
	if err := database.Table("notifications").
		Where("subject_id = ? AND rule_name = ?", appID, "catch_up_welcome").
		Count(&count).Error; err != nil {
		t.Fatalf("query notifications after second session.started: %v", err)
	}
	if count != 1 {
		t.Fatalf("catch_up_welcome notifications after a second session.started = %d, want still 1", count)
	}
}

// TestCatchUpWelcomeRule_UserWithNoAppsGetsNoNotification confirms the
// Match gate's other half: a user with zero apps must never get a
// catch-up notification just from starting a session.
func TestCatchUpWelcomeRule_UserWithNoAppsGetsNoNotification(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()

	const ownerID = 999819
	makeTestUser(t, sqlDB, ownerID, "toolschema-catchup-noapps@example.com")

	reg, err := NewRegistry(database)
	if err != nil {
		t.Fatalf("NewRegistry: %v", err)
	}

	bus := events.NewBus(testLogger())
	store := notify.NewGormNotificationStore(database)
	rule := notify.Rule{
		Name:      "catch_up_welcome",
		EventType: "session.started",
		Match: func(e events.Event) bool {
			appIDs, err := reg.OwnedBy(e.ActorID)
			if err != nil || len(appIDs) == 0 {
				return false
			}
			fired, err := store.HasRuleFired(appIDs, "welcome", "catch_up_welcome")
			return err == nil && !fired
		},
		Build: func(e events.Event) notify.Action {
			t.Fatal("Build was called for a user with no apps — Match should have vetoed this")
			return notify.CreateNotification{}
		},
	}
	engine := notify.NewEngine([]notify.Rule{rule}, nil, store, notify.NewGormProgressStore(database), testLogger())
	engine.Register(bus)

	bus.Publish(events.Event{Type: "session.started", ActorID: ownerID})
	time.Sleep(300 * time.Millisecond)
}

// TestUsecaseSubmittedRule_CompletesWelcomeNotification_EndToEnd proves
// the newest pipeline: app.created (via welcomeRule) creates a "Join
// Builder" notification, and a later usecase.submitted event (published
// once the front end's UseCaseSheet actually saves — see
// console.go's putUseCase) completes it via notify.CompleteNotifications
// — not a new notification, a status change on the one welcomeRule
// already created. Mirrors cmd/server/main.go's own welcomeRule +
// usecaseSubmittedRule construction (not importable from here).
func TestUsecaseSubmittedRule_CompletesWelcomeNotification_EndToEnd(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	conn := sqlDB

	const ownerID = 999825
	const appID = "test-toolschema-usecase-completes-welcome-app"
	makeTestUser(t, conn, ownerID, "toolschema-usecase-completes@example.com")
	t.Cleanup(func() {
		_, _ = conn.Exec(`DELETE FROM apps WHERE app_id = $1`, appID)
		_, _ = conn.Exec(`DELETE FROM notifications WHERE subject_id = $1`, appID)
	})

	reg, err := NewRegistry(database)
	if err != nil {
		t.Fatalf("NewRegistry: %v", err)
	}

	bus := events.NewBus(testLogger())
	reg.SetEventBus(bus)
	store := notify.NewGormNotificationStore(database)

	welcomeRule := notify.Rule{
		Name:      "welcome",
		EventType: "app.created",
		Match: func(e events.Event) bool {
			isFirst, _ := e.Metadata["isFirst"].(bool)
			return isFirst
		},
		Build: func(e events.Event) notify.Action {
			return notify.CreateNotification{
				SubjectID:    e.SubjectID,
				Title:        "Thanks for signing up",
				ActionLabel:  "Join Builder →",
				ActionTarget: "useCaseForm",
				Body:         "Tell us what you are building.",
			}
		},
	}
	usecaseSubmittedRule := notify.Rule{
		Name:      "usecase_submitted_completes_welcome",
		EventType: "usecase.submitted",
		Build: func(e events.Event) notify.Action {
			appIDs, _ := reg.OwnedBy(e.ActorID)
			return notify.CompleteNotifications{SubjectIDs: appIDs, Target: "useCaseForm"}
		},
	}
	engine := notify.NewEngine([]notify.Rule{welcomeRule, usecaseSubmittedRule}, nil, store, notify.NewGormProgressStore(database), testLogger())
	engine.Register(bus)

	if err := reg.Create(appID, ownerID, false); err != nil {
		t.Fatalf("Create: %v", err)
	}

	// Poll for the welcome notification to land (Registry.Create's
	// publish is fire-and-forget on its own goroutine).
	deadline := time.Now().Add(2 * time.Second)
	for {
		records, err := store.ListForSubjects([]string{appID})
		if err != nil {
			t.Fatalf("ListForSubjects: %v", err)
		}
		if len(records) == 1 {
			if records[0].Status != "pending" {
				t.Fatalf("welcome notification Status = %q before usecase.submitted, want %q", records[0].Status, "pending")
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("welcome notification never appeared within 2s")
		}
		time.Sleep(20 * time.Millisecond)
	}

	// Publish usecase.submitted directly here — this test doesn't go
	// through console.Handler.putUseCase, which has its own HTTP-layer
	// tests.
	bus.Publish(events.Event{Type: "usecase.submitted", ActorID: ownerID})

	deadline = time.Now().Add(2 * time.Second)
	for {
		records, err := store.ListForSubjects([]string{appID})
		if err != nil {
			t.Fatalf("ListForSubjects: %v", err)
		}
		if len(records) == 1 && records[0].Status == "completed" {
			if records[0].CompletedAt == nil {
				t.Error("CompletedAt is nil after usecase.submitted completed the notification")
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("welcome notification never transitioned to completed within 2s (still %+v)", records)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

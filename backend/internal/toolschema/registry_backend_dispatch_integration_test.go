//go:build integration

// Integration tests for BackendDispatch persistence through Registry against
// a live Postgres. Excluded from the default build; run with:
//
//	go test -tags integration ./internal/toolschema/ \
//	  -args -dsn "postgres://platform:platform@localhost:5434/platform?sslmode=disable"
//
// This covers the gap left by backend_dispatch_test.go (internal/inference),
// which only exercises an already-assembled tool calling its third-party
// HTTP endpoint at execution time. Nothing previously tested the path
// "YAML -> parsed App -> Registry.Save -> DB -> Registry.Get" for the new
// Tool.BackendDispatch field.
package toolschema

import (
	"flag"
	"testing"

	"github.com/tim72117/onagent/internal/db"
	"gopkg.in/yaml.v3"
)

var backendDispatchDSN = flag.String("backend-dispatch-dsn", "postgres://platform:platform@localhost:5434/platform?sslmode=disable", "Postgres DSN")

// openTestRegistry connects to Postgres and builds a Registry, skipping the
// test (not failing it) if no database is reachable in this environment.
func openTestRegistry(t *testing.T) *Registry {
	t.Helper()
	conn, err := db.Open(*backendDispatchDSN)
	if err != nil {
		t.Skipf("no reachable Postgres at %s (%v)", *backendDispatchDSN, err)
	}
	t.Cleanup(func() { if sqlDB, err := conn.DB(); err == nil { sqlDB.Close() } })

	reg, err := NewRegistry(conn)
	if err != nil {
		t.Fatalf("NewRegistry: %v", err)
	}
	return reg
}

// deleteTestApp removes appID via the registry (CASCADEs to its tools) and
// fails the test loudly if cleanup itself errors, since a leaked test app
// would corrupt later runs of these tests against the same database.
func deleteTestApp(t *testing.T, reg *Registry, appID string) {
	t.Helper()
	if err := reg.Delete(appID); err != nil {
		t.Errorf("cleanup: Delete(%q): %v", appID, err)
	}
}

// TestRegistryBackendDispatch_WriteReadBack covers scenario (a): a tool
// with BackendDispatch survives a Save/Get round trip with its fields
// intact.
func TestRegistryBackendDispatch_WriteReadBack(t *testing.T) {
	reg := openTestRegistry(t)
	sqlDB, _ := reg.db.DB()
	const ownerID = 999701
	const appID = "test-backend-dispatch-roundtrip"
	makeTestUser(t, sqlDB, ownerID, "backend-dispatch-roundtrip@example.com")
	t.Cleanup(func() { deleteTestApp(t, reg, appID) })

	if err := reg.Create(appID, ownerID); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := reg.SaveTool(appID, Tool{
		Name:        "recommend_nearby",
		Description: "Recommend nearby places",
		Parameters: ParameterSchema{
			Type: "object",
			Properties: map[string]*ParameterSchema{
				"lat": {Type: "number"},
				"lng": {Type: "number"},
			},
			Required: []string{"lat", "lng"},
		},
		BackendDispatch: &BackendDispatch{
			Endpoint:  "https://example.com/tool",
			TimeoutMS: 5000,
		},
	}); err != nil {
		t.Fatalf("SaveTool: %v", err)
	}

	got, ok := reg.Get(appID)
	if !ok {
		t.Fatalf("Get(%q): not found after Save", appID)
	}
	if len(got.Tools) != 1 {
		t.Fatalf("got %d tools, want 1", len(got.Tools))
	}

	bd := got.Tools[0].BackendDispatch
	if bd == nil {
		t.Fatalf("BackendDispatch is nil after read-back, want non-nil")
	}
	if bd.Endpoint != "https://example.com/tool" {
		t.Errorf("Endpoint = %q, want %q", bd.Endpoint, "https://example.com/tool")
	}
	if bd.TimeoutMS != 5000 {
		t.Errorf("TimeoutMS = %d, want 5000", bd.TimeoutMS)
	}
}

// TestRegistryBackendDispatch_NonDispatchToolUnaffected covers scenario (b):
// in an app with a mix of a BackendDispatch tool and a normal (Kind: action)
// tool, the normal tool must read back with BackendDispatch == nil — the new
// column must not accidentally populate for tools that never set it.
func TestRegistryBackendDispatch_NonDispatchToolUnaffected(t *testing.T) {
	reg := openTestRegistry(t)
	sqlDB, _ := reg.db.DB()
	const ownerID = 999702
	const appID = "test-backend-dispatch-mixed"
	makeTestUser(t, sqlDB, ownerID, "backend-dispatch-mixed@example.com")
	t.Cleanup(func() { deleteTestApp(t, reg, appID) })

	if err := reg.Create(appID, ownerID); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := reg.SaveTool(appID, Tool{
		Name:        "dispatch_tool",
		Description: "Uses backend dispatch",
		Parameters:  ParameterSchema{Type: "object"},
		BackendDispatch: &BackendDispatch{
			Endpoint:  "https://example.com/dispatch",
			TimeoutMS: 3000,
		},
	}); err != nil {
		t.Fatalf("SaveTool(dispatch_tool): %v", err)
	}
	if err := reg.SaveTool(appID, Tool{
		Name:        "plain_tool",
		Description: "Ordinary browser-dispatched action tool",
		Parameters:  ParameterSchema{Type: "object"},
		Kind:        ToolKindAction,
	}); err != nil {
		t.Fatalf("SaveTool(plain_tool): %v", err)
	}

	got, ok := reg.Get(appID)
	if !ok {
		t.Fatalf("Get(%q): not found after Save", appID)
	}
	if len(got.Tools) != 2 {
		t.Fatalf("got %d tools, want 2", len(got.Tools))
	}

	var dispatch, plain *Tool
	for i := range got.Tools {
		switch got.Tools[i].Name {
		case "dispatch_tool":
			dispatch = &got.Tools[i]
		case "plain_tool":
			plain = &got.Tools[i]
		}
	}
	if dispatch == nil || plain == nil {
		t.Fatalf("expected both dispatch_tool and plain_tool in read-back, got %+v", got.Tools)
	}

	if dispatch.BackendDispatch == nil {
		t.Errorf("dispatch_tool.BackendDispatch is nil, want non-nil")
	} else if dispatch.BackendDispatch.Endpoint != "https://example.com/dispatch" {
		t.Errorf("dispatch_tool.BackendDispatch.Endpoint = %q, want %q", dispatch.BackendDispatch.Endpoint, "https://example.com/dispatch")
	}

	if plain.BackendDispatch != nil {
		t.Errorf("plain_tool.BackendDispatch = %+v, want nil — non-dispatch tool must not get a BackendDispatch populated", plain.BackendDispatch)
	}
}

// TestRegistryBackendDispatch_UpdateClearsDispatchWhenOmitted covers what
// scenario (c) became once Registry.Save's replace-all semantics were
// removed in favor of SaveTool's per-tool upsert (see git history —
// SaveTool deliberately does NOT clear other tools, the opposite property
// the old replace-all test here used to pin): calling SaveTool again for
// the SAME tool name, this time without a BackendDispatch, must still
// clear that one tool's own stale backend_dispatch column via the upsert's
// DoUpdates column list — not leave the previous call's JSON behind just
// because the new Tool value's BackendDispatch field is nil.
func TestRegistryBackendDispatch_UpdateClearsDispatchWhenOmitted(t *testing.T) {
	reg := openTestRegistry(t)
	sqlDB, _ := reg.db.DB()
	const ownerID = 999703
	const appID = "test-backend-dispatch-update-clears"
	makeTestUser(t, sqlDB, ownerID, "backend-dispatch-update-clears@example.com")
	t.Cleanup(func() { deleteTestApp(t, reg, appID) })

	if err := reg.Create(appID, ownerID); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := reg.SaveTool(appID, Tool{
		Name:        "recommend_nearby",
		Description: "Recommend nearby places",
		Parameters:  ParameterSchema{Type: "object"},
		BackendDispatch: &BackendDispatch{
			Endpoint:  "https://example.com/stale",
			TimeoutMS: 9999,
		},
	}); err != nil {
		t.Fatalf("first SaveTool (with dispatch): %v", err)
	}

	// Sanity: confirm it actually landed before testing that it goes away.
	if got, ok := reg.Get(appID); !ok || got.Tools[0].BackendDispatch == nil {
		t.Fatalf("setup failed: BackendDispatch not present after first SaveTool")
	}

	if err := reg.SaveTool(appID, Tool{
		Name:        "recommend_nearby",
		Description: "No backend dispatch this time",
		Parameters:  ParameterSchema{Type: "object"},
		Kind:        ToolKindAction,
	}); err != nil {
		t.Fatalf("second SaveTool (without dispatch): %v", err)
	}

	got, ok := reg.Get(appID)
	if !ok {
		t.Fatalf("Get(%q): not found after second SaveTool", appID)
	}
	if len(got.Tools) != 1 {
		t.Fatalf("got %d tools after update, want 1 (same name, updated in place — not a second row)", len(got.Tools))
	}
	if got.Tools[0].BackendDispatch != nil {
		t.Errorf("BackendDispatch = %+v after an update omitting it, want nil — stale backend_dispatch data was left behind", got.Tools[0].BackendDispatch)
	}

	// Belt-and-suspenders: also check the DB directly, in case a future
	// Registry-level bug were to mask a lingering value (e.g. via caching)
	// that Get's in-memory view wouldn't reveal.
	var bdJSON []byte
	if err := reg.db.Table("tools").Select("backend_dispatch").Where("app_id = ? AND name = ?", appID, "recommend_nearby").Take(&bdJSON).Error; err != nil {
		t.Fatalf("direct DB query after update: %v", err)
	}
	if bdJSON != nil {
		t.Errorf("DB row backend_dispatch = %s, want NULL — update left stale BackendDispatch JSON in the tools table", bdJSON)
	}
}

// TestBackendDispatchYAMLParsing covers scenario (d): the exact parsing step
// runSaveTools (backend/cmd/onagent/main.go) performs — yaml.Unmarshal(data,
// &app) — against a tools.yaml snippet matching the syntax documented in
// docs/backend-dispatch-integration-guide-2026-08-10.md. This doesn't touch
// the database or exec the CLI binary; it only pins that the YAML tags on
// Tool/BackendDispatch actually parse a realistic file the way the docs
// promise.
func TestBackendDispatchYAMLParsing(t *testing.T) {
	const tools = `
appId: your-app-id
tools:
  - name: recommend_nearby
    description: Recommend nearby places based on the user's current location
    parameters:
      type: object
      properties:
        lat:
          type: number
        lng:
          type: number
      required: [lat, lng]
    backendDispatch:
      endpoint: https://your-backend.example.com/onagent/recommend_nearby
      timeoutMs: 8000
`

	var app App
	if err := yaml.Unmarshal([]byte(tools), &app); err != nil {
		t.Fatalf("yaml.Unmarshal: %v", err)
	}

	if app.AppID != "your-app-id" {
		t.Errorf("AppID = %q, want %q", app.AppID, "your-app-id")
	}
	if len(app.Tools) != 1 {
		t.Fatalf("got %d tools, want 1", len(app.Tools))
	}

	tool := app.Tools[0]
	if tool.Name != "recommend_nearby" {
		t.Errorf("tool name = %q, want %q", tool.Name, "recommend_nearby")
	}
	if tool.BackendDispatch == nil {
		t.Fatalf("BackendDispatch is nil after parsing YAML with a backendDispatch: block")
	}
	const wantEndpoint = "https://your-backend.example.com/onagent/recommend_nearby"
	if tool.BackendDispatch.Endpoint != wantEndpoint {
		t.Errorf("Endpoint = %q, want %q", tool.BackendDispatch.Endpoint, wantEndpoint)
	}
	if tool.BackendDispatch.TimeoutMS != 8000 {
		t.Errorf("TimeoutMS = %d, want 8000", tool.BackendDispatch.TimeoutMS)
	}

	if err := app.Validate(); err != nil {
		t.Errorf("Validate() on a doc-accurate backendDispatch tool: %v, want nil", err)
	}
}

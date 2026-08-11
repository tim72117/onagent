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
	const appID = "test-backend-dispatch-roundtrip"
	t.Cleanup(func() { deleteTestApp(t, reg, appID) })

	app := &App{
		AppID: appID,
		Tools: []Tool{
			{
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
			},
		},
	}

	if err := reg.Save(app); err != nil {
		t.Fatalf("Save: %v", err)
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
	const appID = "test-backend-dispatch-mixed"
	t.Cleanup(func() { deleteTestApp(t, reg, appID) })

	app := &App{
		AppID: appID,
		Tools: []Tool{
			{
				Name:        "dispatch_tool",
				Description: "Uses backend dispatch",
				Parameters:  ParameterSchema{Type: "object"},
				BackendDispatch: &BackendDispatch{
					Endpoint:  "https://example.com/dispatch",
					TimeoutMS: 3000,
				},
			},
			{
				Name:        "plain_tool",
				Description: "Ordinary browser-dispatched action tool",
				Parameters:  ParameterSchema{Type: "object"},
				Kind:        ToolKindAction,
			},
		},
	}

	if err := reg.Save(app); err != nil {
		t.Fatalf("Save: %v", err)
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

// TestRegistryBackendDispatch_ReplaceAllClearsStaleData covers scenario (c):
// saveApp's replace-all semantics (delete all of the app's tools, then
// re-insert the new list) must also apply to BackendDispatch — a
// second Save with no BackendDispatch tools must leave no trace of the
// first save's BackendDispatch data behind.
func TestRegistryBackendDispatch_ReplaceAllClearsStaleData(t *testing.T) {
	reg := openTestRegistry(t)
	const appID = "test-backend-dispatch-replace-all"
	t.Cleanup(func() { deleteTestApp(t, reg, appID) })

	withDispatch := &App{
		AppID: appID,
		Tools: []Tool{
			{
				Name:        "recommend_nearby",
				Description: "Recommend nearby places",
				Parameters:  ParameterSchema{Type: "object"},
				BackendDispatch: &BackendDispatch{
					Endpoint:  "https://example.com/stale",
					TimeoutMS: 9999,
				},
			},
		},
	}
	if err := reg.Save(withDispatch); err != nil {
		t.Fatalf("first Save (with dispatch): %v", err)
	}

	// Sanity: confirm it actually landed before testing that it goes away.
	if got, ok := reg.Get(appID); !ok || got.Tools[0].BackendDispatch == nil {
		t.Fatalf("setup failed: BackendDispatch not present after first Save")
	}

	withoutDispatch := &App{
		AppID: appID,
		Tools: []Tool{
			{
				Name:        "plain_tool",
				Description: "No backend dispatch this time",
				Parameters:  ParameterSchema{Type: "object"},
				Kind:        ToolKindAction,
			},
		},
	}
	if err := reg.Save(withoutDispatch); err != nil {
		t.Fatalf("second Save (without dispatch): %v", err)
	}

	got, ok := reg.Get(appID)
	if !ok {
		t.Fatalf("Get(%q): not found after second Save", appID)
	}
	if len(got.Tools) != 1 {
		t.Fatalf("got %d tools after replace, want 1 (stale tool row should be gone, not just its BackendDispatch)", len(got.Tools))
	}
	if got.Tools[0].Name != "plain_tool" {
		t.Fatalf("got tool %q, want %q — old tool row was not replaced", got.Tools[0].Name, "plain_tool")
	}
	if got.Tools[0].BackendDispatch != nil {
		t.Errorf("BackendDispatch = %+v after replace-all with no dispatch tools, want nil — stale backend_dispatch data was left behind", got.Tools[0].BackendDispatch)
	}

	// Belt-and-suspenders: also check the DB directly, in case a future
	// Registry-level bug were to mask a lingering row (e.g. via caching)
	// that Get's in-memory view wouldn't reveal.
	var row struct {
		Name            string
		BackendDispatch []byte
	}
	if err := reg.db.Table("tools").Select("name, backend_dispatch").Where("app_id = ?", appID).Take(&row).Error; err != nil {
		t.Fatalf("direct DB query after replace: %v", err)
	}
	name, bdJSON := row.Name, row.BackendDispatch
	if name != "plain_tool" {
		t.Errorf("DB row name = %q, want %q", name, "plain_tool")
	}
	if bdJSON != nil {
		t.Errorf("DB row backend_dispatch = %s, want NULL — replace-all left stale BackendDispatch JSON in the tools table", bdJSON)
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

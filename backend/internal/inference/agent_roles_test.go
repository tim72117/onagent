package inference

import (
	"testing"

	"github.com/tim72117/onagent/internal/toolschema"
)

// TestToolProvider_SchemaEditTakesEffectWithoutRestart is the acceptance
// check for upgrading want to v0.1.0. It replaces an earlier version of
// this test (see git history) that reproduced a real bug against want
// v0.0.2: types.GlobalRegistry.Declarations was append-only, so
// re-registering a tool whose schema changed silently kept serving the
// FIRST version ever registered in the process's lifetime — the LLM never
// saw an edit until the backend restarted. That test asserted the CORRECT
// behavior and failed against v0.0.2, proving the bug was real, not
// theoretical.
//
// want v0.1.0 removed types.GlobalRegistry entirely: there is no longer any
// standing copy of tool declarations for want to keep in sync. Declarations
// now come from appToolProvider (agent_roles.go), which reads
// toolschema.Registry live on every single call — so this test doesn't even
// call RegisterAppRole a second time. That absence is the point: a schema
// edit needs no re-registration step at all now, because there is nothing
// left to go stale.
func TestToolProvider_SchemaEditTakesEffectWithoutRestart(t *testing.T) {
	const toolName = "agent_roles_test_schema_reload_tool"
	const appID = "agent-roles-test-app"

	apps := &fakeAppLookup{apps: map[string]*toolschema.App{
		appID: {
			AppID: appID,
			Tools: []toolschema.Tool{{
				Name:        toolName,
				Description: "v1: original description",
				Parameters:  toolschema.ParameterSchema{Type: "object"},
			}},
		},
	}}

	provider := toolProviderFor(appID, apps)

	decls := provider.Declarations()
	if len(decls) != 1 || decls[0].Description != "v1: original description" {
		t.Fatalf("sanity check failed: got %+v, want one declaration with description %q", decls, "v1: original description")
	}

	// Simulate a developer editing this tool's schema in the console and
	// saving (console.go's Registry.Save does the DB write, then Reload
	// swaps it into what Get() serves — apps.apps here stands in for that
	// live, reloaded state). Deliberately NOT calling RegisterAppRole
	// again — the whole point of this test is that nothing needs to be
	// re-registered for a schema edit (as opposed to a whitelist/Thought
	// change, which still does — see RegisterAppRole's doc comment) to
	// take effect.
	apps.apps[appID] = &toolschema.App{
		AppID: appID,
		Tools: []toolschema.Tool{{
			Name:        toolName,
			Description: "v2: edited description",
			Parameters:  toolschema.ParameterSchema{Type: "object"},
		}},
	}

	decls = provider.Declarations()
	if len(decls) != 1 || decls[0].Description != "v2: edited description" {
		t.Errorf("tool schema edit did not take effect: Declarations() returned %+v, want description %q — "+
			"appToolProvider should read toolschema.Registry live, not a snapshot", decls, "v2: edited description")
	}

	// GetFactory must resolve the SAME live data, not some other cached
	// copy — this is what DispatchToolCall actually calls at invocation
	// time (want internal/agent_tool.go).
	factory, ok := provider.GetFactory(toolName)
	if !ok {
		t.Fatalf("GetFactory(%q) = false, want true after the tool was registered", toolName)
	}
	if factory == nil {
		t.Fatalf("GetFactory(%q) returned a nil factory", toolName)
	}
	if tool := factory(); tool == nil {
		t.Errorf("factory() returned nil, want a types.ToolInterface instance")
	}

	if _, ok := provider.GetFactory("no_such_tool"); ok {
		t.Errorf("GetFactory(\"no_such_tool\") = true, want false for an unregistered name")
	}
}

// fakeAppLookup is a trivial in-memory stand-in for *toolschema.Registry,
// satisfying the appLookup interface appToolProvider actually depends on
// (agent_roles.go) — lets this package's tests exercise appToolProvider
// without a real database.
type fakeAppLookup struct {
	apps map[string]*toolschema.App
}

func (f *fakeAppLookup) Get(id string) (*toolschema.App, bool) {
	app, ok := f.apps[id]
	return app, ok
}

//go:build integration

package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/tim72117/onagent/internal/auth"
	"github.com/tim72117/onagent/internal/inference"
	"github.com/tim72117/onagent/internal/quota"
	"github.com/tim72117/onagent/internal/toolschema"
)

// Shared by the WebSocket and SSE full-flow tests (ws_flow_integration_test.go,
// sse_integration_test.go), so both transports are checked against one
// identical scenario: hello → ack → prompt → tool_query → tool_result →
// assistant_message, authorized by the real APIKeyResolver.

// askingInference is a fake inference.Service whose every turn asks the
// page one question through the session's real AskInteraction, then answers
// with whatever the page said. That exercises the property both transports
// must get right: a tool_result arriving while a prompt is still blocked
// inside Complete must reach that prompt (on WS through the read loop staying
// free, on SSE through a separate POST).
//
// It finds the session the same way production code does — the asker the
// transport registered under req.SessionID — so it also proves the
// transport registered one at all.
type askingInference struct{}

func (askingInference) CloseSession(string) {}

func (askingInference) Complete(_ context.Context, req inference.Request) (*inference.Result, error) {
	asker, ok := inference.LookupAskerForTest(req.SessionID)
	if !ok {
		return nil, fmt.Errorf("no asker registered for session %q", req.SessionID)
	}
	answer, err := asker.AskInteraction("get_title", json.RawMessage(`{}`), toolschema.ToolKindQuery)
	if err != nil {
		return nil, err
	}
	return &inference.Result{AssistantMessage: "title is " + string(answer)}, nil
}

// flowFixture is a real, enabled app with one query tool, an issued key,
// and testOrigin allowed.
type flowFixture struct {
	appID    string
	key      string
	apps     *toolschema.Registry
	resolver *APIKeyResolver
}

func newFlowFixture(t *testing.T, ownerID int64, appID string) flowFixture {
	t.Helper()
	database := openTestDB(t)
	sqlDB, _ := database.DB()

	makeTestUser(t, sqlDB, ownerID, appID+"@example.com")
	reg := makeTestApp(t, database, appID, ownerID)
	if _, err := reg.SaveTool(appID, toolschema.Tool{
		Name:        "get_title",
		Description: "Returns the page title.",
		Kind:        toolschema.ToolKindQuery,
		Parameters:  toolschema.ParameterSchema{Type: "object"},
	}); err != nil {
		t.Fatalf("SaveTool: %v", err)
	}

	authStore := auth.New(database)
	key, err := authStore.Issue(appID)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if err := authStore.SetOrigins(appID, []string{testOrigin}); err != nil {
		t.Fatalf("SetOrigins: %v", err)
	}

	apps := mustRegistry(t, database)
	return flowFixture{
		appID:    appID,
		key:      key,
		apps:     apps,
		resolver: &APIKeyResolver{Auth: authStore, Apps: apps, Quota: quota.New(database), Log: testLogger()},
	}
}

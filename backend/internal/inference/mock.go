package inference

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/tim72117/agent/internal/toolschema"
)

// MockService is a placeholder Service used until the real inference
// backend is wired in. It does no actual reasoning: if the prompt
// mentions a known tool name it echoes a plausible tool call, otherwise it
// just replies with the prompt text. This is enough to exercise the full
// WebSocket -> tool_call -> tool_result loop end-to-end.
type MockService struct{}

func NewMock() *MockService { return &MockService{} }

func (m *MockService) Complete(_ context.Context, req Request) (*Result, error) {
	for _, tool := range req.Tools {
		if containsWord(req.Prompt, tool.Name) {
			return &Result{
				ToolCalls: []ToolCall{{
					ToolName: tool.Name,
					// Real inference would fill these from the model's
					// output, grounded in the front-end context; the mock
					// synthesizes plausible values from the tool's own
					// parameter schema, preferring real values found in
					// req.Context over synthetic placeholders.
					Args: mockArgsFor(tool.InputSchema, req.Context),
				}},
				AssistantMessage: fmt.Sprintf("(mock) calling tool %q with placeholder args", tool.Name),
			}, nil
		}
	}
	return &Result{
		AssistantMessage: fmt.Sprintf("(mock inference, no real LLM wired up yet) you said: %s", req.Prompt),
	}, nil
}

// mockArgsFor builds a JSON object filling each declared property with a
// plausible value, so the demo visibly reflects the tool call instead of
// receiving undefined/generic placeholders for every argument.
//
// For array-of-string properties, it looks in reqContext for the first
// object with a "name" field (e.g. front-end context shaped like
// {"availableQuestions": [{"name": "p2q1", ...}, ...]}) and uses that real
// value instead of a synthetic one — this is how a real LLM would ground
// tool args in the page's actual state, without requiring a real model to
// demo that the wiring works.
func mockArgsFor(schema toolschema.ParameterSchema, reqContext json.RawMessage) json.RawMessage {
	firstName, hasName := firstNameFromContext(reqContext)

	out := map[string]interface{}{}
	for name, prop := range schema.Properties {
		if prop == nil {
			continue
		}
		switch {
		case name == "clear":
			// A "clear"-style flag conventionally means "undo/reset instead
			// of act" — default it to false so the mock demonstrates the
			// act-on-real-data path rather than always resetting.
			out[name] = false
		case prop.Type == "string":
			out[name] = "mock " + name
		case prop.Type == "number" || prop.Type == "integer":
			out[name] = 1000
		case prop.Type == "boolean":
			out[name] = true
		case prop.Type == "array" && hasName:
			out[name] = []interface{}{firstName}
		case prop.Type == "array":
			out[name] = []interface{}{"mock " + name}
		default:
			out[name] = "mock " + name
		}
	}
	b, _ := json.Marshal(out)
	return b
}

// firstNameFromContext looks for the first array field in reqContext whose
// elements are objects with a "name" string field, and returns that name.
func firstNameFromContext(reqContext json.RawMessage) (string, bool) {
	if len(reqContext) == 0 {
		return "", false
	}
	var parsed map[string]json.RawMessage
	if err := json.Unmarshal(reqContext, &parsed); err != nil {
		return "", false
	}
	for _, raw := range parsed {
		var items []map[string]interface{}
		if err := json.Unmarshal(raw, &items); err != nil || len(items) == 0 {
			continue
		}
		if name, ok := items[0]["name"].(string); ok && name != "" {
			return name, true
		}
	}
	return "", false
}

func containsWord(haystack, needle string) bool {
	return strings.Contains(haystack, needle)
}
